import type { ViewerData } from './connection'
import { listView, sourceLines, VIEW_NAMES, type ListChoices, type ViewId } from './status-view'

// The left column, like the desktop window's sidebar: the Sessions views with their counts, and
// the sources at the bottom. From 960 px it is always shown; below that it opens over the list
// from the header's menu button and closes on a choice, the backdrop or Escape. Choosing a view
// is page state only.

export interface SidebarProps {
  id: string
  data: ViewerData | null
  choices: ListChoices
  onView: (view: ViewId) => void
  /** Below 960 px: whether the menu is open. */
  open: boolean
  onClose: () => void
}

const VIEWS: readonly ViewId[] = ['active', 'all']

export function Sidebar({ id, data, choices, onView, open, onClose }: SidebarProps) {
  const status = data?.frame.status ?? null
  const counts = status ? listView(status, choices) : null
  return (
    <>
      <aside
        id={id}
        className={open ? 'sidebar open' : 'sidebar closed'}
        aria-label="Session views and sources"
        onKeyDown={(event) => {
          if (event.key === 'Escape' && open) onClose()
        }}
      >
        <p className="sidebar-heading">Sessions</p>
        <nav aria-label="Session views">
          {VIEWS.map((view) => {
            const count = view === 'active' ? (counts?.needsAttention ?? 0) : (counts?.total ?? 0)
            return (
              <button
                key={view}
                type="button"
                className="sidebar-view"
                aria-current={choices.view === view ? 'page' : undefined}
                onClick={() => {
                  onView(view)
                  if (open) onClose()
                }}
              >
                <span>{VIEW_NAMES[view]}</span>
                {counts && (view === 'all' || count > 0) && (
                  <span className={view === 'active' ? 'badge' : 'count'}>{count}</span>
                )}
              </button>
            )
          })}
        </nav>
        {status && (
          <ul className="sources" aria-label="Sources on the Mac">
            {sourceLines(status.sources).map((source) => (
              <li key={source.tool} className={`source source-${source.state}`}>
                <span className="source-name">{source.name}</span>
                <span className="source-state">{source.text}</span>
              </li>
            ))}
          </ul>
        )}
      </aside>
      {open && (
        <button
          type="button"
          className="sidebar-backdrop"
          aria-label="Close views"
          tabIndex={-1}
          onClick={onClose}
        />
      )}
    </>
  )
}
