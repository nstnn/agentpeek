import { useEffect, useState } from 'react'
import type { SessionKey } from '../../core/session'
import type { AgentPeekApi } from '../../shared/api'
import type { RemoteStatusView } from '../../shared/remote-settings'

// Remote View outside Settings (TASK-042, UX contract Q3 A): the sidebar shows when the listener
// runs, and the session detail shows the alias the viewer uses while titles are hidden. The main
// process decides both; the renderer only follows its status and asks for one alias at a time.

export type Busy = 'enabling' | 'disabling' | 'saving' | 'sharing' | 'titles' | 'retrying'
export interface Notice {
  tone: 'info' | 'warning' | 'error'
  text: string
}

export const plural = (count: number, one: string, many: string) =>
  `${count} ${count === 1 ? one : many}`
export const projects = (count: number) => plural(count, 'project', 'projects')

/** The Settings status line (UX contract state table), also the sidebar label's tooltip. */
export function statusLine(status: RemoteStatusView | null, busy: Busy | null): Notice {
  if (status === null || status.state === 'loading')
    return { tone: 'info', text: 'Loading Remote View settings…' }
  if (status.state === 'load-failed')
    return { tone: 'error', text: "Couldn't load Remote View settings. Remote View stays off." }
  const { port, ownerLogin, hostName, sharedWorkspaces } = status.settings
  if (busy === 'enabling' || (status.pending && status.requestedEnabled && status.state === 'off'))
    return { tone: 'info', text: `Starting on port ${port}…` }
  if (busy === 'disabling') return { tone: 'info', text: 'Turning off…' }
  if (status.state === 'on') {
    const count = sharedWorkspaces.length
    // A viewer page replaces the one-time resume notice (UX contract: first status only).
    if (status.streams > 0)
      return {
        tone: 'info',
        text: `On, port ${port}. ${plural(status.streams, 'viewer page', 'viewer pages')} open.`
      }
    if (status.resumed)
      return {
        tone: 'info',
        text: `On, port ${port}. Turned on again because it was on when AgentPeek quit.`
      }
    return {
      tone: 'info',
      text:
        count === 0
          ? `On, port ${port}. No projects shared yet, so the page shows an empty list.`
          : `On, port ${port}. Sharing ${projects(count)}.`
    }
  }
  if (status.startError === 'port-in-use')
    return {
      tone: 'error',
      text: `Port ${port} is already used by another app. Choose another port, save, and turn Remote View on again.`
    }
  if (status.startError === 'start-failed')
    return { tone: 'error', text: "Couldn't start Remote View. Try again." }
  if (ownerLogin === '' || hostName === '')
    return {
      tone: 'info',
      text: 'Add your Tailscale login and Mac address to turn on Remote View.'
    }
  return { tone: 'info', text: 'Off. Nothing is shared.' }
}

/** The live status: read once, then every change the main process announces. */
export function useRemoteStatus(api: AgentPeekApi): RemoteStatusView | null {
  const [status, setStatus] = useState<RemoteStatusView | null>(null)
  useEffect(() => {
    let active = true
    let pushed = false
    const unsubscribe = api.onRemoteStatus((next) => {
      pushed = true
      if (active) setStatus(next)
    })
    // A change announced while the first read is in flight is newer than its answer.
    void api.getRemoteStatus().then(
      (next) => {
        if (active && !pushed) setStatus(next)
      },
      () => undefined
    )
    return () => {
      active = false
      unsubscribe()
    }
  }, [api])
  return status
}

/** Whether the viewer could show an alias at all: on, with titles hidden. */
export function showsAliases(status: RemoteStatusView | null): boolean {
  return status?.state === 'on' && !status.settings.shareTitles
}

/**
 * The viewer's alias for `key`, asked again whenever the status or the session list (`revision`)
 * changes, since both can renumber aliases. Null at once when no alias can apply, so an old one is
 * never shown after Remote View turns off or titles are shared.
 */
export function useRemoteAlias(
  api: AgentPeekApi,
  key: SessionKey,
  status: RemoteStatusView | null,
  revision: unknown
): string | null {
  const [alias, setAlias] = useState<{ status: RemoteStatusView; alias: string | null } | null>(
    null
  )
  const applies = showsAliases(status)
  const { tool, id } = key
  useEffect(() => {
    if (!applies || status === null) return
    let active = true
    void api.getRemoteAlias({ tool, id }).then(
      (next) => {
        if (active) setAlias({ status, alias: next })
      },
      () => {
        if (active) setAlias({ status, alias: null })
      }
    )
    return () => {
      active = false
    }
  }, [api, tool, id, applies, status, revision])
  // An answer for an older status may come from an older listener, whose aliases are void.
  return applies && alias?.status === status ? alias.alias : null
}
