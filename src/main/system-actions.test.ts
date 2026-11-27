import { beforeEach, describe, expect, it, vi } from 'vitest'

const ports = vi.hoisted(() => ({
  execFile:
    vi.fn<
      (
        file: string,
        args: string[],
        options: object,
        callback: (error: Error | null) => void
      ) => void
    >(),
  writeText: vi.fn<(text: string) => Promise<void>>().mockResolvedValue(undefined),
  openExternal: vi.fn<(url: string) => Promise<void>>()
}))
vi.mock('node:child_process', () => ({ execFile: ports.execFile }))
vi.mock('electron', () => ({
  clipboard: { writeText: ports.writeText },
  shell: { openExternal: ports.openExternal }
}))
import { systemActions } from './system-actions'

beforeEach(() => {
  vi.clearAllMocks()
})
describe('system actions', () => {
  it('opens Claude with its existing fixed executable and bundle ID, without a shell', async () => {
    ports.execFile.mockImplementation((_file, _args, _options, callback) => callback(null))
    expect(await systemActions.openTool({ tool: 'claude', id: 'synthetic-session' })).toBe(true)
    expect(ports.execFile).toHaveBeenCalledWith(
      '/usr/bin/open',
      ['-b', 'com.anthropic.claudefordesktop'],
      { timeout: 5000 },
      expect.any(Function)
    )
    expect(ports.openExternal).not.toHaveBeenCalled()
  })
  it('brings Antigravity to the front by bundle ID, never with a link built from the ID', async () => {
    ports.execFile.mockImplementation((_file, _args, _options, callback) => callback(null))
    const id = '00000000-0000-4000-8000-000000000001'
    expect(await systemActions.openTool({ tool: 'antigravity', id })).toBe(true)
    expect(ports.execFile).toHaveBeenCalledExactlyOnceWith(
      '/usr/bin/open',
      ['-b', 'com.google.antigravity'],
      { timeout: 5000 },
      expect.any(Function)
    )
    expect(ports.openExternal).not.toHaveBeenCalled()
    ports.execFile.mockImplementation((_file, _args, _options, callback) =>
      callback(new Error('Synthetic error'))
    )
    expect(await systemActions.openTool({ tool: 'antigravity', id })).toBe(false)
  })
  it('opens the exact Codex thread without starting a resume process', async () => {
    const id = '00000000-0000-4000-8000-000000000001'
    ports.openExternal.mockResolvedValue(undefined)
    expect(await systemActions.openTool({ tool: 'codex', id })).toBe(true)
    expect(ports.openExternal).toHaveBeenCalledExactlyOnceWith(`codex://threads/${id}`)
    expect(ports.execFile).not.toHaveBeenCalled()
    ports.openExternal.mockRejectedValueOnce(new Error('Synthetic error'))
    expect(await systemActions.openTool({ tool: 'codex', id })).toBe(false)
  })
  it.each(['new', '..', '../new', 'id?prompt=synthetic', 'https://example.com', ''])(
    'rejects an invalid Codex thread ID without opening anything: %s',
    async (id) => {
      expect(await systemActions.openTool({ tool: 'codex', id })).toBe(false)
      expect(ports.openExternal).not.toHaveBeenCalled()
      expect(ports.execFile).not.toHaveBeenCalled()
    }
  )
  it("opens the exact Claude.app session through Claude.app's own link", async () => {
    ports.openExternal.mockResolvedValue(undefined)
    const key = { tool: 'claude', id: 'synthetic-session' } as const
    expect(await systemActions.openTool(key, 'local_synthetic-1')).toBe(true)
    expect(ports.openExternal).toHaveBeenCalledExactlyOnceWith(
      'claude://code/continue?session=local_synthetic-1'
    )
    expect(ports.execFile).not.toHaveBeenCalled()
  })
  it('opens Claude.app itself when its session link cannot be opened', async () => {
    ports.openExternal.mockRejectedValue(new Error('Synthetic error'))
    ports.execFile.mockImplementation((_file, _args, _options, callback) => callback(null))
    const key = { tool: 'claude', id: 'synthetic-session' } as const
    expect(await systemActions.openTool(key, 'local_synthetic-1')).toBe(true)
    expect(ports.execFile).toHaveBeenCalledWith(
      '/usr/bin/open',
      ['-b', 'com.anthropic.claudefordesktop'],
      { timeout: 5000 },
      expect.any(Function)
    )
  })
  it.each(['new', 'local_', 'local_../new', 'local_x?prompt=y', 'local_x&session=last'])(
    'never puts an invalid Claude.app session ID in a link: %s',
    async (appSessionId) => {
      ports.execFile.mockImplementation((_file, _args, _options, callback) => callback(null))
      const key = { tool: 'claude', id: 'synthetic-session' } as const
      expect(await systemActions.openTool(key, appSessionId)).toBe(true)
      expect(ports.openExternal).not.toHaveBeenCalled()
    }
  )
  it('reports an unavailable tool without propagating its error text', async () => {
    ports.execFile.mockImplementation((_file, _args, _options, callback) =>
      callback(new Error('Synthetic error'))
    )
    expect(await systemActions.openTool({ tool: 'claude', id: 'synthetic-session' })).toBe(false)
  })
  it('copies text and opens a validated link through Electron', async () => {
    await systemActions.copyText('synthetic-session')
    expect(ports.writeText).toHaveBeenCalledWith('synthetic-session')
    ports.openExternal.mockResolvedValue(undefined)
    expect(await systemActions.openLink('https://example.com')).toBe(true)
    ports.openExternal.mockRejectedValue(new Error('Synthetic error'))
    expect(await systemActions.openLink('https://example.com')).toBe(false)
  })
})
