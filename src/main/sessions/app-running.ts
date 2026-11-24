import { execFile } from 'node:child_process'

const LSAPPINFO = '/usr/bin/lsappinfo'

/**
 * Whether the app with this bundle ID is running (TASK-002): `lsappinfo` prints a line starting
 * with `ASN:` when it is, and nothing when it is not. It runs without a shell, with fixed arguments.
 *
 * If the check itself fails, this answers true. AgentPeek then trusts an open turn, which the
 * source's quiet rule still limits, instead of claiming that the app is not running.
 */
export function isBundleRunning(bundleId: string): Promise<boolean> {
  return new Promise((resolve) => {
    execFile(LSAPPINFO, ['find', `bundleid=${bundleId}`], { timeout: 2000 }, (error, stdout) => {
      resolve(error !== null || stdout.trimStart().startsWith('ASN:'))
    })
  })
}

/** Antigravity Desktop on macOS (TASK-001: 2.34.0, `com.google.antigravity`). */
export const ANTIGRAVITY_BUNDLE_ID = 'com.google.antigravity'

/** Whether Antigravity Desktop is running (DECISION-004). */
export function isAntigravityAppRunning(): Promise<boolean> {
  return isBundleRunning(ANTIGRAVITY_BUNDLE_ID)
}
