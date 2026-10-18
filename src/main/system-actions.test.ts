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
  it.each([
    ['codex', 'com.openai.codex'],
    ['claude', 'com.anthropic.claudefordesktop']
  ] as const)(
    'opens %s with a fixed executable and bundle ID, without a shell',
    async (tool, bundle) => {
      ports.execFile.mockImplementation((_file, _args, _options, callback) => callback(null))
      expect(await systemActions.openTool(tool)).toBe(true)
      expect(ports.execFile).toHaveBeenCalledWith(
        '/usr/bin/open',
        ['-b', bundle],
        { timeout: 5000 },
        expect.any(Function)
      )
    }
  )
  it('reports an unavailable tool without propagating its error text', async () => {
    ports.execFile.mockImplementation((_file, _args, _options, callback) =>
      callback(new Error('Synthetic error'))
    )
    expect(await systemActions.openTool('codex')).toBe(false)
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
