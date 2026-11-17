import { execFile } from 'node:child_process'
import { clipboard, shell } from 'electron'
import type { AgentTool } from '../core/tools'
import type { SessionKey } from '../core/session'

export const TOOL_BUNDLES: Readonly<Record<AgentTool, string>> = {
  codex: 'com.openai.codex',
  claude: 'com.anthropic.claudefordesktop'
}

export interface SystemActions {
  openTool(key: SessionKey): Promise<boolean>
  copyText(text: string): Promise<void>
  openLink(url: string): Promise<boolean>
}

export const systemActions: SystemActions = {
  async openTool(key) {
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
    return new Promise((resolve) => {
      execFile('/usr/bin/open', ['-b', TOOL_BUNDLES[key.tool]], { timeout: 5000 }, (error) => {
        resolve(error === null)
      })
    })
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
