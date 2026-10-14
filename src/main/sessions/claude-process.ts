import { execFile } from 'node:child_process'

// The liveness check for a Claude Code registry entry (TASK-002). This is the same check Claude
// Code 2.1.293 uses: the process ID must exist, and when the entry has `procStart`, the process
// with that ID must have started at that time. A different start time means the system gave the
// ID to another process after the session's process ended.

export interface ProcessProbe {
  /** Whether the process that wrote a registry entry still runs. */
  isAlive(pid: number, procStart: string | null): Promise<boolean>
}

const PS = '/bin/ps'

/** The real check. Tests and fixture mode pass their own `ProcessProbe`. */
export const processProbe: ProcessProbe = { isAlive: isProcessAlive }

export async function isProcessAlive(pid: number, procStart: string | null): Promise<boolean> {
  // Signal 0 only checks: it sends nothing. A process ID of 0 or less would name a process group.
  if (!Number.isSafeInteger(pid) || pid <= 0 || !processExists(pid)) return false
  if (procStart === null) return true
  const startedAt = await processStart(pid)
  // When `ps` cannot run at all, the ID check alone decides.
  return startedAt === null || startedAt === procStart.trim()
}

function processExists(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    // EPERM: the process exists but belongs to another user. ESRCH: there is no such process.
    return typeof error === 'object' && error !== null && 'code' in error && error.code === 'EPERM'
  }
}

/**
 * The process's start time as `ps -o lstart=` prints it in UTC with the C locale, which is how
 * Claude Code writes `procStart`. An empty string when the process is gone, and null when `ps`
 * could not run. It runs without a shell, with fixed arguments.
 */
function processStart(pid: number): Promise<string | null> {
  return new Promise((resolve) => {
    execFile(
      PS,
      ['-o', 'lstart=', '-p', String(pid)],
      { env: { LC_ALL: 'C', TZ: 'UTC' }, timeout: 2000 },
      (error, stdout) => {
        // `ps` exits with status 1 and prints nothing for a process that does not exist. Any other
        // failure (it could not start, or timed out) leaves the question open.
        if (error !== null && typeof error.code !== 'number') resolve(null)
        else resolve(stdout.trim())
      }
    )
  })
}
