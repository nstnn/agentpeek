import { act, fireEvent, render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it } from 'vitest'
import type { Session } from '../../core/session'
import { fakeApi, NOW, session, snapshot } from '../test-support'
import { mockWorkspaceWidth } from '../workspace-test-support'
import { App } from './App'
import { buildListGroups } from './list-groups'
import { createSessionsStore, displayedGroups } from './sessions-store'

const projectSession = (id: string, path: string | null, change: Partial<Session> = {}) =>
  session(id, {
    ...change,
    summary: { ...session(id).summary, workspacePath: path, ...change.summary }
  })
const row = (id: string) => screen.getByRole('treeitem', { name: new RegExp(`^Synthetic ${id},`) })
const header = (path: string) => screen.getByRole('treeitem', { name: new RegExp(`^${path},`) })
function mount(sessions: Session[], width = 1440) {
  const resize = mockWorkspaceWidth(width)
  const fake = fakeApi(snapshot(sessions))
  Object.defineProperty(window, 'agentpeek', { value: fake.api, configurable: true })
  const store = createSessionsStore(fake.api)
  render(<App store={store} />)
  return { ...fake, store, resize }
}
const clickHeader = async (name: string) => {
  // Click the visible disclosure, rather than a parent whose bounds include its children.
  await userEvent.click(within(header(name)).getByText(name, { selector: '.project-name' }))
}

describe('project grouping', () => {
  it('combines dated Codex chat folders with missing paths without changing session metadata', () => {
    const a = projectSession('a', '/Users/synthetic/Documents/Codex/2026-10-24/chat-a')
    const b = projectSession('b', '/Users/synthetic/Documents/Codex/2026-10-25/chat-b///', {
      pinned: true
    })
    const none = projectSession('none', null)
    const groups = buildListGroups([a, b, none], 'all', 'all', 'project')
    expect(groups).toHaveLength(1)
    expect(groups[0]).toMatchObject({ id: 'project:', label: 'No folder', projectPath: null })
    expect(groups[0]?.sessions).toEqual([b, a, none])
    expect(a.summary.workspacePath).toBe('/Users/synthetic/Documents/Codex/2026-10-24/chat-a')
    expect(buildListGroups([a, b], 'pinned', 'codex', 'project')[0]?.sessions).toEqual([b])
    expect(buildListGroups([a, b], 'all', 'claude', 'project')).toEqual([])
    expect(buildListGroups([a, b], 'all', 'all', 'status')[0]?.id).toBe('all')
  })

  it('keeps real projects, chat subfolders and Claude paths separate', () => {
    const paths = [
      '/work/2026-10-24/chat-a',
      '/Users/synthetic/Documents/Codex/project',
      '/Users/synthetic/Documents/Codex/2026-10-24',
      '/Users/synthetic/Documents/Codex/2026-10-24/chat-a/src',
      '/Users/synthetic/Documents/Codex/not-a-date/chat-a',
      '/Users/synthetic/Documents/Other/2026-10-24/chat-a',
      '/'
    ]
    const sessions = paths.map((path, i) => projectSession(`real-${i}`, path))
    const claude = projectSession('claude', '/Users/synthetic/Documents/Codex/2026-10-24/chat-a', {
      key: { tool: 'claude', id: 'claude' }
    })
    const groups = buildListGroups([...sessions, claude], 'all', 'all', 'project')
    expect(groups).toHaveLength(paths.length + 1)
    expect(groups.every((group) => group.projectPath !== null)).toBe(true)
    expect(groups.flatMap((group) => group.sessions)).toHaveLength(paths.length + 1)
  })

  it('opens projectless chats under one heading and retains their recorded path in detail', async () => {
    const path = '/Users/synthetic/Documents/Codex/2026-10-24/chat-a'
    mount([
      projectSession('chat-a', path),
      projectSession('chat-b', '/Users/synthetic/Documents/Codex/2026-10-25/chat-b'),
      projectSession('none', null),
      projectSession('real', '/work/real')
    ])
    await screen.findByRole('tree')
    expect(within(header('No folder')).getAllByRole('treeitem')).toHaveLength(3)
    expect(header('real')).toBeTruthy()
    await userEvent.click(row('chat-a'))
    expect(document.querySelector('.detail-meta')?.getAttribute('title')).toBe(path)
    await clickHeader('No folder')
    expect(screen.queryByRole('treeitem', { name: /^Synthetic chat-/ })).toBeNull()
    expect(document.querySelector('.detail-meta')?.getAttribute('title')).toBe(path)
  })

  it('groups both tools by full path, preserves membership/pins, and orders projects consistently', () => {
    const a = projectSession('a', '/work/demo')
    const b = projectSession('b', '/work/demo/', { key: { tool: 'claude', id: 'b' }, pinned: true })
    const c = projectSession('c', '/elsewhere/demo')
    const idle = projectSession('idle', null, { activity: { state: 'idle' } })
    const input = [a, b, c, idle]
    expect(
      buildListGroups(input, 'active', 'all', 'project').map((g) => [
        g.id,
        g.sessions.map((s) => s.key.id)
      ])
    ).toEqual([
      ['project:/elsewhere/demo', ['c']],
      ['project:/work/demo', ['b', 'a']]
    ])
    expect(buildListGroups(input, 'all', 'all', 'project')[0]?.label).toBe('No folder')
    expect(buildListGroups(input, 'pinned', 'codex', 'project')).toEqual([])
    expect(buildListGroups(input, 'pinned', 'all', 'project')[0]?.sessions).toEqual([b])
    expect(input).toEqual([a, b, c, idle])
  })

  it('defaults to Project, distinguishes duplicate names and displays a No folder group', async () => {
    const f = mount([
      projectSession('a', '/a/demo'),
      projectSession('b', '/b/demo'),
      projectSession('none', null)
    ])
    await screen.findByRole('tree')
    expect(screen.getByRole('radio', { name: 'Project', checked: true })).toBeTruthy()
    expect(header('/a/demo')).toBeTruthy()
    expect(header('/b/demo')).toBeTruthy()
    expect(header('No folder')).toBeTruthy()
    expect(row('a').querySelector('.row-meta')?.textContent).toBe('Codex')
    expect(f.store.getSnapshot().listSelection).toBeNull()
  })

  it('keeps live counts and collapse state through updates, tool filters and view switches', async () => {
    const a = projectSession('a', '/work/app')
    const b = projectSession('b', '/work/app', { key: { tool: 'claude', id: 'b' } })
    const f = mount([a, b])
    await screen.findByRole('tree')
    await clickHeader('app')
    expect(header('app').getAttribute('aria-expanded')).toBe('false')
    const children = header('app').querySelector('.project-sessions')!
    expect(children.hasAttribute('inert')).toBe(true)
    expect(children.getAttribute('aria-hidden')).toBe('true')
    expect(screen.queryByRole('treeitem', { name: /^Synthetic/ })).toBeNull()
    const waiting: Session = {
      ...b,
      activity: { state: 'waiting', waitingFor: 'permission prompt' },
      attention: { waiting: true, error: false, newReply: false }
    }
    act(() => f.push(snapshot([a, waiting])))
    expect(header('app').getAttribute('aria-label')).toContain(
      '2 sessions · 1 need attention · 1 running'
    )
    expect(screen.getByRole('tree').getAttribute('aria-activedescendant')).toBe(header('app').id)
    await userEvent.click(screen.getByRole('radio', { name: 'Codex 1' }))
    expect(header('app').getAttribute('aria-expanded')).toBe('false')
    expect(header('app').getAttribute('aria-label')).toContain('1 session · 1 running')
    await userEvent.click(screen.getByRole('button', { name: 'All Sessions 2' }))
    expect(header('app').getAttribute('aria-expanded')).toBe('false')
    await clickHeader('app')
    expect(row('a')).toBeTruthy()
    expect(children.hasAttribute('inert')).toBe(false)
    expect(children.hasAttribute('aria-hidden')).toBe(false)
    expect(screen.queryByRole('treeitem', { name: /^Synthetic b,/ })).toBeNull()
  })

  it('collapses a selected project without replacing either split detail or reading hidden sessions', async () => {
    const f = mount([projectSession('a', '/work/app'), projectSession('b', '/work/app')])
    await screen.findByRole('tree')
    await userEvent.click(row('a'))
    act(() => f.store.openSecondary({ tool: 'codex', id: 'b' }))
    await within(screen.getByRole('complementary', { name: 'Right pane' })).findByText(
      'No recent messages.'
    )
    const before = f.api.getMessages.mock.calls.length
    await clickHeader('app')
    expect(f.store.getSnapshot().selection?.session.key.id).toBe('a')
    expect(f.store.getSnapshot().secondarySelection?.session.key.id).toBe('b')
    expect(f.store.getSnapshot().listSelection).toBeNull()
    expect(f.api.getMessages.mock.calls).toHaveLength(before)
    expect(screen.getByRole('tree').getAttribute('aria-activedescendant')).toBe(header('app').id)
    act(() => f.store.activatePane('main'))
    expect(header('app').getAttribute('aria-expanded')).toBe('true')
    expect(row('a').getAttribute('aria-selected')).toBe('true')
  })

  it('navigates headers and visible children with arrows, Home/End, Enter and Space', async () => {
    const f = mount([projectSession('a', '/a/app'), projectSession('b', '/b/other')])
    const tree = await screen.findByRole('tree')
    tree.focus()
    await userEvent.keyboard('{Home}')
    expect(tree.getAttribute('aria-activedescendant')).toBe(header('app').id)
    expect(f.api.getMessages).not.toHaveBeenCalled()
    await userEvent.keyboard('{ArrowLeft}')
    expect(header('app').getAttribute('aria-expanded')).toBe('false')
    await userEvent.keyboard('{ArrowDown}')
    expect(tree.getAttribute('aria-activedescendant')).toBe(header('other').id)
    await userEvent.keyboard(' ')
    expect(header('other').getAttribute('aria-expanded')).toBe('false')
    await userEvent.keyboard('{Enter}{ArrowRight}')
    expect(row('b').getAttribute('aria-selected')).toBe('true')
    await userEvent.keyboard('{ArrowLeft}{ArrowUp}{ArrowRight}{ArrowRight}')
    expect(row('a').getAttribute('aria-selected')).toBe('true')
    await userEvent.keyboard('{End}')
    expect(row('b').getAttribute('aria-selected')).toBe('true')
    expect(document.activeElement).toBe(tree)
  })

  it('preserves pane state when switching grouping and keeps selected slots during live reorder/source loss', async () => {
    const a = projectSession('a', '/work/app')
    const b = projectSession('b', '/work/app')
    const f = mount([a, b])
    await screen.findByRole('tree')
    await userEvent.click(row('b'))
    const selectedPane = f.store.getSnapshot().selection
    act(() => f.push(snapshot([{ ...b, pinned: true }, a], { takenAt: NOW + 1 })))
    expect(displayedGroups(f.store.getSnapshot())[0]?.sessions.map((s) => s.key.id)).toEqual([
      'a',
      'b'
    ])
    await userEvent.click(screen.getByRole('radio', { name: 'Status' }))
    expect(
      screen.getByRole('option', { name: /^Synthetic b,/ }).getAttribute('aria-selected')
    ).toBe('true')
    expect(f.store.getSnapshot().selection?.session.key).toEqual(selectedPane?.session.key)
    await userEvent.click(screen.getByRole('radio', { name: 'Project' }))
    act(() => f.push(snapshot([a], { takenAt: NOW + 2 })))
    expect(row('b').getAttribute('aria-label')).toContain('Unavailable — last known')
    expect(header('app').getAttribute('aria-label')).toContain('1 session')
    await userEvent.click(row('a'))
    expect(screen.queryByRole('treeitem', { name: /^Synthetic b,/ })).toBeNull()
  })

  it('keeps context entry and row dragging targeted at the row without changing project collapse state', async () => {
    const f = mount([projectSession('a', '/work/app'), projectSession('b', '/work/app')])
    await screen.findByRole('tree')
    await userEvent.click(row('a'))
    fireEvent.contextMenu(row('b'))
    expect(f.api.showSessionMenu).toHaveBeenCalledWith({ tool: 'codex', id: 'b' })
    expect(f.store.getSnapshot().selection?.session.key.id).toBe('a')
    expect(header('app').getAttribute('aria-expanded')).toBe('true')
    const data = new Map<string, string>()
    fireEvent.dragStart(row('b'), {
      dataTransfer: {
        effectAllowed: '',
        setData: (type: string, value: string) => data.set(type, value)
      }
    })
    expect(data.get('application/x-agentpeek-session')).toBe('codex:b')
    fireEvent.dragEnd(row('b'))
  })
})
