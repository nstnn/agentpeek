import { sessionKeyToString, type Session, type SessionKey } from '../../core/session'
import { buildView, type SessionGroup, type ToolFilter, type ViewId } from '../../core/views'
import type { AgentPeekApi, AppSnapshot } from '../../shared/api'

export type PaneId = 'main' | 'second'

export interface Selection {
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
  secondarySelection: Selection | null
  /** Null while browsing; source loss retains the pane identity, not a valid action target. */
  activePane: PaneId | null
  targetGeneration: number
  targetReady: boolean
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
    secondarySelection: null,
    activePane: null,
    targetGeneration: 0,
    targetReady: false,
    actionError: null,
    narrow: false,
    detailOpen: false,
    reloadPending: false,
    reloadError: null,
    reloadVersion: 0
  }
  const listeners = new Set<() => void>()
  let disconnect: (() => void) | null = null
  // The single-pane renderer presents only Main. The split composition will publish both.
  let visiblePanes: readonly PaneId[] = ['main']
  let targetSignature = ''
  const targetKey = (): SessionKey | null => {
    if (!state.activePane || !visiblePanes.includes(state.activePane)) return null
    if (state.narrow && !state.detailOpen) return null
    const selected = state.activePane === 'main' ? state.selection : state.secondarySelection
    return (
      state.snapshot?.sessions.find((s) => selected && sameKey(s.key, selected.session.key))?.key ??
      null
    )
  }
  const emit = (change: Partial<RendererState>) => {
    state = { ...state, ...change }
    const key = targetKey()
    const selected = state.activePane === 'main' ? state.selection : state.secondarySelection
    const signature = JSON.stringify([
      state.activePane,
      key,
      selected?.sourceEpoch,
      visiblePanes,
      !!state.secondarySelection
    ])
    if (signature !== targetSignature) {
      targetSignature = signature
      const generation = state.targetGeneration + 1
      state = { ...state, targetGeneration: generation, targetReady: false }
      void api.setSelection(key, { secondPaneOpen: !!state.secondarySelection }).then(
        () => {
          if (generation === state.targetGeneration) emit({ targetReady: key !== null })
        },
        () => {
          if (generation === state.targetGeneration)
            emit({ actionError: "Couldn't select session. Try again." })
        }
      )
    }
    for (const listener of listeners) listener()
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
          const selection = reconcileSelection(state.selection, state.snapshot, snapshot)
          emit({
            snapshot,
            failed: false,
            selection,
            secondarySelection: reconcileSelection(
              state.secondarySelection,
              state.snapshot,
              snapshot
            )
          })
        }
        const offSnapshot = api.onSnapshot(receive)
        const offCommand = api.onCommand((command) => {
          if (typeof command === 'string') {
            if (command.startsWith('view:')) store.setView(command.slice(5) as ViewId)
            if (command === 'back') store.back()
          } else if (command.type === 'open-secondary') store.openSecondary(command.key)
          else if (command.type === 'close-secondary') store.closeSecondary()
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
          state = { ...state, targetGeneration: state.targetGeneration + 1, targetReady: false }
          targetSignature = ''
          void api.setSelection(null, { secondPaneOpen: false }).catch(() => undefined)
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
      emit({
        view,
        selection: null,
        activePane: null,
        detailOpen: false,
        actionError: null
      })
    },
    setFilter(this: void, filter: ToolFilter) {
      sendDetailOpen(false)
      emit({
        filter,
        selection: null,
        activePane: null,
        detailOpen: false,
        actionError: null
      })
    },
    setNarrow(this: void, narrow: boolean) {
      if (state.narrow === narrow) return
      // Split reading/browse intent survives resizing; its layout is wired in the renderer card.
      if (state.secondarySelection) {
        emit({ narrow, detailOpen: narrow && state.activePane !== null })
        sendDetailOpen(state.detailOpen)
        return
      }
      sendDetailOpen(false)
      emit({ narrow, detailOpen: false, activePane: !narrow && state.selection ? 'main' : null })
    },
    activate(this: void, session: Session, groups: SessionGroup[]) {
      store.select(session, groups)
      if (!state.selection || !sameKey(state.selection.session.key, session.key)) return
      if (state.narrow) {
        emit({ detailOpen: true, activePane: 'main' })
        sendDetailOpen(true)
      } else if (state.activePane !== 'main') {
        emit({ activePane: 'main' })
      }
    },
    back(this: void) {
      if (!state.detailOpen) return
      emit({ detailOpen: false, activePane: null })
      sendDetailOpen(false)
    },
    // Placement is available through native commands; visual composition follows in card 3.
    openSecondary(this: void, key: SessionKey) {
      const snapshot = state.snapshot
      if (!snapshot) return
      const index = snapshot.sessions.findIndex((s) => sameKey(s.key, key))
      const session = snapshot.sessions[index]
      if (!session) return
      const existing = state.secondarySelection
      emit({
        secondarySelection:
          existing && sameKey(existing.session.key, key)
            ? existing
            : { session, group: 'all', index, lastSeenAt: snapshot.takenAt, sourceEpoch: 0 },
        activePane: 'second',
        detailOpen: state.narrow || state.detailOpen,
        actionError: null
      })
      sendDetailOpen(state.detailOpen)
    },
    closeSecondary(this: void) {
      if (!state.secondarySelection) return
      emit({
        secondarySelection: null,
        activePane: state.selection && (!state.narrow || state.detailOpen) ? 'main' : null,
        detailOpen: !!state.selection && state.detailOpen
      })
      sendDetailOpen(state.detailOpen)
    },
    activatePane(this: void, pane: PaneId) {
      if (!(pane === 'main' ? state.selection : state.secondarySelection)) return
      emit({ activePane: pane, detailOpen: state.narrow || state.detailOpen })
      sendDetailOpen(state.detailOpen)
    },
    setVisiblePanes(this: void, panes: readonly PaneId[]) {
      if (visiblePanes.join() === panes.join()) return
      visiblePanes = [...panes]
      emit({})
    },
    canAutoRead(this: void, pane: PaneId, key: SessionKey, generation: number): boolean {
      const target = targetKey()
      return (
        state.targetReady &&
        state.targetGeneration === generation &&
        state.activePane === pane &&
        target !== null &&
        sameKey(target, key)
      )
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
      const browsingSplit = state.secondarySelection && state.activePane === null
      const activePane = !browsingSplit && (!state.narrow || state.detailOpen) ? 'main' : null
      if (state.selection && sameKey(state.selection.session.key, session.key)) {
        if (!state.targetReady) targetSignature = ''
        emit({ activePane })
        return
      }
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
        activePane,
        actionError: null
      })
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

function reconcileSelection(
  selected: Selection | null,
  previous: AppSnapshot | null,
  snapshot: AppSnapshot
): Selection | null {
  if (!selected) return null
  const current = snapshot.sessions.find((s) => sameKey(s.key, selected.session.key))
  const wasPresent = previous?.sessions.some((s) => sameKey(s.key, selected.session.key)) ?? false
  return {
    ...selected,
    session: current ?? selected.session,
    lastSeenAt: current ? snapshot.takenAt : selected.lastSeenAt,
    sourceEpoch: selected.sourceEpoch + (Boolean(current) !== wasPresent ? 1 : 0)
  }
}

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
