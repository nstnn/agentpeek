import { execFile } from 'node:child_process'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { isAntigravityAppRunning } from './app-running'
import { CODEX_BUNDLE_ID, isCodexAppRunning } from './codex-app'

// `lsappinfo` is replaced, so the tests never depend on which apps are running.
vi.mock('node:child_process', () => ({ execFile: vi.fn() }))

type Callback = (error: Error | null, stdout: string, stderr: string) => void

function answer(error: Error | null, stdout: string): void {
  vi.mocked(execFile).mockImplementation(((...args: unknown[]) => {
    const callback = args.at(-1) as Callback
    callback(error, stdout, '')
  }) as unknown as typeof execFile)
}

beforeEach(() => {
  vi.mocked(execFile).mockReset()
})

describe('isCodexAppRunning', () => {
  it('runs lsappinfo with fixed arguments and no shell', async () => {
    answer(null, '')
    await isCodexAppRunning()
    expect(execFile).toHaveBeenCalledWith(
      '/usr/bin/lsappinfo',
      ['find', `bundleid=${CODEX_BUNDLE_ID}`],
      { timeout: 2000 },
      expect.any(Function)
    )
    expect(CODEX_BUNDLE_ID).toBe('com.openai.codex')
  })

  it('answers true when lsappinfo finds the app', async () => {
    answer(null, 'ASN:0x0-0x1234:\n')
    expect(await isCodexAppRunning()).toBe(true)
  })

  it('answers false when lsappinfo prints nothing', async () => {
    answer(null, '')
    expect(await isCodexAppRunning()).toBe(false)
  })

  it('answers true when the check itself fails', async () => {
    answer(new Error('lsappinfo failed'), '')
    expect(await isCodexAppRunning()).toBe(true)
  })
})

describe('isAntigravityAppRunning', () => {
  it('requires a successful lookup that returns an ASN', async () => {
    answer(null, 'ASN:0x0-0x1234:\n')
    expect(await isAntigravityAppRunning()).toBe(true)
    expect(execFile).toHaveBeenCalledWith(
      '/usr/bin/lsappinfo',
      ['find', 'bundleid=com.google.antigravity'],
      { timeout: 2000 },
      expect.any(Function)
    )
    answer(null, '')
    expect(await isAntigravityAppRunning()).toBe(false)
    answer(new Error('lsappinfo failed'), 'ASN:0x0-0x1234:\n')
    expect(await isAntigravityAppRunning()).toBe(false)
  })
})
