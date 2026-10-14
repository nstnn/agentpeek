import { execFile } from 'node:child_process'
import { afterEach, beforeEach, describe, expect, it, type MockInstance, vi } from 'vitest'
import { isProcessAlive } from './claude-process'

// `ps` and the signal check are replaced, so the tests never depend on which processes run.
vi.mock('node:child_process', () => ({ execFile: vi.fn() }))

type Callback = (error: (Error & { code?: unknown }) | null, stdout: string, stderr: string) => void

const START = 'Thu Jan 15 09:00:00 2026'

function psAnswers(error: (Error & { code?: unknown }) | null, stdout: string): void {
  vi.mocked(execFile).mockImplementation(((...args: unknown[]) => {
    const callback = args.at(-1) as Callback
    callback(error, stdout, '')
  }) as unknown as typeof execFile)
}

function killAnswers(code: string | null): MockInstance<typeof process.kill> {
  return vi.spyOn(process, 'kill').mockImplementation(() => {
    if (code === null) return true
    throw Object.assign(new Error('kill failed'), { code })
  })
}

function exitError(status: number): Error & { code: number } {
  return Object.assign(new Error('ps exited'), { code: status })
}

beforeEach(() => {
  vi.mocked(execFile).mockReset()
})

afterEach(() => {
  vi.restoreAllMocks()
})

describe('isProcessAlive', () => {
  it('checks the process ID with signal 0, then its start time with ps in UTC', async () => {
    const kill = killAnswers(null)
    psAnswers(null, `${START}\n`)
    expect(await isProcessAlive(4242, START)).toBe(true)
    expect(kill).toHaveBeenCalledWith(4242, 0)
    expect(execFile).toHaveBeenCalledWith(
      '/bin/ps',
      ['-o', 'lstart=', '-p', '4242'],
      { env: { LC_ALL: 'C', TZ: 'UTC' }, timeout: 2000 },
      expect.any(Function)
    )
  })

  it('answers false when no process has the ID', async () => {
    killAnswers('ESRCH')
    expect(await isProcessAlive(4242, START)).toBe(false)
    expect(execFile).not.toHaveBeenCalled()
  })

  it('counts a process that belongs to another user as existing', async () => {
    killAnswers('EPERM')
    psAnswers(null, START)
    expect(await isProcessAlive(4242, START)).toBe(true)
  })

  it('answers false when another process now has the ID', async () => {
    killAnswers(null)
    psAnswers(null, 'Fri Jan 16 10:00:00 2026\n')
    expect(await isProcessAlive(4242, START)).toBe(false)
  })

  it('answers false when the process ended before ps ran', async () => {
    killAnswers(null)
    psAnswers(exitError(1), '')
    expect(await isProcessAlive(4242, START)).toBe(false)
  })

  it('lets the ID check decide without a start time, or when ps cannot run', async () => {
    killAnswers(null)
    expect(await isProcessAlive(4242, null)).toBe(true)
    expect(execFile).not.toHaveBeenCalled()
    psAnswers(Object.assign(new Error('spawn failed'), { code: 'ENOENT' }), '')
    expect(await isProcessAlive(4242, START)).toBe(true)
  })

  it('never checks a process ID that would name a process group', async () => {
    const kill = killAnswers(null)
    for (const pid of [0, -1, 1.5, Number.NaN]) {
      expect(await isProcessAlive(pid, null)).toBe(false)
    }
    expect(kill).not.toHaveBeenCalled()
  })
})
