/** Fixed channels: the page never chooses an IPC channel. */
export const IPC = {
  getTheme: 'agentpeek:get-theme',
  setTheme: 'agentpeek:set-theme',
  setSourceEnabled: 'agentpeek:set-source-enabled',
  getSnapshot: 'agentpeek:get-snapshot',
  snapshot: 'agentpeek:snapshot',
  getMessages: 'agentpeek:get-messages',
  getSkill: 'agentpeek:get-skill',
  setPinned: 'agentpeek:set-pinned',
  markRead: 'agentpeek:mark-read',
  openTool: 'agentpeek:open-tool',
  copySessionId: 'agentpeek:copy-session-id',
  openLink: 'agentpeek:open-link',
  reload: 'agentpeek:reload',
  setSelection: 'agentpeek:set-selection',
  setDetailOpen: 'agentpeek:set-detail-open',
  showSessionMenu: 'agentpeek:show-session-menu',
  command: 'agentpeek:command',
  getRemoteStatus: 'agentpeek:get-remote-status',
  retryRemoteLoad: 'agentpeek:retry-remote-load',
  setRemoteEnabled: 'agentpeek:set-remote-enabled',
  saveRemoteConnection: 'agentpeek:save-remote-connection',
  setRemoteWorkspaceShared: 'agentpeek:set-remote-workspace-shared',
  setRemoteShareTitles: 'agentpeek:set-remote-share-titles',
  copyRemoteText: 'agentpeek:copy-remote-text'
} as const

/** Longest login or Mac address the IPC carries; the main process checks the exact rules. */
export const MAX_REMOTE_TEXT_LENGTH = 1024

export const MAX_MESSAGE_LIMIT = 200
