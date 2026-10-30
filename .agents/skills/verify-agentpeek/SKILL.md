---
name: verify-agentpeek
description: Launch, drive, and prove the behavior of AgentPeek, the Electron + React macOS app in this repository, through its real window and application menu, on an isolated instance with synthetic data, and save evidence. Use after any change that a user of the AgentPeek window could observe (what the window shows, menus and shortcuts, window and app lifecycle, the renderer's lockdown), and whenever asked to run, check, screenshot, or verify AgentPeek.
---

# Verify AgentPeek

AgentPeek is a desktop app: one window (a sandboxed React page) plus a native macOS application menu. You verify it by launching the **built** app as an isolated instance and driving it from a shell with one helper script:

```bash
node .agents/skills/verify-agentpeek/scripts/agentpeek.mjs <command> [options]
```

The helper talks to the window over the Chrome DevTools Protocol (CDP) and to the main process over the Node.js inspector, both on loopback ports that only this instance owns. It needs Node.js 22+ and `npm install` already run. Run it without arguments for the full command list.

It also needs native macOS process inspection (`ps` and `lsof`) and permission to launch Electron. A restricted shell can block these. `launch` checks process inspection before starting anything; an inspection error means cleanup is unverified, never that no processes remain. Use an authorized native shell for the same isolated commands and retain failed-run evidence.

The feature map in [`features/README.md`](features/README.md) lists what to verify and how. Read it before driving anything.

## Ground rules

These come from the repository's `AGENTS.md`. They override convenience.

- **Ask the user before `launch` and `relaunch`.** Both put a window on the user's screen, and `relaunch` and `focus` pull focus away from whatever the user is doing. One approval can cover every launch of one verification task; it does not carry over to the next task.
- **Synthetic data only.** `launch` always points the app at an empty or synthetic home folder (see Launch). Never pass a path that holds real Codex or Claude Code data to `--fixture`. A run on the user's real sessions needs their explicit consent for that run, and then you save no screenshots, accessibility trees, or page text, only counts and states.
- **Use this helper only on instances it started.** Never attach to the user's own AgentPeek or to an `npm run dev` session. Every command checks the recorded pid and its unique profile path before acting. The feature map also documents separately owned Playwright runs and native packaged runs; follow their own isolated launch and cleanup steps, and never attach this helper to those processes.
- **Never kill by process name.** Claude, VS Code, and other Electron apps run on this Mac, and the unpackaged AgentPeek also shows up as `Electron`. Use `stop`, which kills only the recorded pid and processes carrying the run's unique profile path.
- **Leave the tools' files alone.** Never create, change, or delete anything in `~/.codex` or `~/.claude`.

## Launch

```bash
node .agents/skills/verify-agentpeek/scripts/agentpeek.mjs launch --label <feature-or-task>
```

What it does:

1. Runs `npm run build` (typecheck + electron-vite build into `out/`). A failed build stops the launch. Pass `--no-build` only when `out/` is known to match the checkout (`doctor` tells you).
2. Creates the run's evidence folder `test-results/verify-agentpeek/<run-id>/` and its scratch folder `<tmp>/agentpeek-verify/<run-id>/` holding `user-data/` (a fresh Chromium profile) and `home/` (empty, or a copy of `--fixture <dir>` preserving file timestamps so age-based scenarios remain intact).
3. Starts `node_modules/electron`'s binary on the repository with `--user-data-dir=<scratch>/user-data`, `--remote-debugging-port=0`, and `--inspect=0`, detached, with stdout and stderr in `app.log`. It removes `ELECTRON_RUN_AS_NODE` and `ELECTRON_RENDERER_URL` from the environment and sets `AGENTPEEK_HOME=<scratch>/home` and `AGENTPEEK_USER_DATA=<scratch>/user-data`.
4. Waits until the instance is usable: both debug ports are announced in `app.log`, the page `out/renderer/index.html` has finished loading, React has rendered into `#root`, and the main process reports a visible window. This takes 1 to 3 seconds after the build.

It prints JSON with `runId`, `pid`, both ports, and both folders, and records the run as current in `test-results/verify-agentpeek/current`. Every other command acts on the current run unless you pass `--run <run-id>`. If startup fails, `launch` tears the instance down itself, keeps `app.log`, and exits 1.

Isolation facts, observed on this Mac:

- The own profile gives each run its own single-instance lock, so a verification run can sit beside the user's AgentPeek and beside other runs. Check the isolated paths with `doctor` and inspect `stop`'s default-profile mtime comparison (see Cleanup).
- The helper launches the unpackaged app: macOS names the process and the first menu `Electron`, the View menu has Toggle Developer Tools, and the page can reload itself. The local package now exists and disables the main-process inspector. Follow [`features/local-package.md`](features/local-package.md) for its separate native checks; never attach this helper or Playwright to it.
- **Fixture isolation is active.** The app requires both absolute overrides, uses the isolated profile before its single-instance lock, and reads only the synthetic home. `doctor` requires the snapshot's fixture flag and home plus the visible "Fixture data" banner. Never trust a run whose fixture check fails.

## Doctor

```bash
node .agents/skills/verify-agentpeek/scripts/agentpeek.mjs doctor
```

Read-only. Run it right after `launch`, and again whenever anything looks off (a command times out, the window seems wrong, you lost track of which run is current). Exit 0 means every line is PASS; exit 1 means at least one FAIL. It checks:

- the recorded pid is alive and is this run (own Electron binary, own profile path);
- both debug ports are listening and owned by that pid;
- the window shows the built files (`file://…/out/renderer/index.html`), not a dev server;
- the main process reports the `package.json` version, the run's profile as `userData`, the run's synthetic home, no `ELECTRON_RENDERER_URL`, and exactly one visible window;
- the page title is `AgentPeek`, `window.agentpeek` exists, and `require` does not;
- the snapshot confirms fixture mode and the run's synthetic home, also named in the visible fixture banner;
- the page has logged no console errors, exceptions, or CSP violations;
- no file in `src/` (tests excluded) changed after the build the run started from, and `out/` was not rebuilt since. A FAIL here means the instance runs older code: `stop`, then `launch` again.

## Drive

Get stable handles first, then act on them:

```bash
node .agents/skills/verify-agentpeek/scripts/agentpeek.mjs aria
node .agents/skills/verify-agentpeek/scripts/agentpeek.mjs menu
```

`aria` prints the page's accessibility tree as `role "name" [state]` lines. `menu` prints the application menu with `[disabled]`, shortcuts, roles, and ids. Use those roles, names, and menu labels in commands, never coordinates or DOM position.

| User action                          | Command                                                                                                            | How faithful it is                                                                                                                                                                                                                                                                                                                                                         |
| ------------------------------------ | ------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Click an element                     | `click --role <role> --name "<name>"` (or `--selector <css>`, `--nth <i>` when several match)                      | Real mouse press and release at the element's center through Chromium's input pipeline: real `mousedown`, `mouseup`, and `click` events. No hover is sent. The center is hit-tested first: if a sticky header or overlay covers it, the element is scrolled to the middle (`recentered` in the output), and a target still covered is refused, never clicked through.      |
| Double-click an element              | `click --selector <observed css> --double`                                                                         | Two real press/release pairs with click counts 1 and 2.                                                                                                                                                                                                                                                                                                                    |
| Observe navigation motion            | `motion --selector <observed css> --name <name> [--repeat-after 80] [--reduced-motion reduce] [--reduce-after 80]` | Real pointer clicks with intermediate PNG, geometry/animation samples and before/after ARIA over 500 ms. Optional repeated click reverses the same control; preference overrides affect only this isolated Chromium capture and are cleared afterwards. This is not a frame-rate benchmark or proof of macOS preference delivery.                                          |
| Resize a pane                        | `resize --selector <observed separator css> --by <signed pixels> [--cancel]`                                       | Requires window focus. Real pointer press, eight horizontal moves and release; `--cancel` presses Escape before release. Uses observed separator bounds, never writes layout state.                                                                                                                                                                                        |
| Drag a session row                   | `drag --source "<observed css>" --target "[aria-label='Drop in Right Pane']" --name <name> [--cancel]`             | Requires native window focus (`focus` first, especially after resizing). Real pointer drag with Chromium's intercepted actual payload; captures hover ARIA/PNG, then dispatches drop or Escape/cancel. Use `.sidebar-container` as an outside target. No fabricated keys or direct state writes. This proves in-app Chromium input, not external OS drag interoperability. |
| Press a key in the page              | `key Escape`, `key ArrowDown`, `key Meta+A`                                                                        | Real key events to the page. They never reach the native menu, so menu shortcuts such as Command-W or Command-R do nothing this way. For Command-A, C, X, V, Z the helper attaches the editing command that macOS's Edit menu would send.                                                                                                                                  |
| Type text                            | `type "<text>"`                                                                                                    | Inserts text at the focused element, like an input method commit.                                                                                                                                                                                                                                                                                                          |
| Choose a menu item                   | `menu-click "Window > Close Window"`                                                                               | Sends the same Cocoa action the menu bar sends (for roles such as Close, Minimize, Quit, Copy) or runs the item's own click handler. Refuses disabled or hidden items, like the real menu. Needs the window focused, as a user's menu choice does. Use it for menu shortcuts too.                                                                                          |
| Click the window to bring it forward | `focus`                                                                                                            | Brings AgentPeek to the front and makes its window key. Takes focus from the user's app.                                                                                                                                                                                                                                                                                   |
| Release native window focus          | `blur`                                                                                                             | Blurs only this isolated window for unread-on-focus tests; it does not physically switch apps.                                                                                                                                                                                                                                                                             |
| Open AgentPeek again                 | `relaunch`                                                                                                         | Starts a second copy against the same profile and reports its exit code, whether the first instance survived, and whether its window took focus.                                                                                                                                                                                                                           |
| Wait for the app to quit             | `wait-exit --timeout 3000`                                                                                         | Observes the recorded pid, profile processes and both debug ports without killing anything. `cleanExit: true` means all are gone before cleanup. Reports elapsed time from this command, not the app's exit code. Exit 1 if anything remains.                                                                                                                              |
| Read page state                      | `eval "<expression>"`                                                                                              | Runs in the page, after the action. Code it starts (`eval()`, `fetch`, new scripts) meets the page's CSP. Observe with it; never use it to set state that a user would set through the interface.                                                                                                                                                                          |
| Read main-process state              | `main-eval "<expression>"`                                                                                         | `require`, `electron`, `app`, `BrowserWindow`, and `Menu` are in scope, for example `main-eval "BrowserWindow.getAllWindows()[0].getBounds()"`. Observe with it; use only the explicit window-size and palette overrides described below. Feature actions go through their user controls.                                                                                  |

What this harness cannot reach: the pixels of the native menu bar, the title bar and its traffic-light buttons, the Dock, native context menus, and system dialogs. `menu-click` proves the menu's wiring and enabled state, not its drawing. If a change needs those surfaces, ask the user to check them, or, with their permission, use a desktop-control tool or `osascript` UI scripting through System Events. Both need macOS Accessibility permission, drive the user's real screen and mouse, and are unavailable in unattended or cloud runs, so they must not compete with someone using the Mac.

For layout measurements, `main-eval` may stand in for a native window resize as described in main-window.md. Focus the window, observe the resulting content width and settled layout, then capture; a successful resize call alone does not prove the layout has updated. Use View > Actual Size and reset the Sidebar width divider before asserting default capacity boundaries. Other feature actions still go through their user controls.

Appearance: never change the Mac's system appearance. Use Settings for Theme selection, saving and recovery (see settings.md). For palette inspection only, first record `main-eval "electron.nativeTheme.themeSource"`, then force `'light'` or `'dark'` through that property and capture. Restore the recorded value afterward; use `'system'` only if that was the original value. Report this as a forced app theme, not a saved preference or a system-setting change.

## Evidence

Everything for a run lives in `test-results/verify-agentpeek/<run-id>/`, which Git ignores and `stop` never deletes:

| File              | Written by                    | Holds                                                                                  |
| ----------------- | ----------------------------- | -------------------------------------------------------------------------------------- |
| `run.json`        | `launch`, `stop`, `wait-exit` | pid, ports, folders, Git head and dirty flag, build times, status, and the stop report |
| `actions.jsonl`   | every command                 | one line per action with its arguments and result, in order                            |
| `app.log`         | the app                       | the main process's stdout and stderr, including the debug-port lines                   |
| `<name>.png`      | `screenshot <name>`           | the page area of the window (no title bar), at the display's pixel density             |
| `<name>.aria.txt` | `aria <name>`                 | the accessibility tree at that moment                                                  |
| `<name>.menu.txt` | `menu <name>`                 | the application menu at that moment                                                    |

Proof standards:

- Exercise the user's path: `click`, `key`, `type`, `menu-click`, `focus`, `blur`, `relaunch`. A state you set with `eval` or `main-eval` proves nothing about the feature.
- Capture the action and the resulting state: an `aria` or `menu` snapshot plus a `screenshot` before and after the action that changes something, with the action itself in `actions.jsonl`.
- Check side effects, not only the screen: that all run processes and ports exited naturally (`wait-exit` with `cleanExit: true`), that a second copy exited with code 0 (`relaunch`), and the default-profile mtime comparison from `stop`. `stop` can kill residue, so its `clean: true` proves cleanup only.
- Name artifacts after the feature and step, for example `main-window-initial.png`.
- Your report lists the run id, the `doctor` result, each feature step with its command, observed result, and artifact names, the `stop` report, and anything you could not verify and why.
- Evidence holds synthetic data only. Never commit it, and never copy it into the repository's tracked files.
- Playwright clears its selected output directory before a run. Give each invocation a fresh `--output <new-evidence-dir>` as shown in fixture-regression.md, settings.md and zoom.md; never reuse a directory holding evidence you need to retain. These runs own their own profiles and processes, independently of the helper.

## Cleanup

```bash
node .agents/skills/verify-agentpeek/scripts/agentpeek.mjs stop
```

`stop` sends SIGTERM to the recorded pid after checking it is still this run's process (SIGKILL after 5 seconds), kills any leftover helper process whose command line holds this run's profile path, deletes the scratch folder, and prints a report. `clean: true` means no process is left, both ports are closed, and the scratch folder is gone. It is safe to run after the app already quit (for example after a lifecycle test), and it must run after every failed attempt too.

`defaultProfileUnchanged` compares shallow modification times in the default AgentPeek profile; it is not a full content audit. Report a `false` result, which can also come from a concurrent user instance, without attributing the write from this check alone. Fixture paths must still pass `doctor` independently.

`stop --all` does the same for every run recorded under `test-results/verify-agentpeek/`. Use it when a previous session may have left an instance running.

Afterwards, confirm the evidence folder still exists and holds your artifacts. Old run folders can be deleted by hand once nobody needs them.

## Helpers

`scripts/agentpeek.mjs` is the only helper. It is executable, has no dependencies, and finds the repository root by resolving its own real path and walking up to the `package.json` named `agentpeek`, so it works from any working directory and through the `.claude/skills/verify-agentpeek` pointer, which is a symlink to this folder for tools that read `.claude/skills`. Keep this folder the only copy.

A typical run:

```bash
node .agents/skills/verify-agentpeek/scripts/agentpeek.mjs launch --label main-window
node .agents/skills/verify-agentpeek/scripts/agentpeek.mjs doctor
node .agents/skills/verify-agentpeek/scripts/agentpeek.mjs aria main-window-initial
node .agents/skills/verify-agentpeek/scripts/agentpeek.mjs screenshot main-window-initial
node .agents/skills/verify-agentpeek/scripts/agentpeek.mjs stop
```

When the app gains a feature or changes one, update the matching file in `features/` in the same change. When it gains a surface this helper cannot drive or observe, extend the helper, prove the new command once on a launched instance, and document it here.
