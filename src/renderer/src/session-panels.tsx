import { useLayoutEffect, useRef, type JSX } from 'react'
import type { AppSnapshot } from '../../shared/api'
import { AGENT_TOOLS } from '../../core/tools'
import type { ViewId } from '../../core/views'
import type { RendererState } from './sessions-store'
import { toolHome, toolName, VIEW_NAMES } from './session-display'
import { NavigationIcon } from './NavigationIcon'
import { SessionIcon } from './SessionIcon'
import { SettingsIcon } from './SettingsDialog'
import { usageDisplay, type UsageDisplay } from './usage-display'

export function Sidebar({
  snapshot,
  view,
  onView,
  collapsed = false,
  onToggle,
  controls,
  onSettings,
  now
}: {
  snapshot: AppSnapshot | null
  view: ViewId
  onView: (view: ViewId) => void
  collapsed?: boolean
  onToggle: () => void
  controls: string
  onSettings: () => void
  /** The clock for the usage footer's "Updated" and reset times. */
  now: number
}): JSX.Element {
  const views = ['active', 'inbox', 'pinned', 'all'] as const
  return (
    <aside
      className={`sidebar${collapsed ? ' sidebar-collapsed' : ''}`}
      aria-label="Session navigation and sources"
    >
      <div className="sidebar-content">
        <div className="sidebar-heading">
          <button
            type="button"
            className="navigation-toggle sidebar-heading-toggle"
            aria-label={collapsed ? 'Expand Views' : 'Collapse Views'}
            title={`${collapsed ? 'Expand' : 'Collapse'} navigation (⇧⌘B)`}
            aria-expanded={!collapsed}
            aria-controls={controls}
            aria-keyshortcuts="Meta+Shift+B"
            onClick={onToggle}
          >
            <NavigationIcon kind="views" />
          </button>
          <h2 className="sidebar-heading-text" aria-hidden={collapsed || undefined}>
            Sessions
          </h2>
        </div>
        <nav aria-label="Session views">
          {views.map((id) => {
            const count =
              id === 'active'
                ? (snapshot?.groupCounts.running ?? 0)
                : id === 'inbox'
                  ? snapshot
                    ? snapshot.groupCounts.errors + snapshot.groupCounts['new-replies']
                    : 0
                  : (snapshot?.groupCounts[id] ?? 0)
            const label = `${VIEW_NAMES[id]} ${count}`
            return (
              <button
                key={id}
                type="button"
                aria-label={label}
                title={
                  id === 'active'
                    ? `${count} running ${count === 1 ? 'session' : 'sessions'} across both tools.`
                    : id === 'inbox'
                      ? `${label}. Unread replies and errors across both tools.`
                      : label
                }
                aria-current={view === id ? 'page' : undefined}
                tabIndex={view === id ? 0 : -1}
                onClick={() => onView(id)}
                onKeyDown={(event) => {
                  if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) return
                  event.preventDefault()
                  const index =
                    event.key === 'Home'
                      ? 0
                      : event.key === 'End'
                        ? views.length - 1
                        : (views.indexOf(id) + (event.key === 'ArrowDown' ? 1 : views.length - 1)) %
                          views.length
                  onView(views[index]!)
                  event.currentTarget.parentElement?.querySelectorAll('button')[index]?.focus()
                }}
              >
                {id === 'pinned' ? (
                  <SessionIcon kind="pin" />
                ) : (
                  <NavigationIcon kind={id === 'active' || id === 'inbox' ? id : 'all'} />
                )}
                <span className="sidebar-view-label" aria-hidden="true">
                  {VIEW_NAMES[id]}
                </span>
                {(!collapsed || ((id === 'active' || id === 'inbox') && count > 0)) && (
                  <span
                    aria-hidden="true"
                    className={(id === 'inbox' && count > 0) || collapsed ? 'badge' : 'count'}
                  >
                    {count > 99 && collapsed ? '99+' : count}
                  </span>
                )}
              </button>
            )
          })}
        </nav>
      </div>
      <div className="sidebar-footer">
        <div className="connected-sources" aria-label="Connected sources">
          {AGENT_TOOLS.filter((tool) => snapshot?.health[tool].state === 'connected').map(
            (tool) => {
              const limits = snapshot?.usageLimits?.[tool] ?? null
              const usage = limits === null ? null : usageDisplay(limits, now)
              return (
                <button
                  key={tool}
                  type="button"
                  className={`connected-source${usage ? ' has-usage' : ''}`}
                  aria-label={`${toolName(tool)} source: Connected`}
                  // The name stays fixed; the figures, which change with time, are its description.
                  aria-description={usage?.summary}
                  title={`${toolName(tool)} connected${usage ? `\n${usage.summary}` : ''}\nManage in Settings`}
                  onClick={onSettings}
                >
                  <span className="connected-source-name">
                    <span className="health-dot connected" aria-hidden="true" />
                    {collapsed ? (
                      <span className="source-monogram" aria-hidden="true">
                        {tool === 'codex' ? 'C' : 'A'}
                      </span>
                    ) : (
                      <span>{toolName(tool)}</span>
                    )}
                  </span>
                  {usage && <UsageMeters usage={usage} compact={collapsed} />}
                </button>
              )
            }
          )}
          {!AGENT_TOOLS.some((tool) => snapshot?.health[tool].state === 'connected') && (
            <p className={collapsed ? 'sr-only' : 'sources-empty'}>No sources connected</p>
          )}
        </div>
        <button
          type="button"
          className="sidebar-settings"
          aria-label="Settings"
          title="Settings (⌘,)"
          aria-haspopup="dialog"
          onClick={onSettings}
        >
          <SettingsIcon />
          <span className="sidebar-view-label" aria-hidden="true">
            Settings
          </span>
        </button>
      </div>
    </aside>
  )
}

/** The usage meters under a connected source. The button's description carries the same figures. */
function UsageMeters({ usage, compact }: { usage: UsageDisplay; compact: boolean }): JSX.Element {
  if (compact) {
    // The collapsed sidebar has room for the shortest window's bar only.
    const meter = usage.meters[0]!
    return (
      <span className="usage-meters compact" aria-hidden="true">
        <UsageBar percent={meter.percent} level={meter.level} />
      </span>
    )
  }
  return (
    <span className="usage-meters" aria-hidden="true">
      {usage.meters.map((meter) => (
        <span key={meter.label} className="usage-meter">
          <span className="usage-meter-label">
            <span>{meter.label}</span>
            <span className={`usage-value ${meter.level}`}>{meter.value}</span>
          </span>
          <UsageBar percent={meter.percent} level={meter.level} />
        </span>
      ))}
      {usage.note !== null && <span className="usage-note">{usage.note}</span>}
    </span>
  )
}

function UsageBar({
  percent,
  level
}: {
  percent: number | null
  level: 'normal' | 'high' | 'reached'
}): JSX.Element {
  return (
    <span className="usage-bar">
      <span className={`usage-fill ${level}`} style={{ width: `${percent ?? 0}%` }} />
    </span>
  )
}

export function ReloadSessions({
  pending,
  onReload
}: {
  pending: boolean
  onReload: () => Promise<void>
}): JSX.Element {
  const button = useRef<HTMLButtonElement>(null)
  useLayoutEffect(
    () => () => {
      if (document.activeElement !== button.current) return
      // Source recovery may arrive after reload() completes. Restore focus when its control
      // actually leaves the page, without stealing focus from a later user selection.
      queueMicrotask(() => {
        if (document.activeElement !== document.body) return
        const target =
          document.querySelector<HTMLElement>('.detail-pane:not([hidden]) .transcript') ??
          document.querySelector<HTMLElement>('.list-scroll:not([hidden])')
        target?.focus({ preventScroll: true })
      })
    },
    []
  )
  return (
    <button
      ref={button}
      type="button"
      aria-label="Reload Sessions"
      aria-disabled={pending}
      onClick={() => {
        if (pending) return
        void onReload()
      }}
    >
      {pending ? 'Reloading…' : 'Reload Sessions'}
    </button>
  )
}

export function SessionBanners({
  snapshot,
  reloadPending,
  reloadError,
  onReload
}: {
  snapshot: AppSnapshot | null
  reloadPending: boolean
  reloadError: string | null
  onReload: () => Promise<void>
}): JSX.Element {
  return (
    <>
      {snapshot?.fixture && (
        <p className="banner fixture-banner">
          Fixture data · AgentPeek is showing synthetic sessions from {snapshot.fixtureHome}, not
          your real sessions.
        </p>
      )}
      {snapshot?.localState.kind === 'unavailable' && (
        <p className="banner warning">
          Pins and read markers won't be saved.{' '}
          {snapshot.localState.reason === 'unwritable' ? (
            "AgentPeek can't save its state file."
          ) : (
            <>
              AgentPeek's saved state{' '}
              {snapshot.localState.reason === 'newer-version'
                ? 'was made by a newer version'
                : "can't be read"}
              , so it was left unchanged.
            </>
          )}{' '}
          Changes you make now last until you quit.
        </p>
      )}
      {AGENT_TOOLS.map((tool) => {
        const health = snapshot?.health[tool]
        if (health?.state === 'no-access')
          return (
            <div className="banner warning source-warning" key={tool}>
              <span>
                Can't read {toolName(tool)} files. AgentPeek doesn't have permission to read{' '}
                {toolHome(tool)}. It only reads these files and never changes them.
              </span>{' '}
              <ReloadSessions pending={reloadPending} onReload={onReload} />
            </div>
          )
        if (health?.state === 'unsupported')
          return (
            <p className="banner warning" key={tool}>
              {toolName(tool)} {health.toolVersion ?? '(unknown version)'} writes its files in a
              format AgentPeek doesn't recognize. Its sessions show as Unknown.
            </p>
          )
        return null
      })}
      {reloadError && (
        <p className="banner warning" role="status">
          {reloadError}
        </p>
      )}
    </>
  )
}

export function EmptyList({
  state,
  unfilteredCount,
  onShowAll,
  onClearFilter,
  onSettings
}: {
  state: RendererState
  unfilteredCount: number
  onShowAll: () => void
  onClearFilter: () => void
  onSettings: () => void
}): JSX.Element {
  const { snapshot, view, filter } = state
  let title: string
  let body: string
  let action: { label: string; onClick: () => void } | undefined
  const health = filter === 'all' ? null : snapshot?.health[filter]
  const checking =
    !snapshot || AGENT_TOOLS.every((tool) => snapshot.health[tool].state === 'checking')
  if (state.failed && !snapshot) {
    title = "Couldn't load sessions"
    body = 'Choose View > Reload Sessions to try again.'
  } else if (checking || health?.state === 'checking') {
    title = 'Reading sessions…'
    body = 'Checking Codex and Claude Code files on this Mac. AgentPeek only reads them.'
  } else if (
    health?.state === 'off' ||
    (snapshot && AGENT_TOOLS.every((tool) => snapshot.health[tool].state === 'off'))
  ) {
    title =
      health?.state === 'off' && filter !== 'all'
        ? `${toolName(filter)} monitoring is off`
        : 'Monitoring is off'
    body = 'Turn on a source in Settings to see its sessions.'
    action = { label: 'Open Settings', onClick: onSettings }
  } else if (filter !== 'all' && health?.state === 'not-installed') {
    title = `${toolName(filter)} isn't installed`
    body = `AgentPeek looks for ${toolName(filter)} files in ${toolHome(filter)}. If you install ${toolName(filter)}, choose View > Reload Sessions.`
  } else if (filter !== 'all' && health?.state === 'no-access') {
    title = `Can't read ${toolName(filter)} files`
    body = `AgentPeek doesn't have permission to read ${toolHome(filter)}. It only reads these files and never changes them. Choose View > Reload Sessions to try again.`
  } else if (filter !== 'all' && health?.state === 'unsupported') {
    title = 'Unsupported format'
    body = `${toolName(filter)} ${health.toolVersion ?? '(unknown version)'} writes its files in a format AgentPeek doesn't recognize. Its sessions show as Unknown.`
  } else if (filter !== 'all' && unfilteredCount > 0) {
    const scope =
      view === 'pinned'
        ? 'pinned '
        : view === 'active'
          ? 'running '
          : view === 'inbox'
            ? 'inbox '
            : ''
    title = `No ${scope}${toolName(filter)} sessions`
    body = `This view has sessions from other tools. Show all ${scope}sessions to see them.`
    action = {
      label:
        view === 'pinned'
          ? 'Show All Pinned'
          : view === 'active'
            ? 'Show All Active'
            : view === 'inbox'
              ? 'Show All Inbox'
              : 'Show All Sessions',
      onClick: onClearFilter
    }
  } else if (view === 'pinned') {
    title = 'No pinned sessions'
    body = 'Pin a session to keep it here (⇧⌘P).'
    action = { label: 'Browse All Sessions', onClick: onShowAll }
  } else if (view === 'all' || snapshot?.sessions.length === 0) {
    title = filter === 'all' ? 'No sessions yet' : `No ${toolName(filter)} sessions yet`
    body = `Start a conversation in ${filter === 'all' ? 'Codex or Claude Code' : toolName(filter)} and it will show up here. AgentPeek lists sessions from the last 7 days.`
  } else {
    title = view === 'active' ? 'No running sessions' : 'Inbox is clear'
    body =
      view === 'active'
        ? 'Finished sessions with unread results appear in Inbox.'
        : 'No unread replies or errors.'
    action = { label: 'Show All Sessions', onClick: onShowAll }
  }
  return (
    <div className="empty-list">
      <h2>{title}</h2>
      <p>{body}</p>
      {action && (
        <button type="button" onClick={action.onClick}>
          {action.label}
        </button>
      )}
    </div>
  )
}
