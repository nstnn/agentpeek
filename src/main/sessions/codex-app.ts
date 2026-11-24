import { isBundleRunning } from './app-running'

/**
 * The Codex app: ChatGPT.app on this Mac (TASK-002). The one rollout with `originator`
 * `codex_work_desktop` came from no other installed app, so no second bundle ID is checked
 * (TASK-007).
 */
export const CODEX_BUNDLE_ID = 'com.openai.codex'

/**
 * Whether the Codex app is running. If the check itself fails, this answers true, and the 30-minute
 * quiet rule still limits an open turn (see `isBundleRunning`).
 */
export function isCodexAppRunning(): Promise<boolean> {
  return isBundleRunning(CODEX_BUNDLE_ID)
}
