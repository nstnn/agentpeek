import { describe, expect, it } from 'vitest'
import { AGENT_TOOLS, isAgentTool } from './tools'

describe('isAgentTool', () => {
  it('accepts every supported tool', () => {
    for (const tool of AGENT_TOOLS) {
      expect(isAgentTool(tool)).toBe(true)
    }
  })

  it('rejects other values', () => {
    for (const value of ['antigravity', 'Codex', '', undefined, null, 1, {}]) {
      expect(isAgentTool(value)).toBe(false)
    }
  })
})
