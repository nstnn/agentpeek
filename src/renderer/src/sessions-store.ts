import { sessionKeyToString, type Session, type SessionKey } from '../../core/session'
import { buildView, type SessionGroup, type ToolFilter, type ViewId } from '../../core/views'
import type { AgentPeekApi, AppSnapshot } from '../../shared/api'

interface Selection {
  session: Session
  group: SessionGroup['id']
  index: number
  /** Snapshot observation only; never a claim that the source file was freshly read. */
  lastSeenAt: number | null
  sourceEpoch: number
}
export interface RendererState {
  snapshot: AppSnapshot | null
  failed: boolean
  view: ViewId
  filter: ToolFilter
  selection: Selection | null
  actionError: string | null
  narrow: boolean
  detailOpen: boolean
  reloadPending: boolean
  reloadError: string | null
  reloadVersion: number
}

/** One subscription pair per mounted app. A pushed snapshot always wins over the initial request. */
export function createSessionsStore(api: AgentPeekApi) {
  let state: RendererState = {
    snapshot: null,
    failed: false,
    view: 'active',
    filter: 'all',
    selection: null,
    actionError: null,
    narrow: false,
    detailOpen: false,
    reloadPending: false,
    reloadError: null,
    reloadVersion: 0
  }
  const listeners = new Set<() => void>()
  let disconnect: (() => void) | null = null
  const emit = (change: Partial<RendererState>) => {
    state = { ...state, ...change }
    for (const listener of listeners) listener()
  }
  const sendSelection = (key: SessionKey | null) => {
    void api
      .setSelection(key)
      .catch(() => emit({ actionError: "Couldn't select session. Try again." }))
  }
  const clearSelection = () => {
    sendSelection(null)
    return null
  }
  const sendDetailOpen = (open: boolean) => {
    void api
      .setDetailOpen(open)
      .catch(() => emit({ actionError: "Couldn't update Back. Try again." }))
  }
  const store = {
    getSnapshot: () => state,
    subscribe(this: void, listener: () => void) {
      listeners.add(listener)
      if (!disconnect) {
        let active = true
        let received = false
        const receive = (snapshot: AppSnapshot) => {
          received = true
          if (!active) return
          const selected = state.selection
          const current =
            selected && snapshot.sessions.find((s) => sameKey(s.key, selected.session.key))
          if (current && !state.snapshot?.sessions.some((s) => sameKey(s.key, current.key))) {
            sendSelection(current.key)
          }
          emit({
            snapshot,
            failed: false,
            selection: selected
              ? {
                  ...selected,
                  session: current ?? selected.session,
                  lastSeenAt: current ? snapshot.takenAt : selected.lastSeenAt,
                  sourceEpoch:
                    selected.sourceEpoch +
                    (Boolean(current) !==
                    Boolean(
                      state.snapshot?.sessions.some((s) => sameKey(s.key, selected.session.key))
                    )
                      ? 1
                      : 0)
                }
              : null
          })
        }
        const offSnapshot = api.onSnapshot(receive)
        const offCommand = api.onCommand((command) => {
          if (command.startsWith('view:')) store.setView(command.slice(5) as ViewId)
          if (command === 'back') store.back()
        })
        void api
          .getSnapshot()
          .then((snapshot) => {
            if (!received) receive(snapshot)
          })
          .catch(() => {
            if (active && !received) emit({ failed: true })
          })
        disconnect = () => {
          active = false
          offSnapshot()
          offCommand()
        }
      }
      return () => {
        listeners.delete(listener)
        if (listeners.size === 0) {
          disconnect?.()
          disconnect = null
        }
      }
    },
    setView(this: void, view: ViewId) {
      sendDetailOpen(false)
      emit({ view, selection: clearSelection(), detailOpen: false, actionError: null })
    },
    setFilter(this: void, filter: ToolFilter) {
      sendDetailOpen(false)
      emit({ filter, selection: clearSelection(), detailOpen: false, actionError: null })
    },
    setNarrow(this: void, narrow: boolean) {
      if (state.narrow === narrow) return
      sendDetailOpen(false)
      emit({ narrow, detailOpen: false })
    },
    activate(this: void, session: Session, groups: SessionGroup[]) {
      store.select(session, groups)
      if (state.narrow) {
        emit({ detailOpen: true })
        sendDetailOpen(true)
      }
    },
    back(this: void) {
      if (!state.detailOpen) return
      emit({ detailOpen: false })
      sendDetailOpen(false)
    },
    async reload(this: void) {
      if (state.reloadPending) return
      emit({ reloadPending: true, reloadError: null })
      let timer: ReturnType<typeof setTimeout> | undefined
      try {
        await Promise.race([
          api.reload(),
          new Promise<never>((_, reject) => {
            timer = setTimeout(() => reject(new Error('reload timeout')), 10_000)
          })
        ])
        // Only snapshots restore membership. Completion merely retries the current transcript.
        emit({ reloadVersion: state.reloadVersion + 1 })
      } catch {
        emit({ reloadError: "Couldn't reload sessions. Check source access, then try again." })
      } finally {
        clearTimeout(timer)
        emit({ reloadPending: false })
      }
    },
    select(this: void, session: Session, groups: SessionGroup[]) {
      if (state.selection && sameKey(state.selection.session.key, session.key)) return
      const group = groups.find((g) => g.sessions.some((s) => sameKey(s.key, session.key)))
      if (!group) return
      emit({
        selection: {
          session,
          group: group.id,
          index: group.sessions.findIndex((s) => sameKey(s.key, session.key)),
          lastSeenAt: state.snapshot?.sessions.some((s) => sameKey(s.key, session.key))
            ? state.snapshot.takenAt
            : null,
          sourceEpoch: 0
        },
        actionError: null
      })
      sendSelection(session.key)
    },
    reportActionError(this: void) {
      emit({ actionError: "Couldn't open the session menu. Try again." })
    }
  }
  return store
}
export type SessionsStore = ReturnType<typeof createSessionsStore>
export const sameKey = (a: SessionKey, b: SessionKey): boolean =>
  sessionKeyToString(a) === sessionKeyToString(b)

/** Keep the selected row's group and slot, even if it leaves the view or source. Counts stay live. */
export function displayedGroups(state: RendererState): SessionGroup[] {
  const groups = buildView(state.snapshot?.sessions ?? [], state.view, state.filter).groups
  const anchor = state.selection
  if (!anchor) return groups
  for (const group of groups)
    group.sessions = group.sessions.filter((s) => !sameKey(s.key, anchor.session.key))
  let group = groups.find((g) => g.id === anchor.group)
  if (!group) {
    group = { id: anchor.group, sessions: [] }
    const order = ['waiting', 'errors', 'new-replies', 'running', 'unknown', 'pinned', 'all']
    const index = groups.findIndex((g) => order.indexOf(g.id) > order.indexOf(anchor.group))
    groups.splice(index < 0 ? groups.length : index, 0, group)
  }
  group.sessions.splice(Math.min(anchor.index, group.sessions.length), 0, anchor.session)
  return groups.filter((g) => g.sessions.length > 0)
}
