import type { SessionsSnapshot } from '../snapshot'
import type { AgentTool } from '../tools'

// The Remote View sharing policy (TASK-015): which exact workspace folders the owner shares and
// whether session titles go with them. It is Mac-local: the desktop chooses folders from the
// sessions it already lists, and a remote request never names a path. Pure, so the projection and
// the main process apply the same rules.

/**
 * The explicit allowlist of desktop sources approved for Remote View (scope decision 7,
 * CONSTRAINT-004). Kept separate from `AGENT_TOOLS` so adding a desktop source never widens the
 * remote wire contract, health map, workspace eligibility, or message lookup.
 */
export const REMOTE_TOOLS = ['codex', 'claude'] as const satisfies readonly AgentTool[]

export type RemoteTool = (typeof REMOTE_TOOLS)[number]

/** Checks whether a tool is approved for Remote View before projecting, validating or resolving. */
export function isRemoteTool(value: unknown): value is RemoteTool {
  return typeof value === 'string' && (REMOTE_TOOLS as readonly string[]).includes(value)
}

export interface RemoteSharing {
  /** Exact workspace folders, each in `normalizeWorkspace` form. Children and worktrees are not included. */
  sharedWorkspaces: readonly string[]
  /** The "Share session titles" option. Off by default. */
  shareTitles: boolean
}

export const NOTHING_SHARED: RemoteSharing = Object.freeze({
  sharedWorkspaces: Object.freeze([]),
  shareTitles: false
})

/** The projection shows at most 50 projects; sharing more would only hide some. */
export const MAX_SHARED_WORKSPACES = 50

/** macOS `PATH_MAX`, in UTF-8 bytes. Keeps the settings file small. */
const MAX_WORKSPACE_PATH_BYTES = 1024

/** Exact-match form of a workspace path: trailing slashes removed, nothing else changed. */
export function normalizeWorkspace(path: string | null): string | null {
  if (path === null) return null
  const trimmed = path.replace(/\/+$/, '')
  return trimmed.length > 0 && trimmed.startsWith('/') ? trimmed : null
}

/**
 * A folder that can be shared and saved: an absolute path already in exact-match form, without
 * control characters, at most `PATH_MAX` bytes. The root folder cannot be shared.
 */
export function isShareableWorkspace(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    normalizeWorkspace(value) === value &&
    !/\p{Cc}/u.test(value) &&
    new TextEncoder().encode(value).length <= MAX_WORKSPACE_PATH_BYTES
  )
}

/**
 * The exact folder of a remote-eligible, active-source session the snapshot lists, which is the
 * only folder the owner can add. Ineligible sources never make a folder shareable.
 */
export function isListedWorkspace(snapshot: SessionsSnapshot, workspace: string): boolean {
  return snapshot.sessions.some(
    (session) =>
      isRemoteTool(session.key.tool) &&
      snapshot.health[session.key.tool].state !== 'off' &&
      normalizeWorkspace(session.summary.workspacePath) === workspace
  )
}

/** True when `next` shows less than `previous`: a folder removed or titles turned off. */
export function narrowsSharing(previous: RemoteSharing, next: RemoteSharing): boolean {
  if (previous.shareTitles && !next.shareTitles) return true
  const kept = new Set(next.sharedWorkspaces)
  return previous.sharedWorkspaces.some((workspace) => !kept.has(workspace))
}

/** True when a remote-eligible tool that was on in `previous` is off in `next`: its rows must go at once. */
export function sourceTurnedOff(previous: SessionsSnapshot, next: SessionsSnapshot): boolean {
  return REMOTE_TOOLS.some(
    (tool) => previous.health[tool].state !== 'off' && next.health[tool].state === 'off'
  )
}
