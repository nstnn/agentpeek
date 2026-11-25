import type { Session } from '../../core/session'
import { quietMinutes, rowStatus, toolName } from './session-display'

export const clockTime = (at: number): string =>
  new Date(at).toLocaleTimeString('en-US', { hour12: false })

export function detailStatus(session: Session): { kind: string; label: string; callout?: string } {
  const { activity } = session
  if (activity.state === 'waiting') {
    const descriptions: Record<string, string> = {
      'permission prompt':
        'Claude Code is asking for permission to use a tool. Answer it in the Claude app.',
      'input needed': 'Claude Code asked you a question. Answer it in the Claude app.',
      'dialog open': 'Claude Code has a dialog open that needs you.',
      'sandbox request': 'Claude Code is asking to run something outside its sandbox.',
      'worker request': 'A Claude Code worker is waiting for your decision.',
      'goal proposal': 'Claude Code proposed a goal and is waiting for your answer.'
    }
    return {
      ...rowStatus(session),
      ...(activity.waitingFor === 'permission prompt'
        ? { label: 'Waiting for you · Permission prompt' }
        : {}),
      callout:
        descriptions[activity.waitingFor ?? ''] ??
        (activity.waitingFor
          ? `Claude Code is waiting for you ("${activity.waitingFor}").`
          : 'Claude Code is waiting for you.')
    }
  }
  // Acknowledging an error clears attention, not the terminal outcome being inspected.
  if (session.lastReply?.isError && !session.lastReply.newerTurnStarted) {
    const reason = (session.lastReply.errorCode ?? 'unknown error').replaceAll('_', ' ')
    return {
      kind: 'error',
      label: rowStatus(session).label,
      callout:
        session.key.tool === 'claude'
          ? `Claude Code stopped because of an API error (${reason}).`
          : `${toolName(session.key.tool)} ended the turn with an error.`
    }
  }
  if (activity.state === 'unknown') {
    const last = clockTime(session.summary.lastActivityAt)
    const name = toolName(session.key.tool)
    const descriptions = {
      'process-ended': `Claude Code's process for this session ended without reporting that the turn finished. Last activity ${last}.`,
      'app-not-running':
        session.key.tool === 'antigravity'
          ? `The last turn looks unfinished. AgentPeek couldn't confirm that Antigravity is running. Last activity ${last}.`
          : `The last turn looks unfinished, but the Codex app isn't running. Last activity ${last}.`,
      quiet: `The last turn looks unfinished, but ${name} hasn't written anything for ${quietMinutes(session.key.tool)} minutes. Last activity ${last}.`,
      unreadable: "AgentPeek couldn't read this session's file.",
      unsupported: `${name} ${session.summary.toolVersion ?? '(unknown version)'} writes this session in a format AgentPeek doesn't recognize.`
    }
    return {
      ...rowStatus({ ...session, attention: { waiting: false, newReply: false, error: false } }),
      callout: descriptions[activity.reason]
    }
  }
  return { kind: activity.state, label: activity.state === 'running' ? 'Running' : 'Idle' }
}
