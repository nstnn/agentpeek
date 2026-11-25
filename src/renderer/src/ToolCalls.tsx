import type { JSX } from 'react'
import type { SessionActivity, SessionMessage, ToolCallDetail } from '../../core/session'
import type { AgentTool } from '../../core/tools'
import { clockTime } from './detail-status'
import { toolAuthor } from './session-display'

type CallLabel = { text: string; kind: 'failed' | 'running' | 'waiting' | 'muted' }

/**
 * What a Claude call's status means right now. A call without a result is only shown as running
 * or waiting while the session is; otherwise it will not get one.
 */
function callLabel(call: ToolCallDetail, activity: SessionActivity['state']): CallLabel | null {
  switch (call.status) {
    case 'failed':
      return { text: 'Failed', kind: 'failed' }
    case 'interrupted':
      return { text: 'Interrupted', kind: 'muted' }
    case 'pending':
      if (activity === 'running') return { text: 'Running', kind: 'running' }
      if (activity === 'waiting') return { text: 'Waiting', kind: 'waiting' }
      return { text: 'No result', kind: 'muted' }
    case 'no-result':
      return { text: 'No result', kind: 'muted' }
    default:
      return null
  }
}

export function ToolCalls({
  message,
  tool,
  activity
}: {
  message: Extract<SessionMessage, { kind: 'tool-calls' }>
  tool: AgentTool
  activity: SessionActivity['state']
}): JSX.Element {
  const label = `${message.count} tool ${message.count === 1 ? 'call' : 'calls'} · ${message.names.join(', ')}`
  if (!message.calls?.length) return <p className="tool-summary">{label}</p>
  const author = toolAuthor(tool)
  const labels = message.calls.map((call) => callLabel(call, activity))
  // The group's summary counts the calls that need a look: failed, running, or waiting.
  const counts = (['failed', 'running', 'waiting'] as const)
    .map((kind) => ({ kind, count: labels.filter((item) => item?.kind === kind).length }))
    .filter(({ count }) => count > 0)
  return (
    <details className="tool-calls">
      <summary>
        {label}
        {counts.map(({ kind, count }) => (
          <span key={kind} className={`tool-call-status ${kind}`}>
            {' '}
            · {count} {kind}
          </span>
        ))}
      </summary>
      <div className="tool-call-list">
        {message.calls.map((call, index) => (
          <details className="tool-call" key={index}>
            <summary>
              <span className="tool-call-number">{index + 1}</span>
              {call.summary === undefined ? (
                <CodexCallName call={call} />
              ) : (
                <ClaudeCallName call={call} label={labels[index] ?? null} />
              )}
              <time dateTime={new Date(call.at).toISOString()}>{clockTime(call.at)}</time>
            </summary>
            <div className="tool-call-input">
              {call.error !== undefined && (
                <>
                  <p>Error</p>
                  <pre className="tool-call-error">
                    <code>{call.error}</code>
                  </pre>
                </>
              )}
              {call.input === null ? (
                <p>Input is not available in this record.</p>
              ) : (
                <>
                  <p>Recorded input{call.input === '' ? ' (empty)' : ''}</p>
                  {call.inputLength > call.input.length && (
                    <p>
                      Showing the first {call.input.length.toLocaleString('en-US')} of{' '}
                      {call.inputLength.toLocaleString('en-US')} characters. Open {author} for the
                      full input.
                    </p>
                  )}
                  {call.input !== '' && (
                    <pre>
                      <code>
                        {call.inputFormat === 'diff' ? diffLines(call.input) : call.input}
                      </code>
                    </pre>
                  )}
                </>
              )}
              {call.nestedNames !== null && (
                <p className="tool-call-note">
                  {call.nestedNames.length
                    ? 'Names detected from input; execution is not confirmed.'
                    : call.inputLength > (call.input?.length ?? 0)
                      ? 'Nested names are unavailable because the input is truncated.'
                      : 'This input does not identify a specific nested tool.'}
                </p>
              )}
            </div>
          </details>
        ))}
        {message.count > message.calls.length && (
          <p className="tool-call-limit">
            Showing the first {message.calls.length} of {message.count} calls. Open {author} for the
            full group.
          </p>
        )}
      </div>
    </details>
  )
}

function CodexCallName({ call }: { call: ToolCallDetail }): JSX.Element {
  return (
    <span className="tool-call-name">
      {call.nestedNames?.length ? call.nestedNames.join(', ') : call.name}
      {call.nestedNames !== null && (
        <span className="tool-call-context">
          {call.nestedNames.length ? `via ${call.name}` : 'Nested tool not identified'}
        </span>
      )}
    </span>
  )
}

/** The summary leads; the tool's name and the call's status follow on a second line. */
function ClaudeCallName({
  call,
  label
}: {
  call: ToolCallDetail
  label: CallLabel | null
}): JSX.Element {
  const status = label && <span className={`tool-call-status ${label.kind}`}>{label.text}</span>
  if (call.summary === null || call.summary === undefined) {
    return (
      <span className="tool-call-name">
        {call.name}
        {status && <span className="tool-call-context">{status}</span>}
      </span>
    )
  }
  return (
    <span className="tool-call-summary">
      {call.summary}
      <span className="tool-call-context">
        <span className="tool-call-tool">{call.name}</span>
        {status && <> · {status}</>}
      </span>
    </span>
  )
}

/** An edit's `-` and `+` lines, marked so removed and added text read apart. */
function diffLines(input: string): JSX.Element[] {
  return input.split('\n').map((line, index, lines) => (
    <span
      key={index}
      className={line.startsWith('+') ? 'diff-added' : line.startsWith('-') ? 'diff-removed' : ''}
    >
      {line}
      {index < lines.length - 1 ? '\n' : ''}
    </span>
  ))
}
