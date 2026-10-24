import { parse, type CallExpression } from 'acorn'
import type { ToolCallDetail } from '../session'

export const TOOL_INPUT_LIMIT = 6000
export const TOOL_GROUP_LIMIT = 50

/** Keep input only on the on-demand detail path. Never evaluate recorded JavaScript. */
export function toolCallDetail(name: string, at: number, value: unknown): ToolCallDetail {
  const input = typeof value === 'string' ? value.slice(0, TOOL_INPUT_LIMIT) : null
  const inputLength = typeof value === 'string' ? value.length : 0
  const isExec = name === 'exec' || name === 'functions.exec'
  return {
    name,
    at,
    input,
    inputLength,
    nestedNames: isExec
      ? input !== null && inputLength <= TOOL_INPUT_LIMIT
        ? nestedToolNames(input)
        : []
      : null
  }
}

/** Syntax only: ignore strings/comments and dynamic names; any parse failure means unknown. */
function nestedToolNames(input: string): string[] {
  try {
    const tree = parse(input, {
      ecmaVersion: 'latest',
      sourceType: 'module',
      allowReturnOutsideFunction: true
    })
    const pending: unknown[] = [tree]
    const names = new Set<string>()
    while (pending.length > 0) {
      const value = pending.pop()
      if (value === null || typeof value !== 'object') continue
      if (Array.isArray(value)) {
        pending.push(...[...(value as unknown[])].reverse())
        continue
      }
      const node = value as Record<string, unknown>
      if (node.type === 'CallExpression') {
        const { callee } = value as CallExpression
        if (
          callee.type === 'MemberExpression' &&
          callee.object.type === 'Identifier' &&
          callee.object.name === 'tools'
        ) {
          if (!callee.computed && callee.property.type === 'Identifier') {
            names.add(callee.property.name)
          } else if (
            callee.computed &&
            callee.property.type === 'Literal' &&
            typeof callee.property.value === 'string'
          ) {
            names.add(callee.property.value)
          }
        }
      }
      pending.push(...Object.values(node).reverse())
    }
    return [...names]
  } catch {
    return []
  }
}
