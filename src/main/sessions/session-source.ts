import type { ToolHealth } from '../../core/health'
import type { RecentMessages, SessionFacts, SessionKey } from '../../core/session'
export type { RecentMessages } from '../../core/session'
import type { AgentTool } from '../../core/tools'

// The interface each tool's source implements: Codex (codex-source.ts) and Claude Code (TASK-008).
// A source reads its tool's files through the access gate and reports normalized facts. The
// sessions service (TASK-010) turns those into sessions with the reducers in src/core. A source
// never writes a tool file and never logs what it reads.

/** REQ-002: the list holds the sessions active in the last 7 days… */
export const RECENT_SESSION_WINDOW_MS = 7 * 24 * 60 * 60 * 1000

/** …at most 50 per tool. */
export const MAX_SESSIONS_PER_TOOL = 50

export interface SessionSource {
  readonly tool: AgentTool
  /**
   * Reconciles: finds the tool's sessions and reads what changed in them. The service calls it at
   * launch, on window focus, on wake, and for View > Reload Sessions. Returns every listed session,
   * newest activity first.
   */
  catalog(): Promise<SessionFacts[]>
  /**
   * Reads only the files that changed, from the paths the watchers reported, and returns every
   * listed session again. With no paths it reads no file: it only re-checks liveness, for the
   * service's timer (REQ-008).
   */
  refresh(changedPaths: readonly string[]): Promise<SessionFacts[]>
  /** Reads a session's recent messages for the detail, at most `limit`. Nothing is cached. */
  recentMessages(key: SessionKey, limit: number): Promise<RecentMessages>
  /** The tool's health line, as of the last `catalog` or `refresh`. */
  health(): ToolHealth
  /**
   * The files that need their own file watch, because a folder watch misses their changes. The
   * service keeps one watch per path and drops watches for paths no longer listed. After adding a
   * watch, it calls `refresh` with that path once, to pick up writes made before the watch existed.
   */
  watchedFiles(): string[]
}
