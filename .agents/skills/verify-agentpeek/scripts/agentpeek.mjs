#!/usr/bin/env node
// Verification helper for AgentPeek. Read ../SKILL.md before using it.
//
// It launches the built app as an isolated instance (its own Chromium profile and an empty or
// synthetic home folder), drives the window over the Chrome DevTools Protocol (CDP), inspects the
// main process over the Node.js inspector, saves evidence, and tears down only what it started.
// Plain Node.js 22+ (for the global WebSocket); no dependencies.

/* global console, process, Buffer, fetch, WebSocket, setTimeout, clearTimeout */

import { spawn, spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createRequire } from 'node:module'
import { fileURLToPath, pathToFileURL } from 'node:url'

const ROOT = findRepoRoot()
const RUNS_DIR = path.join(ROOT, 'test-results', 'verify-agentpeek')
const CURRENT_FILE = path.join(RUNS_DIR, 'current')
// The real path (on macOS /var is a symlink to /private/var), so it matches what the app reports.
const SCRATCH_BASE = path.join(fs.realpathSync(os.tmpdir()), 'agentpeek-verify')
const DEFAULT_USER_DATA = path.join(os.homedir(), 'Library', 'Application Support', 'AgentPeek')
const RENDERER_URL = pathToFileURL(path.join(ROOT, 'out', 'renderer', 'index.html')).href

const USAGE = `Usage: node .agents/skills/verify-agentpeek/scripts/agentpeek.mjs <command> [options]

  launch [--label <name>] [--fixture <dir>] [--no-build]
                              Build, start an isolated instance, wait until it is usable.
  doctor [--run <id>]         Read-only health check of a run's instance. Exit 1 on any FAIL.
  eval <js> [--run <id>]      Evaluate an expression in the window's page; print the JSON value.
  main-eval <js> [--run <id>] Evaluate in the main process; \`require\`, \`electron\`, \`app\`,
                              \`BrowserWindow\`, and \`Menu\` are in scope. For observing state.
  click (--role <r> --name <n> | --selector <css>) [--nth <i>] [--run <id>]
                              Real mouse click at the element's center.
  key <combo> [--run <id>]    Key press sent to the page, e.g. Escape, ArrowDown, Meta+A.
                              It never reaches the native menu; use menu-click for menu shortcuts.
  type <text> [--run <id>]    Insert text at the focused element.
  aria [<name>] [--run <id>]  Print the accessibility tree; with <name>, also save <name>.aria.txt.
  menu [<name>] [--run <id>]  Print the application menu; with <name>, also save <name>.menu.txt.
  menu-click "<Menu> > <Item>" [--run <id>]
                              Choose a menu item the way the menu bar does. Refuses disabled or
                              hidden items, and needs the window focused (see focus).
  focus [--run <id>]          Bring the window to the front. Takes focus from the user's app.
  screenshot <name> [--run <id>]
                              Save the page as <name>.png in the run's evidence folder.
  relaunch [--run <id>]       Start a second copy against the same profile; report how it exits.
  wait-exit [--timeout <ms>] [--run <id>]
                              Wait for the instance to exit by itself; report the time it took.
  stop [--run <id> | --all]   Stop the instance(s) this helper started and delete their scratch
                              folders. Evidence stays in test-results/verify-agentpeek/<run>/.

<id> defaults to the most recent launch (test-results/verify-agentpeek/current).`

// ---------------------------------------------------------------------------------------------
// launch

async function launch() {
  const electronPath = resolveElectron()
  if (!flags['no-build']) {
    console.error('Building with `npm run build` (typecheck + electron-vite build)...')
    const build = spawnSync('npm', ['run', 'build'], { cwd: ROOT, stdio: ['ignore', 2, 2] })
    if (build.status !== 0) fail('`npm run build` failed; fix the build before verifying.')
  }
  for (const file of BUILD_FILES) {
    if (!fs.existsSync(path.join(ROOT, file))) fail(`${file} is missing; run without --no-build.`)
  }

  const label = flags.label ? `-${String(flags.label).replace(/[^A-Za-z0-9_-]+/g, '-')}` : ''
  const runId = `${timestamp()}${label}`
  const evidenceDir = path.join(RUNS_DIR, runId)
  const scratchDir = path.join(SCRATCH_BASE, runId)
  const userDataDir = path.join(scratchDir, 'user-data')
  const homeDir = path.join(scratchDir, 'home')
  fs.mkdirSync(evidenceDir, { recursive: true })
  fs.mkdirSync(userDataDir, { recursive: true })
  fs.mkdirSync(homeDir, { recursive: true })
  if (flags.fixture) {
    const fixture = path.resolve(String(flags.fixture))
    if (!fs.statSync(fixture).isDirectory()) fail(`--fixture ${fixture} is not a folder.`)
    // A copy, so a simulator can append to it without touching the original.
    fs.cpSync(fixture, homeDir, { recursive: true })
  }

  const env = { ...process.env }
  // Either variable would change what runs: the first turns Electron into plain Node.js, the
  // second makes the window load a dev server instead of the built files.
  delete env.ELECTRON_RUN_AS_NODE
  delete env.ELECTRON_RENDERER_URL
  // Fixture-mode overrides. AgentPeek must read tool files from this synthetic home and keep its
  // state here, never in the user's real folders.
  env.AGENTPEEK_HOME = homeDir
  env.AGENTPEEK_USER_DATA = userDataDir

  const logPath = path.join(evidenceDir, 'app.log')
  const logFd = fs.openSync(logPath, 'a')
  const args = [
    `--user-data-dir=${userDataDir}`,
    // Port 0: Chromium and Node pick free ports and print them, so runs never collide.
    '--remote-debugging-port=0',
    '--inspect=0',
    ROOT
  ]
  const child = spawn(electronPath, args, {
    cwd: ROOT,
    env,
    detached: true,
    stdio: ['ignore', logFd, logFd]
  })
  child.unref()
  fs.closeSync(logFd)

  const run = {
    runId,
    status: 'starting',
    pid: child.pid,
    electronPath,
    args,
    evidenceDir,
    scratchDir,
    userDataDir,
    homeDir,
    fixture: flags.fixture ? path.resolve(String(flags.fixture)) : null,
    buildMtimes: buildMtimes(),
    startedAt: new Date().toISOString(),
    git: gitInfo(),
    defaultUserDataNewestMtime: newestMtime(DEFAULT_USER_DATA)
  }
  writeRun(run)
  fs.writeFileSync(CURRENT_FILE, `${runId}\n`)

  try {
    const ports = await waitFor('debug ports in app.log', 30_000, () => {
      if (!isAlive(run.pid)) throw new Error(`Electron exited during startup; see ${logPath}`)
      const log = fs.readFileSync(logPath, 'utf8')
      const cdp = /DevTools listening on ws:\/\/127\.0\.0\.1:(\d+)\//.exec(log)
      const inspector = /Debugger listening on ws:\/\/127\.0\.0\.1:(\d+)\//.exec(log)
      return cdp && inspector ? { cdp: Number(cdp[1]), inspector: Number(inspector[1]) } : null
    })
    run.cdpPort = ports.cdp
    run.inspectorPort = ports.inspector
    writeRun(run)

    // Usable means: the built page is loaded, React has rendered, and the window is on screen.
    await waitFor('a rendered, visible window', 30_000, async () => {
      if (!isAlive(run.pid)) throw new Error(`Electron exited during startup; see ${logPath}`)
      const page = await findPageTarget(run).catch(() => null)
      if (!page) return null
      const rendered = await withPage(run, (s) =>
        evaluate(
          s,
          `document.readyState === 'complete' && document.getElementById('root')?.childElementCount > 0`
        )
      )
      const visible = await withMain(run, (s) =>
        evaluate(s, mainExpression('BrowserWindow.getAllWindows().some((w) => w.isVisible())'))
      )
      return rendered && visible ? true : null
    })
  } catch (error) {
    console.error(`Launch failed: ${error.message}. Tearing down this run.`)
    await stopRun(run)
    process.exit(1)
  }

  run.status = 'ready'
  run.readyAt = new Date().toISOString()
  writeRun(run)
  logAction(run, 'launch', { label: flags.label ?? null, fixture: run.fixture }, 'ready')
  console.log(
    JSON.stringify(
      {
        runId,
        pid: run.pid,
        cdpPort: run.cdpPort,
        inspectorPort: run.inspectorPort,
        evidenceDir: path.relative(ROOT, evidenceDir),
        scratchDir
      },
      null,
      2
    )
  )
}

// ---------------------------------------------------------------------------------------------
// doctor

async function doctor() {
  const run = loadRun()
  const results = []
  const check = (name, ok, detail) => results.push({ name, ok, detail })

  check('run record', true, `${run.runId} (status ${run.status})`)
  const alive = isAlive(run.pid)
  check('process alive', alive, `pid ${run.pid}`)

  if (alive) {
    const cmd = processCommand(run.pid)
    check(
      'process is this run',
      cmd.startsWith(run.electronPath) && cmd.includes(`--user-data-dir=${run.userDataDir}`),
      cmd.startsWith(run.electronPath) ? 'own Electron binary and profile' : `command is: ${cmd}`
    )
    for (const [name, port] of [
      ['CDP port', run.cdpPort],
      ['inspector port', run.inspectorPort]
    ]) {
      const owner = portOwner(port)
      check(`${name} owned by us`, owner === run.pid, `${port} -> pid ${owner ?? 'none'}`)
    }

    const page = await findPageTarget(run).catch((error) => ({ error }))
    check(
      'window loads the built files',
      !page.error && page.url === RENDERER_URL,
      page.error ? page.error.message : page.url
    )

    const main = await withMain(run, (s) =>
      evaluate(
        s,
        mainExpression(`({
          version: app.getVersion(),
          isPackaged: app.isPackaged,
          userData: app.getPath('userData'),
          agentpeekHome: process.env.AGENTPEEK_HOME ?? null,
          rendererUrl: process.env.ELECTRON_RENDERER_URL ?? null,
          windows: BrowserWindow.getAllWindows().map((w) => ({ visible: w.isVisible(), title: w.getTitle() }))
        })`)
      )
    ).catch((error) => ({ error }))
    if (main.error) {
      check('main process reachable', false, main.error.message)
    } else {
      const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'))
      check('version matches package.json', main.version === pkg.version, main.version)
      check('profile is isolated', main.userData === run.userDataDir, main.userData)
      check('synthetic home passed in', main.agentpeekHome === run.homeDir, main.agentpeekHome)
      check('no dev-server override', main.rendererUrl === null, String(main.rendererUrl))
      check(
        'one visible window',
        main.windows.length === 1 && main.windows[0].visible,
        JSON.stringify(main.windows)
      )
    }

    const pageState = await withPage(run, async (s) => {
      const state = await evaluate(
        s,
        `(async () => {
          const snapshot = await window.agentpeek.getSnapshot();
          return { title: document.title, bridge: typeof window.agentpeek, node: typeof require,
            fixture: snapshot.fixture, fixtureHome: snapshot.fixtureHome,
            banner: document.querySelector('.fixture-banner')?.textContent ?? null };
        })()`
      )
      state.problems = await collectConsoleProblems(s)
      return state
    }).catch((error) => ({ error }))
    if (pageState.error) {
      check('page reachable', false, pageState.error.message)
    } else {
      check('page title', pageState.title === 'AgentPeek', pageState.title)
      check(
        'bridge only, no Node.js',
        pageState.bridge === 'object' && pageState.node === 'undefined',
        `window.agentpeek: ${pageState.bridge}, require: ${pageState.node}`
      )
      check(
        'fixture mode confirmed by the app',
        pageState.fixture === true &&
          pageState.fixtureHome === run.homeDir &&
          pageState.banner?.includes(run.homeDir) === true,
        pageState.fixtureHome ?? 'no synthetic home in the snapshot'
      )
      check(
        'no console errors',
        pageState.problems.length === 0,
        pageState.problems.length === 0 ? 'none' : pageState.problems.slice(0, 3).join(' | ')
      )
    }
  }

  const stale = staleSources(run)
  check(
    'build is current',
    stale.length === 0,
    stale.length === 0 ? 'no source change since the launch build' : `changed: ${stale.join(', ')}`
  )

  for (const { name, ok, detail } of results) {
    console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}: ${detail}`)
  }
  const failures = results.filter((r) => !r.ok).length
  console.log(failures === 0 ? 'doctor: OK' : `doctor: ${failures} problem(s)`)
  if (alive) logAction(run, 'doctor', {}, failures === 0 ? 'OK' : `${failures} problem(s)`)
  process.exit(failures === 0 ? 0 : 1)
}

// ---------------------------------------------------------------------------------------------
// Driving and observing

async function evalPage() {
  const expression = requirePositional('a JavaScript expression')
  const run = loadLiveRun()
  const value = await withPage(run, (s) => evaluate(s, expression))
  printAndLog(run, 'eval', { expression }, value)
}

async function evalMain() {
  const expression = requirePositional('a JavaScript expression')
  const run = loadLiveRun()
  const value = await withMain(run, (s) => evaluate(s, mainExpression(expression)))
  printAndLog(run, 'main-eval', { expression }, value)
}

async function click() {
  const run = loadLiveRun()
  const nth = Number(flags.nth ?? 0)
  const result = await withPage(run, async (s) => {
    let backendNodeId
    if (flags.selector) {
      const { root } = await s.send('DOM.getDocument', { depth: 0 })
      const { nodeIds } = await s.send('DOM.querySelectorAll', {
        nodeId: root.nodeId,
        selector: String(flags.selector)
      })
      if (nodeIds.length <= nth) throw new Error(`no element #${nth} for ${flags.selector}`)
      ;({
        node: { backendNodeId }
      } = await s.send('DOM.describeNode', { nodeId: nodeIds[nth] }))
    } else if (flags.role && flags.name !== undefined) {
      // The same tree `aria` prints, matched on its role and accessible name.
      await s.send('Accessibility.enable')
      const { nodes } = await s.send('Accessibility.getFullAXTree')
      const matches = nodes.filter(
        (n) =>
          !n.ignored &&
          n.backendDOMNodeId &&
          n.role?.value === String(flags.role) &&
          (n.name?.value ?? '') === String(flags.name)
      )
      if (matches.length === 0) {
        throw new Error(`no element with role "${flags.role}" and name "${flags.name}"`)
      }
      if (matches.length > 1 && flags.nth === undefined) {
        throw new Error(`${matches.length} elements match; pick one with --nth <index>`)
      }
      if (matches.length <= nth) throw new Error(`only ${matches.length} element(s) match`)
      backendNodeId = matches[nth].backendDOMNodeId
    } else {
      throw new Error('click needs --role and --name, or --selector')
    }
    await s.send('DOM.scrollIntoViewIfNeeded', { backendNodeId })
    const { model } = await s.send('DOM.getBoxModel', { backendNodeId })
    const [x1, y1, , , x3, y3] = model.border
    const x = (x1 + x3) / 2
    const y = (y1 + y3) / 2
    const base = { x, y, button: 'left', clickCount: 1 }
    // No mouseMoved first: when the window is in the background, Chromium holds a move event for
    // about 5 seconds. Press and release alone produce mousedown, mouseup, and click.
    await s.send('Input.dispatchMouseEvent', { ...base, type: 'mousePressed', buttons: 1 })
    await s.send('Input.dispatchMouseEvent', { ...base, type: 'mouseReleased', buttons: 0 })
    return { clickedAt: { x: Math.round(x), y: Math.round(y) } }
  })
  printAndLog(
    run,
    'click',
    { role: flags.role, name: flags.name, selector: flags.selector, nth },
    result
  )
}

// On macOS the Edit menu turns these shortcuts into editing commands. Key events sent over CDP
// never reach the native menu, so the helper attaches the same command to the key event.
const EDIT_COMMANDS = {
  'Meta+A': 'selectAll',
  'Meta+C': 'copy',
  'Meta+X': 'cut',
  'Meta+V': 'paste',
  'Meta+Z': 'undo',
  'Meta+Shift+Z': 'redo'
}

async function key() {
  const combo = requirePositional('a key combination such as Meta+W')
  const run = loadLiveRun()
  const { key: keyName, code, keyCode, text, modifiers } = parseCombo(combo)
  const editCommand = EDIT_COMMANDS[combo]
  await withPage(run, async (s) => {
    const base = { key: keyName, code, windowsVirtualKeyCode: keyCode, modifiers }
    await s.send('Input.dispatchKeyEvent', {
      ...base,
      type: text ? 'keyDown' : 'rawKeyDown',
      ...(text ? { text, unmodifiedText: text } : {}),
      ...(editCommand ? { commands: [editCommand] } : {})
    })
    await s.send('Input.dispatchKeyEvent', { ...base, type: 'keyUp' })
  })
  printAndLog(run, 'key', { combo }, editCommand ? `sent (edit command ${editCommand})` : 'sent')
}

async function typeText() {
  const text = requirePositional('the text to type')
  const run = loadLiveRun()
  await withPage(run, (s) => s.send('Input.insertText', { text }))
  printAndLog(run, 'type', { length: text.length }, 'inserted')
}

async function aria() {
  const run = loadLiveRun()
  const tree = await withPage(run, async (s) => {
    await s.send('Accessibility.enable')
    const { nodes } = await s.send('Accessibility.getFullAXTree')
    return formatAxTree(nodes)
  })
  console.log(tree)
  const name = positional[0]
  if (name) {
    const file = path.join(run.evidenceDir, `${safeName(name)}.aria.txt`)
    fs.writeFileSync(file, `${tree}\n`)
    logAction(run, 'aria', { name }, path.relative(ROOT, file))
    console.error(`Saved ${path.relative(ROOT, file)}`)
  }
}

async function screenshot() {
  const name = requirePositional('a name for the screenshot')
  const run = loadLiveRun()
  const data = await withPage(run, async (s) => {
    const { data } = await s.send('Page.captureScreenshot', { format: 'png' })
    return data
  })
  const file = path.join(run.evidenceDir, `${safeName(name)}.png`)
  fs.writeFileSync(file, Buffer.from(data, 'base64'))
  logAction(run, 'screenshot', { name }, path.relative(ROOT, file))
  console.log(path.relative(ROOT, file))
}

// How the application menu looks to the user: labels, disabled items, shortcuts, and roles.
const MENU_TREE = `(() => {
  const walk = (items, depth) => items.flatMap((i) => {
    const flags = [
      i.enabled ? '' : ' [disabled]',
      i.visible ? '' : ' [hidden]',
      i.type === 'checkbox' || i.type === 'radio' ? (i.checked ? ' [checked]' : ' [unchecked]') : '',
      i.accelerator ? ' (' + i.accelerator + ')' : '',
      i.role ? ' {role ' + i.role + '}' : '',
      i.id ? ' #' + i.id : ''
    ].join('')
    const line = '  '.repeat(depth) + (i.type === 'separator' ? '---' : i.label) + flags
    return [line, ...(i.submenu ? walk(i.submenu.items, depth + 1) : [])]
  })
  const menu = Menu.getApplicationMenu()
  return menu ? walk(menu.items, 0).join('\\n') : '(no application menu)'
})()`

// macOS performs these menu roles natively by sending a Cocoa action, so calling the item's
// click() from JavaScript does nothing. menu-click sends the same action instead.
const NATIVE_ROLE_ACTIONS = {
  about: 'orderFrontStandardAboutPanel:',
  quit: 'terminate:',
  hide: 'hide:',
  hideothers: 'hideOtherApplications:',
  unhide: 'unhideAllApplications:',
  undo: 'undo:',
  redo: 'redo:',
  cut: 'cut:',
  copy: 'copy:',
  paste: 'paste:',
  selectall: 'selectAll:',
  minimize: 'performMiniaturize:',
  zoom: 'performZoom:',
  close: 'performClose:',
  front: 'arrangeInFront:',
  togglefullscreen: 'toggleFullScreen:'
}

async function menu() {
  const run = loadLiveRun()
  const tree = await withMain(run, (s) => evaluate(s, mainExpression(MENU_TREE)))
  console.log(tree)
  const name = positional[0]
  if (name) {
    const file = path.join(run.evidenceDir, `${safeName(name)}.menu.txt`)
    fs.writeFileSync(file, `${tree}\n`)
    logAction(run, 'menu', { name }, path.relative(ROOT, file))
    console.error(`Saved ${path.relative(ROOT, file)}`)
  }
}

async function menuClick() {
  const itemPath = requirePositional('a menu path such as "Window > Close"')
  const labels = itemPath.split('>').map((part) => part.trim())
  const run = loadLiveRun()
  const result = await withMain(run, (s) =>
    evaluate(
      s,
      mainExpression(`(() => {
        const labels = ${JSON.stringify(labels)}
        const actions = ${JSON.stringify(NATIVE_ROLE_ACTIONS)}
        let items = Menu.getApplicationMenu()?.items ?? []
        let item
        for (const label of labels) {
          item = items.find((i) => i.label === label)
          if (!item) return { clicked: false, reason: 'no menu item "' + label + '"' }
          items = item.submenu?.items ?? []
        }
        // A user cannot choose a hidden or disabled item, so neither can this command. The menu
        // bar shows AgentPeek's menus only while AgentPeek is active, and window actions go to
        // the focused window, so the window must be focused too.
        if (!item.visible) return { clicked: false, reason: 'hidden' }
        if (!item.enabled) return { clicked: false, reason: 'disabled' }
        const win = BrowserWindow.getFocusedWindow()
        if (!win) return { clicked: false, reason: 'window not focused; run focus first' }
        const action = actions[item.role]
        if (action) {
          Menu.sendActionToFirstResponder(action)
          return { clicked: true, via: action }
        }
        item.click(undefined, win, win.webContents)
        return { clicked: true, via: 'click handler' }
      })()`)
    )
  )
  printAndLog(run, 'menu-click', { path: itemPath }, result)
  if (!result.clicked) process.exit(1)
}

// Whether the window is the focused (key) window on screen, as the main process sees it.
const WINDOW_FOCUSED = 'BrowserWindow.getAllWindows()[0]?.isFocused() ?? false'

// Brings AgentPeek to the front, as clicking its window would. Takes focus from the user's app.
async function focus() {
  const run = loadLiveRun()
  await withMain(run, (s) =>
    evaluate(
      s,
      mainExpression(`(() => {
        const win = BrowserWindow.getAllWindows()[0]
        if (win.isMinimized()) win.restore()
        app.focus({ steal: true })
        win.focus()
      })()`)
    )
  )
  const focused = await waitFor('the window to take focus', 3000, () =>
    withMain(run, (s) => evaluate(s, mainExpression(WINDOW_FOCUSED)))
  ).catch(() => false)
  printAndLog(run, 'focus', {}, { windowFocused: focused })
  if (!focused) process.exit(1)
}

async function relaunch() {
  const run = loadLiveRun()
  const before = await withMain(run, (s) => evaluate(s, mainExpression(WINDOW_FOCUSED)))
  const env = { ...process.env, AGENTPEEK_HOME: run.homeDir, AGENTPEEK_USER_DATA: run.userDataDir }
  delete env.ELECTRON_RUN_AS_NODE
  delete env.ELECTRON_RENDERER_URL
  const started = Date.now()
  const second = spawn(run.electronPath, [`--user-data-dir=${run.userDataDir}`, ROOT], {
    cwd: ROOT,
    env,
    stdio: 'ignore'
  })
  const exit = await new Promise((resolve) => {
    const timer = setTimeout(() => {
      // Only the copy this command started is killed.
      second.kill('SIGKILL')
      resolve({ code: null, timedOut: true })
    }, 15_000)
    second.on('exit', (code) => {
      clearTimeout(timer)
      resolve({ code, timedOut: false })
    })
  })
  const elapsedMs = Date.now() - started
  await sleep(500)
  const after = await withMain(run, (s) => evaluate(s, mainExpression(WINDOW_FOCUSED)))
  const windows = await withMain(run, (s) =>
    evaluate(s, mainExpression('BrowserWindow.getAllWindows().length'))
  )
  const result = {
    secondExitCode: exit.code,
    timedOut: exit.timedOut,
    elapsedMs,
    firstStillAlive: isAlive(run.pid),
    windows,
    windowFocusedBefore: before,
    windowFocusedAfter: after
  }
  printAndLog(run, 'relaunch', {}, result)
}

async function waitExit() {
  const run = loadRun()
  const timeout = Number(flags.timeout ?? 5000)
  const started = Date.now()
  while (isAlive(run.pid) && Date.now() - started < timeout) await sleep(50)
  const exited = !isAlive(run.pid)
  const result = { exited, elapsedMs: Date.now() - started }
  if (exited) {
    run.status = 'exited'
    run.exitedAt = new Date().toISOString()
    writeRun(run)
  }
  printAndLog(run, 'wait-exit', { timeout }, result)
  process.exit(exited ? 0 : 1)
}

// ---------------------------------------------------------------------------------------------
// stop

async function stop() {
  const runs = flags.all ? allRuns() : [loadRun()]
  let problems = 0
  for (const run of runs) {
    if (run.status === 'stopped' && !fs.existsSync(run.scratchDir) && !isOurs(run)) continue
    const report = await stopRun(run)
    console.log(JSON.stringify(report, null, 2))
    if (!report.clean) problems++
  }
  if (runs.length === 0) console.log('No runs recorded.')
  process.exit(problems === 0 ? 0 : 1)
}

async function stopRun(run) {
  // Kill only what this run started: the recorded pid, after checking it is still our process,
  // then any leftover helper process whose command line carries this run's unique profile path.
  if (isOurs(run)) {
    process.kill(run.pid, 'SIGTERM')
    const started = Date.now()
    while (isAlive(run.pid) && Date.now() - started < 5000) await sleep(100)
    if (isAlive(run.pid)) process.kill(run.pid, 'SIGKILL')
  }
  await sleep(300)
  for (const pid of processesWithMarker(run.userDataDir)) {
    try {
      process.kill(pid, 'SIGKILL')
    } catch {
      // Already gone.
    }
  }
  await sleep(200)

  const leftovers = processesWithMarker(run.userDataDir)
  const openPorts = [run.cdpPort, run.inspectorPort].filter((p) => p && portOwner(p) !== null)
  fs.rmSync(run.scratchDir, { recursive: true, force: true })
  const newest = newestMtime(DEFAULT_USER_DATA)
  const report = {
    runId: run.runId,
    clean: leftovers.length === 0 && openPorts.length === 0 && !fs.existsSync(run.scratchDir),
    leftoverProcesses: leftovers,
    portsStillOpen: openPorts,
    scratchRemoved: !fs.existsSync(run.scratchDir),
    // AgentPeek's real profile folder must not change during an isolated run. A change here can
    // also come from the user's own AgentPeek running at the same time.
    defaultProfileUnchanged: newest === run.defaultUserDataNewestMtime,
    evidenceDir: path.relative(ROOT, run.evidenceDir)
  }
  run.status = 'stopped'
  run.stoppedAt = new Date().toISOString()
  run.stopReport = report
  writeRun(run)
  logAction(run, 'stop', {}, report)
  return report
}

// ---------------------------------------------------------------------------------------------
// CDP and inspector plumbing

async function findPageTarget(run) {
  const targets = await getJson(`http://127.0.0.1:${run.cdpPort}/json/list`)
  const pages = targets.filter((t) => t.type === 'page' && !t.url.startsWith('devtools://'))
  if (pages.length === 0) throw new Error('no page target yet')
  return pages.find((t) => t.url === RENDERER_URL) ?? pages[0]
}

async function withPage(run, fn) {
  const target = await findPageTarget(run)
  return withSession(target.webSocketDebuggerUrl, fn)
}

async function withMain(run, fn) {
  const [target] = await getJson(`http://127.0.0.1:${run.inspectorPort}/json/list`)
  if (!target) throw new Error('the main-process inspector lists no target')
  return withSession(target.webSocketDebuggerUrl, fn)
}

// Wraps an expression so it runs inside the main process with Electron's modules in scope.
function mainExpression(expression) {
  return `(async () => {
    const require = (id) => process.mainModule.require(id)
    const electron = require('electron')
    const { app, BrowserWindow, Menu } = electron
    return await (${expression})
  })()`
}

async function withSession(wsUrl, fn) {
  const session = await openSession(wsUrl)
  try {
    return await fn(session)
  } finally {
    session.close()
  }
}

function openSession(wsUrl) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(wsUrl)
    const pending = new Map()
    const listeners = []
    let nextId = 1
    ws.onerror = () => reject(new Error(`cannot connect to ${wsUrl}`))
    ws.onclose = () => {
      for (const { reject: rejectCall, method } of pending.values()) {
        rejectCall(new Error(`connection closed during ${method}`))
      }
      pending.clear()
    }
    ws.onmessage = (event) => {
      const message = JSON.parse(event.data)
      if (message.id && pending.has(message.id)) {
        const call = pending.get(message.id)
        pending.delete(message.id)
        clearTimeout(call.timer)
        if (message.error) call.reject(new Error(`${call.method}: ${message.error.message}`))
        else call.resolve(message.result)
      } else if (message.method) {
        for (const listener of listeners) listener(message)
      }
    }
    ws.onopen = () =>
      resolve({
        send(method, params = {}) {
          const id = nextId++
          ws.send(JSON.stringify({ id, method, params }))
          return new Promise((resolveCall, rejectCall) => {
            const timer = setTimeout(() => {
              if (pending.delete(id)) rejectCall(new Error(`${method} timed out`))
            }, 15_000)
            pending.set(id, { resolve: resolveCall, reject: rejectCall, method, timer })
          })
        },
        onEvent(listener) {
          listeners.push(listener)
        },
        close() {
          ws.close()
        }
      })
  })
}

async function evaluate(session, expression) {
  const { result, exceptionDetails } = await session.send('Runtime.evaluate', {
    expression,
    returnByValue: true,
    awaitPromise: true,
    // DevTools lets evaluated code call eval() even when the page's CSP forbids it. Turn that off
    // so code started from an expression meets the same CSP as the page's own scripts.
    allowUnsafeEvalBlockedByCSP: false
  })
  if (exceptionDetails) {
    const reason = exceptionDetails.exception?.description ?? exceptionDetails.text
    throw new Error(`the expression threw: ${reason}`)
  }
  return result.value
}

// Errors already logged by the page. Runtime.enable and Log.enable replay earlier entries.
async function collectConsoleProblems(session) {
  const problems = []
  session.onEvent(({ method, params }) => {
    if (method === 'Runtime.consoleAPICalled' && params.type === 'error') {
      problems.push(`console.error: ${params.args.map((a) => a.value ?? a.description).join(' ')}`)
    } else if (method === 'Runtime.exceptionThrown') {
      problems.push(
        `exception: ${params.exceptionDetails.exception?.description ?? params.exceptionDetails.text}`
      )
    } else if (method === 'Log.entryAdded' && params.entry.level === 'error') {
      problems.push(`${params.entry.source}: ${params.entry.text}`)
    }
  })
  await session.send('Runtime.enable')
  await session.send('Log.enable')
  await sleep(300)
  return problems
}

function formatAxTree(nodes) {
  const byId = new Map(nodes.map((n) => [n.nodeId, n]))
  const lines = []
  const walk = (node, depth) => {
    let childDepth = depth
    const role = node.role?.value
    if (!node.ignored && role && role !== 'none' && role !== 'generic') {
      const name = node.name?.value ? ` "${node.name.value}"` : ''
      const props = (node.properties ?? [])
        .filter((p) =>
          ['level', 'disabled', 'focused', 'checked', 'selected', 'expanded', 'pressed'].includes(
            p.name
          )
        )
        .filter((p) => p.value?.value !== false)
        .map((p) => (p.value?.value === true ? p.name : `${p.name}=${p.value?.value}`))
      lines.push(
        `${'  '.repeat(depth)}${role}${name}${props.length ? ` [${props.join(', ')}]` : ''}`
      )
      childDepth = depth + 1
    }
    for (const id of node.childIds ?? []) {
      const child = byId.get(id)
      if (child) walk(child, childDepth)
    }
  }
  if (nodes[0]) walk(nodes[0], 0)
  return lines.join('\n')
}

const NAMED_KEYS = {
  F10: 121,
  Enter: 13,
  Escape: 27,
  Tab: 9,
  Backspace: 8,
  Delete: 46,
  Space: 32,
  ArrowUp: 38,
  ArrowDown: 40,
  ArrowLeft: 37,
  ArrowRight: 39,
  Home: 36,
  End: 35,
  PageUp: 33,
  PageDown: 34
}
const MODIFIER_BITS = { Alt: 1, Control: 2, Meta: 4, Shift: 8 }

function parseCombo(combo) {
  const parts = combo.split('+')
  const main = parts.pop()
  let modifiers = 0
  for (const part of parts) {
    const bit = MODIFIER_BITS[part]
    if (!bit) throw new Error(`unknown modifier "${part}"; use Alt, Control, Meta, or Shift`)
    modifiers |= bit
  }
  const printable = modifiers === 0 || modifiers === MODIFIER_BITS.Shift
  if (main in NAMED_KEYS) {
    const keyName = main === 'Space' ? ' ' : main
    const text = { Enter: '\r', Space: ' ' }[main]
    return {
      key: keyName,
      code: main,
      keyCode: NAMED_KEYS[main],
      text: printable ? text : undefined,
      modifiers
    }
  }
  if (/^[A-Za-z]$/.test(main)) {
    const upper = main.toUpperCase()
    const keyName = modifiers & MODIFIER_BITS.Shift ? upper : main.toLowerCase()
    return {
      key: keyName,
      code: `Key${upper}`,
      keyCode: upper.charCodeAt(0),
      text: printable ? keyName : undefined,
      modifiers
    }
  }
  if (/^[0-9]$/.test(main)) {
    return {
      key: main,
      code: `Digit${main}`,
      keyCode: main.charCodeAt(0),
      text: printable ? main : undefined,
      modifiers
    }
  }
  throw new Error(`unsupported key "${main}"`)
}

// ---------------------------------------------------------------------------------------------
// Runs, processes, and files

function findRepoRoot() {
  // Resolve symlinks first, so a pointer such as .claude/skills/verify-agentpeek still finds the
  // checkout that holds the real file.
  let dir = path.dirname(fs.realpathSync(fileURLToPath(import.meta.url)))
  for (;;) {
    const pkg = path.join(dir, 'package.json')
    if (fs.existsSync(pkg) && JSON.parse(fs.readFileSync(pkg, 'utf8')).name === 'agentpeek') {
      return dir
    }
    const parent = path.dirname(dir)
    if (parent === dir) throw new Error('cannot find the AgentPeek checkout above this script')
    dir = parent
  }
}

function resolveElectron() {
  try {
    return createRequire(path.join(ROOT, 'package.json'))('electron')
  } catch {
    fail('Electron is not installed; run `npm install` first.')
  }
}

function loadRun() {
  const runId =
    flags.run ?? (fs.existsSync(CURRENT_FILE) ? fs.readFileSync(CURRENT_FILE, 'utf8').trim() : '')
  if (!runId) fail('No run recorded. Start one with `launch`.')
  const file = path.join(RUNS_DIR, String(runId), 'run.json')
  if (!fs.existsSync(file)) fail(`No run.json for run ${runId}.`)
  return JSON.parse(fs.readFileSync(file, 'utf8'))
}

function loadLiveRun() {
  const run = loadRun()
  if (!isOurs(run)) fail(`Run ${run.runId} is not running (status ${run.status}).`)
  if (!run.cdpPort) fail(`Run ${run.runId} never became ready.`)
  return run
}

function allRuns() {
  if (!fs.existsSync(RUNS_DIR)) return []
  return fs
    .readdirSync(RUNS_DIR)
    .map((id) => path.join(RUNS_DIR, id, 'run.json'))
    .filter((file) => fs.existsSync(file))
    .map((file) => JSON.parse(fs.readFileSync(file, 'utf8')))
}

function writeRun(run) {
  fs.writeFileSync(path.join(run.evidenceDir, 'run.json'), `${JSON.stringify(run, null, 2)}\n`)
}

function logAction(run, commandName, args, result) {
  const line = JSON.stringify({
    time: new Date().toISOString(),
    command: commandName,
    args,
    result
  })
  fs.appendFileSync(path.join(run.evidenceDir, 'actions.jsonl'), `${line.slice(0, 4000)}\n`)
}

function printAndLog(run, commandName, args, value) {
  console.log(typeof value === 'string' ? value : JSON.stringify(value, null, 2))
  logAction(run, commandName, args, value)
}

function isAlive(pid) {
  if (!pid) return false
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return error.code === 'EPERM'
  }
}

function isOurs(run) {
  if (!isAlive(run.pid)) return false
  const cmd = processCommand(run.pid)
  return cmd.startsWith(run.electronPath) && cmd.includes(`--user-data-dir=${run.userDataDir}`)
}

function processCommand(pid) {
  const ps = spawnSync('ps', ['-o', 'command=', '-p', String(pid)], { encoding: 'utf8' })
  return ps.stdout.trim()
}

function processesWithMarker(marker) {
  const ps = spawnSync('ps', ['-axo', 'pid=,command='], { encoding: 'utf8' })
  return ps.stdout
    .split('\n')
    .map((line) => /^\s*(\d+)\s+(.*)$/.exec(line))
    .filter((m) => m && m[2].includes(marker) && Number(m[1]) !== process.pid)
    .map((m) => Number(m[1]))
}

function portOwner(port) {
  const lsof = spawnSync('lsof', ['-nP', `-iTCP:${port}`, '-sTCP:LISTEN', '-Fp'], {
    encoding: 'utf8'
  })
  const match = /^p(\d+)$/m.exec(lsof.stdout)
  return match ? Number(match[1]) : null
}

function newestMtime(dir, depth = 0) {
  if (!fs.existsSync(dir)) return null
  let newest = fs.statSync(dir).mtimeMs
  if (depth > 3) return newest
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name)
    const value = entry.isDirectory()
      ? newestMtime(full, depth + 1)
      : fs.lstatSync(full, { throwIfNoEntry: false })?.mtimeMs
    if (value && value > newest) newest = value
  }
  return newest
}

const BUILD_FILES = ['out/main/index.js', 'out/preload/index.js', 'out/renderer/index.html']

// The modification time of each build entry file, recorded at launch.
function buildMtimes() {
  return Object.fromEntries(BUILD_FILES.map((f) => [f, fs.statSync(path.join(ROOT, f)).mtimeMs]))
}

// What changed since the build this run started from: sources edited after the build began
// (tests excluded), and whether out/ was rebuilt after launch. Either way, the instance runs
// older code than the checkout.
function staleSources(run) {
  const builtAt = Math.min(...Object.values(run.buildMtimes))
  const changed = []
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name)
      if (entry.isDirectory()) walk(full)
      else if (!entry.name.endsWith('.test.ts') && fs.statSync(full).mtimeMs > builtAt) {
        changed.push(path.relative(ROOT, full))
      }
    }
  }
  walk(path.join(ROOT, 'src'))
  const now = buildMtimes()
  if (BUILD_FILES.some((f) => now[f] !== run.buildMtimes[f])) {
    changed.push('out/ (rebuilt after launch)')
  }
  return changed
}

function gitInfo() {
  const head = spawnSync('git', ['rev-parse', '--short', 'HEAD'], { cwd: ROOT, encoding: 'utf8' })
  const status = spawnSync('git', ['status', '--porcelain'], { cwd: ROOT, encoding: 'utf8' })
  return { head: head.stdout.trim(), dirty: status.stdout.trim().length > 0 }
}

async function getJson(url) {
  const response = await fetch(url)
  if (!response.ok) throw new Error(`${url} answered ${response.status}`)
  return response.json()
}

async function waitFor(what, timeoutMs, probe) {
  const started = Date.now()
  let lastError
  while (Date.now() - started < timeoutMs) {
    try {
      const value = await probe()
      if (value) return value
    } catch (error) {
      if (/exited during startup/.test(error.message)) throw error
      lastError = error
    }
    await sleep(200)
  }
  throw new Error(`timed out waiting for ${what}${lastError ? ` (${lastError.message})` : ''}`)
}

function parseArgs(argv) {
  const positionalArgs = []
  const parsed = {}
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    if (arg.startsWith('--')) {
      const name = arg.slice(2)
      const next = argv[i + 1]
      if (next === undefined || next.startsWith('--')) parsed[name] = true
      else parsed[name] = argv[++i]
    } else {
      positionalArgs.push(arg)
    }
  }
  return { positional: positionalArgs, flags: parsed }
}

function requirePositional(what) {
  if (positional[0] === undefined) fail(`Pass ${what}. Run without arguments for help.`)
  return positional[0]
}

function safeName(name) {
  return String(name)
    .replace(/\.(png|aria\.txt|menu\.txt)$/, '')
    .replace(/[^A-Za-z0-9_.-]+/g, '-')
}

function timestamp() {
  const d = new Date()
  const pad = (n) => String(n).padStart(2, '0')
  return `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function fail(message) {
  console.error(message)
  process.exit(2)
}

// ---------------------------------------------------------------------------------------------
// Entry point. It runs last, so every constant above is initialized.

const [command, ...rest] = process.argv.slice(2)
const { positional, flags } = parseArgs(rest)

try {
  if (Number(process.versions.node.split('.')[0]) < 22) {
    fail(`Node.js 22 or later is required (found ${process.version}).`)
  }
  switch (command) {
    case 'launch':
      await launch()
      break
    case 'doctor':
      await doctor()
      break
    case 'eval':
      await evalPage()
      break
    case 'main-eval':
      await evalMain()
      break
    case 'click':
      await click()
      break
    case 'key':
      await key()
      break
    case 'type':
      await typeText()
      break
    case 'aria':
      await aria()
      break
    case 'screenshot':
      await screenshot()
      break
    case 'menu':
      await menu()
      break
    case 'menu-click':
      await menuClick()
      break
    case 'focus':
      await focus()
      break
    case 'relaunch':
      await relaunch()
      break
    case 'wait-exit':
      await waitExit()
      break
    case 'stop':
      await stop()
      break
    default:
      console.log(USAGE)
      process.exit(command ? 2 : 0)
  }
} catch (error) {
  console.error(`agentpeek.mjs ${command}: ${error instanceof Error ? error.message : error}`)
  process.exit(1)
}
