import { execFileSync } from 'node:child_process'
import process from 'node:process'
import { setTimeout } from 'node:timers/promises'

// Only processes carrying this run's unique Chromium profile are eligible for cleanup.
export function profileProcesses(profile) {
  return execFileSync('/bin/ps', ['-axo', 'pid=,command='], { encoding: 'utf8' })
    .split('\n')
    .filter((line) => line.includes(`--user-data-dir=${profile}`))
    .map((line) => Number(/^\s*(\d+)/.exec(line)?.[1]))
    .filter((pid) => Number.isSafeInteger(pid) && pid > 0 && pid !== process.pid)
}
export async function stopProfile(profile) {
  for (const signal of ['SIGTERM', 'SIGKILL']) {
    for (const pid of profileProcesses(profile)) {
      try {
        process.kill(pid, signal)
      } catch (error) {
        if (error.code !== 'ESRCH') throw error
      }
    }
    for (let i = 0; i < 40 && profileProcesses(profile).length; i++) await setTimeout(50)
    if (!profileProcesses(profile).length) return
  }
  throw new Error('Fixture profile still has running processes.')
}
