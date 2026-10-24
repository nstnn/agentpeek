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
  command: 'agentpeek:command'
} as const

export const MAX_MESSAGE_LIMIT = 200
