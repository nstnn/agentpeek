import { execFile } from 'node:child_process'

/**
 * The Codex app: ChatGPT.app on this Mac (TASK-002). The one rollout with `originator`
 * `codex_work_desktop` came from no other installed app, so no second bundle ID is checked
 * (TASK-007).
 */
export const CODEX_BUNDLE_ID = 'com.openai.codex'

const LSAPPINFO = '/usr/bin/lsappinfo'

/**
 * Whether the Codex app is running (TASK-002): `lsappinfo` prints a line starting with `ASN:` when
 * it is, and nothing when it is not. It runs without a shell, with fixed arguments.
 *
 * If the check itself fails, this answers true. AgentPeek then trusts an open turn, which the
 * 30-minute quiet rule still limits, instead of claiming that Codex is not running.
 */
export function isCodexAppRunning(): Promise<boolean> {
  return new Promise((resolve) => {
    execFile(
      LSAPPINFO,
      ['find', `bundleid=${CODEX_BUNDLE_ID}`],
      { timeout: 2000 },
      (error, stdout) => {
        resolve(error !== null || stdout.trimStart().startsWith('ASN:'))
      }
    )
  })
}
