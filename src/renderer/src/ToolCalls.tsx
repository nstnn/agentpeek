import type { JSX } from 'react'
import type { SessionMessage } from '../../core/session'
import { clockTime } from './detail-status'

export function ToolCalls({
  message
}: {
  message: Extract<SessionMessage, { kind: 'tool-calls' }>
}): JSX.Element {
  const label = `${message.count} tool ${message.count === 1 ? 'call' : 'calls'} · ${message.names.join(', ')}`
  if (!message.calls?.length) return <p className="tool-summary">{label}</p>
  return (
    <details className="tool-calls">
      <summary>{label}</summary>
      <div className="tool-call-list">
        {message.calls.map((call, index) => (
          <details className="tool-call" key={index}>
            <summary>
              <span className="tool-call-number">{index + 1}</span>
              <span className="tool-call-name">
                {call.nestedNames?.length ? call.nestedNames.join(', ') : call.name}
                {call.nestedNames !== null && (
                  <span className="tool-call-context">
                    {call.nestedNames.length ? `via ${call.name}` : 'Nested tool not identified'}
                  </span>
                )}
              </span>
              <time dateTime={new Date(call.at).toISOString()}>{clockTime(call.at)}</time>
            </summary>
            <div className="tool-call-input">
              {call.input === null ? (
                <p>Input is not available in this record.</p>
              ) : (
                <>
                  <p>Recorded input{call.input === '' ? ' (empty)' : ''}</p>
                  {call.inputLength > call.input.length && (
                    <p>
                      Showing the first {call.input.length.toLocaleString('en-US')} of{' '}
                      {call.inputLength.toLocaleString('en-US')} characters. Open Codex for the full
                      input.
                    </p>
                  )}
                  {call.input !== '' && (
                    <pre>
                      <code>{call.input}</code>
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
            Showing the first {message.calls.length} of {message.count} calls. Open Codex for the
            full group.
          </p>
        )}
      </div>
    </details>
  )
}
