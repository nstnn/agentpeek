import type { RecentMessages, SessionKey } from '../core/session'
import type { SessionsSnapshot } from '../core/snapshot'
import type { AgentTool } from '../core/tools'
import type { Theme } from './preferences'
import type { SkillContent, SkillRequest } from '../core/skills'

export interface AppSnapshot extends SessionsSnapshot {
  /** The synthetic home, for the fixture banner; null in a normal run. */
  readonly fixtureHome: string | null
}

export type MenuCommand =
  | 'view:active'
  | 'view:pinned'
  | 'view:all'
  | 'back'
  | 'settings'
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
}
