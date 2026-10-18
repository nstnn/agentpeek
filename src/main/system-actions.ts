import { execFile } from 'node:child_process'
import { clipboard, shell } from 'electron'
import type { AgentTool } from '../core/tools'

export const TOOL_BUNDLES: Readonly<Record<AgentTool, string>> = {
  codex: 'com.openai.codex',
  claude: 'com.anthropic.claudefordesktop'
}

export interface SystemActions {
  openTool(tool: AgentTool): Promise<boolean>
  copyText(text: string): Promise<void>
  openLink(url: string): Promise<boolean>
}

export const systemActions: SystemActions = {
  openTool: (tool) =>
    new Promise((resolve) => {
      execFile('/usr/bin/open', ['-b', TOOL_BUNDLES[tool]], { timeout: 5000 }, (error) => {
        resolve(error === null)
      })
    }),
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
