import type { JSX } from 'react'

/** Small local vector marks for navigation; no remote assets. */
export function NavigationIcon({
  kind
}: {
  kind: 'views' | 'sessions' | 'active' | 'inbox' | 'all'
}): JSX.Element {
  return (
    <svg
      className="navigation-icon"
      viewBox="0 0 20 20"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      aria-hidden="true"
    >
      {kind === 'views' || kind === 'sessions' ? (
        <>
          <rect x="2.5" y="3" width="15" height="14" rx="2" />
          <path d={kind === 'views' ? 'M7 3v14' : 'M11 3v14M5 7h3M5 10h3M5 13h3'} />
        </>
      ) : kind === 'active' ? (
        <>
          <circle cx="10" cy="10" r="7.5" />
          <path d="m8 6.5 5 3.5-5 3.5Z" />
        </>
      ) : kind === 'inbox' ? (
        <path d="m2.5 11 3-7h9l3 7v5h-15Zm0 0h5l1.5 2h2l1.5-2h5" />
      ) : (
        <>
          <path d="M7 5h10M7 10h10M7 15h10" />
          <path d="M3 5h1M3 10h1M3 15h1" />
        </>
      )}
    </svg>
  )
}
