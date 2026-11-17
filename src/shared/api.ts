import type { RecentMessages, SessionKey } from '../core/session'
import type { SessionsSnapshot } from '../core/snapshot'
import type { AgentTool } from '../core/tools'
import type { Theme } from './preferences'
import type { SkillContent, SkillRequest } from '../core/skills'
import type {
  RemoteActionResult,
  RemoteConnectionInput,
  RemoteCopyTarget,
  RemoteStatusView
} from './remote-settings'

export interface AppSnapshot extends SessionsSnapshot {
  /** The synthetic home, for the fixture banner; null in a normal run. */
  readonly fixtureHome: string | null
}

export type MenuCommand =
  | 'view:active'
  | 'view:inbox'
  | 'view:pinned'
  | 'view:all'
  | 'back'
  | 'settings'
  | 'quick-open'
  | { type: 'open-primary'; key: SessionKey }
  | { type: 'open-secondary'; key: SessionKey }
  | { type: 'close-secondary' }
  | { type: 'zoom'; percent: number; failed?: boolean }

export interface SelectionPresentation {
  readonly secondPaneOpen: boolean
}

/** The renderer's entire capability surface. Only plain values cross the bridge. */
export interface AgentPeekApi {
  getTheme(): Promise<Theme>
  setTheme(theme: Theme): Promise<void>
  setSourceEnabled(tool: AgentTool, enabled: boolean): Promise<void>
  getSnapshot(): Promise<AppSnapshot>
  onSnapshot(callback: (snapshot: AppSnapshot) => void): () => void
  getMessages(key: SessionKey, limit: number): Promise<RecentMessages>
  getSkill(key: SessionKey, request: SkillRequest): Promise<SkillContent>
  setPinned(key: SessionKey, pinned: boolean): Promise<boolean>
  markRead(key: SessionKey, expectedCursor?: string): Promise<boolean>
  openTool(tool: AgentTool): Promise<boolean>
  copySessionId(key: SessionKey): Promise<boolean>
  openLink(url: string): Promise<boolean>
  reload(): Promise<void>
  setSelection(key: SessionKey | null, presentation?: SelectionPresentation): Promise<void>
  setDetailOpen(open: boolean): Promise<void>
  showSessionMenu(key: SessionKey): Promise<void>
  onCommand(callback: (command: MenuCommand) => void): () => void
  /** Remote View settings (TASK-016). None of these runs, reads or configures Tailscale. */
  getRemoteStatus(): Promise<RemoteStatusView>
  /** Every change of the status, including viewer page counts (TASK-042). */
  onRemoteStatus(callback: (status: RemoteStatusView) => void): () => void
  /**
   * The "Session N" alias the viewer shows for this session, or null while Remote View is off,
   * titles are shared or the session is not shared (TASK-042).
   */
  getRemoteAlias(key: SessionKey): Promise<string | null>
  retryRemoteLoad(): Promise<void>
  setRemoteEnabled(enabled: boolean): Promise<RemoteActionResult>
  saveRemoteConnection(connection: RemoteConnectionInput): Promise<RemoteActionResult>
  /** `workspace` must be the exact folder of a listed session; the main process checks it. */
  setRemoteWorkspaceShared(workspace: string, shared: boolean): Promise<RemoteActionResult>
  setRemoteShareTitles(shareTitles: boolean): Promise<RemoteActionResult>
  /**
   * "Share recent messages" for this run only (TASK-043). It is never saved, and it can be on
   * only while Remote View is on: otherwise `not-listening`.
   */
  setRemoteShareMessages(shareMessages: boolean): Promise<RemoteActionResult>
  /** Copies text built from the saved settings; false when that setting is not saved yet. */
  copyRemoteText(target: RemoteCopyTarget): Promise<boolean>
}
