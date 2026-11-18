import { execFile } from 'node:child_process'
import { clipboard, shell } from 'electron'
import type { AgentTool } from '../core/tools'
import type { SessionKey } from '../core/session'
import { CLAUDE_APP_SESSION_ID } from '../core/claude/records'

export const TOOL_BUNDLES: Readonly<Record<AgentTool, string>> = {
  codex: 'com.openai.codex',
  claude: 'com.anthropic.claudefordesktop'
}

export interface SystemActions {
  /**
   * Opens the session in its tool. For Claude Code, `appSessionId` is Claude.app's own ID for the
   * session; without one (a session run in a terminal), only Claude.app is opened.
   */
  openTool(key: SessionKey, appSessionId?: string): Promise<boolean>
  copyText(text: string): Promise<void>
  openLink(url: string): Promise<boolean>
}

export const systemActions: SystemActions = {
  async openTool(key, appSessionId) {
    if (key.tool === 'codex') {
      // Only thread UUIDs can reach this fixed route; reserved paths such as "new" cannot.
      if (!/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(key.id)) return false
      try {
        await shell.openExternal(`codex://threads/${key.id}`)
        return true
      } catch {
        return false
      }
    }
    // Claude.app's own link to one Code session. It is undocumented, so if it cannot be opened,
    // the app itself is opened as before. Only the validated `local_` form reaches this fixed route.
    if (appSessionId !== undefined && CLAUDE_APP_SESSION_ID.test(appSessionId)) {
      try {
        await shell.openExternal(`claude://code/continue?session=${appSessionId}`)
        return true
      } catch {
        // Fall through to opening the app.
      }
    }
    return openBundle(TOOL_BUNDLES[key.tool])
  },
  copyText: (text) => clipboard.writeText(text),
  async openLink(url) {
    try {
      await shell.openExternal(url)
      return true
    } catch {
      return false
    }
  }
}

function openBundle(bundleId: string): Promise<boolean> {
  return new Promise((resolve) => {
    execFile('/usr/bin/open', ['-b', bundleId], { timeout: 5000 }, (error) => {
      resolve(error === null)
    })
  })
}
