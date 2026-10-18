import type { JSX } from 'react'

/** Local vector marks stay sharp in both themes and never load an external resource. */
export function SessionIcon({ kind }: { kind: string }): JSX.Element {
  return (
    <svg
      className="session-icon"
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.4"
      aria-hidden="true"
    >
      {kind === 'waiting' ? (
        <path d="M5.5 3v10M10.5 3v10" />
      ) : kind === 'error' ? (
        <>
          <path d="M8 2 15 14H1Z" />
          <path d="M8 6v4m0 1.5v1" />
        </>
      ) : kind === 'reply' ? (
        <path d="M2 3h12v8H7l-4 3v-3H2Z" />
      ) : kind === 'pin' ? (
        <>
          <path d="m6 2 7 7-2 1-3-1-2 3-2-2 3-2-1-3Z" />
          <path d="m5 11-3 3" />
        </>
      ) : kind === 'unknown' ? (
        <>
          <circle cx="8" cy="8" r="6" strokeDasharray="2 1.5" />
          <path d="M6.5 6a1.5 1.5 0 0 1 3 0c0 1-1.5 1.2-1.5 2.5M8 10v1" />
        </>
      ) : (
        <circle
          cx="8"
          cy="8"
          r={kind === 'idle' ? 2 : 5.5}
          fill={kind === 'idle' ? 'currentColor' : 'none'}
        />
      )}
    </svg>
  )
}
