import type { RecentMessages, SessionKey } from '../core/session'
import type { SessionsSnapshot } from '../core/snapshot'
import type { AgentTool } from '../core/tools'

export interface AppSnapshot extends SessionsSnapshot {
  /** The synthetic home, for the fixture banner; null in a normal run. */
  readonly fixtureHome: string | null
}

export type MenuCommand = 'view:active' | 'view:pinned' | 'view:all' | 'back'

/** The renderer's entire capability surface. Only plain values cross the bridge. */
export interface AgentPeekApi {
  getSnapshot(): Promise<AppSnapshot>
  onSnapshot(callback: (snapshot: AppSnapshot) => void): () => void
  getMessages(key: SessionKey, limit: number): Promise<RecentMessages>
  setPinned(key: SessionKey, pinned: boolean): Promise<boolean>
  markRead(key: SessionKey): Promise<boolean>
  openTool(tool: AgentTool): Promise<boolean>
  copySessionId(key: SessionKey): Promise<boolean>
  openLink(url: string): Promise<boolean>
  reload(): Promise<void>
  setSelection(key: SessionKey | null): Promise<void>
  showSessionMenu(key: SessionKey): Promise<void>
  onCommand(callback: (command: MenuCommand) => void): () => void
}
