import type { CodexRecord } from '../../core/codex/records'
import { parseRecord } from '../../core/codex/records'
import {
  recordedSkill,
  skillContent,
  skillMentions,
  type SkillContent,
  type SkillRequest
} from '../../core/skills'
import { type AccessGate, AccessRefusedError, createSkillAccessGate } from './access'

const MAX_SKILL_BYTES = 128 * 1024

/** Reauthorize against the current bounded transcript before opening any local skill file. */
export async function readRequestedSkill(options: {
  lines: readonly string[]
  request: SkillRequest
  home: string
  workspace: string | null
  fixture: boolean
}): Promise<SkillContent> {
  const { lines, request } = options
  const records = lines.map((line) => parseRecord(line))
  const prompt = records.findLastIndex(
    (record) =>
      record?.kind === 'user-message' &&
      record.at === request.at &&
      skillMentions(record.text).some(
        (ref) => ref.name === request.name && ref.path === request.path
      )
  )
  if (prompt < 0) return { kind: 'unavailable', reason: 'not-found' }
  const boundary = (record: CodexRecord | null | undefined) =>
    record?.kind === 'turn-started' || record?.kind === 'user-message'
  let start = prompt
  for (let i = prompt - 1; i >= 0; i--) {
    if (boundary(records[i])) {
      if (records[i]?.kind === 'turn-started') start = i + 1
      break
    }
  }
  let end = prompt + 1
  while (end < records.length && !boundary(records[end])) end++
  for (let i = end - 1; i >= start; i--) {
    try {
      const line: unknown = JSON.parse(lines[i]!)
      if (!isObject(line) || line.type !== 'response_item' || !isObject(line.payload)) continue
      const payload = line.payload
      if (payload.type !== 'message' || payload.role !== 'user' || !Array.isArray(payload.content))
        continue
      for (const part of payload.content as unknown[]) {
        if (
          !isObject(part) ||
          (part.type !== 'input_text' && part.type !== 'text') ||
          typeof part.text !== 'string'
        )
          continue
        const content = recordedSkill(part.text, request)
        if (content !== null) return skillContent(content, 'conversation')
      }
    } catch {
      /* Malformed or unrelated records do not authorize a read. */
    }
  }
  return readLocalSkill(
    request.path,
    createSkillAccessGate(options.home, options.workspace, options.fixture)
  )
}

/** Reads a SKILL.md through a skill gate, bounded, after the caller reauthorized the request. */
export async function readLocalSkill(path: string, gate: AccessGate): Promise<SkillContent> {
  try {
    const handle = await gate.open(path)
    try {
      const buffer = Buffer.alloc(MAX_SKILL_BYTES + 1)
      let size = 0
      while (size < buffer.length) {
        const { bytesRead } = await handle.read(buffer, size, buffer.length - size, size)
        if (!bytesRead) break
        size += bytesRead
      }
      const truncated = size > MAX_SKILL_BYTES
      const decoder = new TextDecoder('utf-8')
      const text = decoder.decode(buffer.subarray(0, Math.min(size, MAX_SKILL_BYTES)), {
        stream: truncated
      })
      return skillContent(text, 'local', truncated)
    } finally {
      await handle.close()
    }
  } catch (error) {
    return {
      kind: 'unavailable',
      reason:
        error instanceof AccessRefusedError
          ? 'not-allowed'
          : isObject(error) && error.code === 'ENOENT'
            ? 'not-found'
            : 'unreadable'
    }
  }
}

function isObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}
