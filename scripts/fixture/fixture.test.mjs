import { chmod, lstat, mkdir, readFile, symlink, rename } from 'node:fs/promises'
import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { openSessionsService } from '../../src/main/sessions/open-sessions'
import { createFixture, removeFixture, fixtureTarget, codexPath } from './home.mjs'
import { simulate } from './simulate.mjs'
import { IDS, PIDS, LONG_REPLY, HOSTILE } from './records.mjs'

const homes = []
let service
let clock
afterEach(async () => {
  await service?.stop()
  service = undefined
  for (const home of homes.splice(0)) await removeFixture(home)
})
async function fixture(options) {
  const created = await createFixture(options)
  homes.push(created.home)
  return created
}
async function start(created, dead = false) {
  clock = Date.now()
  service = await openSessionsService({
    home: created.home,
    stateFolder: created.userData,
    fixture: true,
    now: () => clock,
    isCodexAppRunning: async () => true,
    probe: { isAlive: async (pid) => !(dead && pid === PIDS.dead) },
    onSnapshot: () => {},
    createWatcher: () => ({ watchFolders: async () => {}, watchFiles: () => {}, close: () => {} })
  })
  await service.start()
  await vi.waitFor(() => expect(service.snapshot().health.claude.state).not.toBe('checking'))
}
const key = (name) => ({
  tool: ['busy', 'stopped', 'apiError', 'dead'].includes(name) ? 'claude' : 'codex',
  id: IDS[name]
})
const session = (name) => service.snapshot().sessions.find((s) => s.key.id === IDS[name])
async function step(home, name, check) {
  clock += 1000
  await simulate(home, name, clock)
  await service.reconcile()
  await vi.waitFor(check)
}

it('bootstraps both observed formats, caps each tool, baselines old replies and reads the detail stress cases', async () => {
  const created = await fixture()
  await start(created)
  const snapshot = service.snapshot()
  expect(snapshot.health.codex.state).toBe('connected')
  expect(snapshot.health.claude.state).toBe('connected')
  expect(snapshot.fixture).toBe(true)
  for (const tool of ['codex', 'claude'])
    expect(snapshot.sessions.filter((s) => s.key.tool === tool)).toHaveLength(50)
  expect(snapshot.groupCounts.running).toBe(7)
  expect(snapshot.needsAttention).toBe(0)
  expect(session('old')).toBeUndefined()
  for (const name of ['complete', 'error', 'aborted', 'busy'])
    expect(session(name).activity.state).toBe('running')
  const long = await service.recentMessages(key('long'), 20)
  expect(long.kind).toBe('messages')
  expect(long.hasOlder).toBe(true)
  expect(long.messages.some((m) => m.kind === 'reply' && m.text === LONG_REPLY)).toBe(true)
  expect(
    long.messages.some((m) => m.kind === 'tool-calls' && m.names.includes('synthetic_tool'))
  ).toBe(true)
  const hostile = await service.recentMessages(key('hostile'), 20)
  expect(hostile.messages.some((m) => m.kind === 'reply' && m.text === HOSTILE)).toBe(true)
})

it('loads explicit skill fixtures through the service and keeps their bodies out of snapshots and state', async () => {
  const created = await fixture()
  await start(created)
  await simulate(created.home, 'skill-references', clock)
  await service.reconcile()
  const messages = await service.recentMessages(key('retry'), 20)
  const message = messages.messages.find(
    (m) => m.kind === 'prompt' && m.text.startsWith('Review these synthetic skills:')
  )
  expect(message).toBeTruthy()
  const request = (name, path = join(created.home, '.agents', 'skills', name, 'SKILL.md')) => ({
    at: message.at,
    name,
    path
  })
  expect(await service.getSkill(key('retry'), request('synthetic-recorded'))).toMatchObject({
    kind: 'skill',
    source: 'conversation',
    description: 'Synthetic recorded skill copy.'
  })
  expect(await service.getSkill(key('retry'), request('synthetic-local'))).toMatchObject({
    kind: 'skill',
    source: 'local',
    description: 'Synthetic current local skill.'
  })
  expect(await service.getSkill(key('retry'), request('synthetic-long'))).toMatchObject({
    kind: 'skill',
    truncated: true
  })
  const empty = await service.getSkill(key('retry'), request('synthetic-empty'))
  expect(empty.kind).toBe('skill')
  expect(empty.text.trim()).toBe('')
  expect(await service.getSkill(key('retry'), request('synthetic-missing'))).toMatchObject({
    kind: 'unavailable',
    reason: 'not-found'
  })
  expect(
    await service.getSkill(
      key('retry'),
      request('synthetic-blocked', join(created.home, 'synthetic-other', 'SKILL.md'))
    )
  ).toMatchObject({ kind: 'unavailable', reason: 'not-allowed' })
  await simulate(created.home, 'skill-local-updated', clock + 10)
  expect(await service.getSkill(key('retry'), request('synthetic-local'))).toMatchObject({
    text: '# Synthetic updated local skill\n\nUpdated current instructions.'
  })
  await simulate(created.home, 'skill-missing-restored', clock + 20)
  expect(await service.getSkill(key('retry'), request('synthetic-missing'))).toMatchObject({
    kind: 'skill',
    source: 'local'
  })
  expect(JSON.stringify(service.snapshot())).not.toContain(
    'Original instructions from the conversation'
  )
  await service.stop()
  const state = await readFile(join(created.userData, 'state.json'), 'utf8')
  expect(state).not.toContain('Original instructions from the conversation')
  expect(state).not.toContain('Current local instructions')
})

it('plays every activity/attention scenario through the real readers and service without storing synthetic text', async () => {
  const created = await fixture()
  await start(created, true)
  expect(session('dead').activity).toEqual({ state: 'unknown', reason: 'process-ended' })
  await step(created.home, 'codex-complete', () => {
    expect(session('complete').activity.state).toBe('idle')
    expect(session('complete').attention.newReply).toBe(true)
  })
  await step(created.home, 'codex-new-turn', () => {
    expect(session('complete').activity.state).toBe('running')
    expect(session('complete').attention.newReply).toBe(false)
  })
  await step(created.home, 'codex-reply', () =>
    expect(session('complete').attention.newReply).toBe(true)
  )
  expect(service.markRead(key('complete'))).toBe(true)
  await vi.waitFor(() => expect(session('complete').attention.newReply).toBe(false))
  await step(created.home, 'codex-error', () => expect(session('error').attention.error).toBe(true))
  await step(created.home, 'codex-aborted', () => {
    expect(session('aborted').activity.state).toBe('idle')
    expect(session('aborted').attention.newReply).toBe(false)
    expect(session('aborted').attention.error).toBe(false)
  })
  await step(created.home, 'claude-waiting', () => {
    expect(session('busy').activity.state).toBe('waiting')
    expect(session('busy').attention.waiting).toBe(true)
  })
  await step(created.home, 'claude-denied', () => {
    expect(session('busy').activity.state).toBe('idle')
    expect(session('busy').attention.newReply).toBe(false)
    expect(session('busy').attention.error).toBe(false)
  })
  await step(created.home, 'claude-stopped', () => {
    expect(session('stopped').activity.state).toBe('idle')
    expect(session('stopped').attention.newReply).toBe(false)
  })
  await step(created.home, 'claude-api-error', () =>
    expect(session('apiError').attention.error).toBe(true)
  )
  await step(created.home, 'claude-reply', () =>
    expect(session('busy').attention.newReply).toBe(true)
  )
  await step(created.home, 'claude-new-turn', () => {
    expect(session('busy').activity.state).toBe('running')
    expect(session('busy').attention.newReply).toBe(false)
  })
  await step(created.home, 'registry-removed', () =>
    expect(session('dead').activity.state).toBe('idle')
  )
  await step(created.home, 'old-resumed', () =>
    expect(session('old').activity.state).toBe('running')
  )
  await step(created.home, 'malformed-line', () =>
    expect(service.snapshot().health.codex.state).toBe('connected')
  )
  expect(service.setPinned(key('hostile'), true)).toBe(true)
  await service.stop()
  const saved = await readFile(join(created.userData, 'state.json'), 'utf8')
  expect(saved).not.toContain('Synthetic')
  expect(saved).not.toContain('example.invalid')
  expect(saved).not.toContain(LONG_REPLY)
})

it('prepares read failure/recovery and missing-tool/recovery without harming the other source', async () => {
  const created = await fixture()
  await start(created)
  await simulate(created.home, 'read-failure')
  expect((await lstat(codexPath(created.home, IDS.retry))).mode & 0o777).toBe(0)
  expect((await service.recentMessages(key('retry'), 20)).kind).toBe('unreadable')
  await simulate(created.home, 'read-restored')
  expect((await service.recentMessages(key('retry'), 20)).kind).toBe('messages')
  await step(created.home, 'missing-codex', () => {
    expect(service.snapshot().health.codex.state).toBe('not-installed')
    expect(service.snapshot().health.claude.state).toBe('connected')
  })
  await step(created.home, 'restore-codex', () =>
    expect(service.snapshot().health.codex.state).toBe('connected')
  )
})

it.each(['codex', 'claude'])('can omit %s at bootstrap', async (missingTool) => {
  const created = await fixture({ missingTool })
  await start(created)
  expect(service.snapshot().health[missingTool].state).toBe('not-installed')
  expect(service.snapshot().sessions.every((s) => s.key.tool !== missingTool)).toBe(true)
})

it('refuses unmarked, escaping, symlinked and unknown simulation targets', async () => {
  const created = await fixture()
  await expect(simulate(created.userData, 'codex-complete')).rejects.toThrow()
  await expect(fixtureTarget(created.home, created.userData)).rejects.toThrow()
  await expect(simulate(created.home, 'not-a-step')).rejects.toThrow()
  const real = join(created.home, 'synthetic-saved-codex')
  await rename(join(created.home, '.codex'), real)
  await symlink(real, join(created.home, '.codex'))
  await expect(simulate(created.home, 'codex-complete')).rejects.toThrow('symlinks')
  const unmarked = join(created.root, 'unmarked')
  await mkdir(unmarked)
  await expect(fixtureTarget(unmarked)).rejects.toThrow()
  await chmod(created.home, 0o700)
})
