import { act, render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it } from 'vitest'
import { App } from './App'
import { createSessionsStore } from './sessions-store'
import { fakeApi, NOW, session, snapshot } from '../test-support'

describe.each(['project', 'status'] as const)('%s Active and Inbox transitions', (grouping) => {
  it('removes a selected finished task from Active, preserves its detail and reveals it in Inbox', async () => {
    const task = session('task')
    const other = session('other')
    const fake = fakeApi(snapshot([task, other]))
    Object.defineProperty(window, 'agentpeek', { value: fake.api, configurable: true })
    const store = createSessionsStore(fake.api)
    store.setGrouping(grouping)
    render(<App store={store} />)
    const role = grouping === 'project' ? 'treeitem' : 'option'
    const row = () => screen.queryByRole(role, { name: /^Synthetic task,/ })
    await userEvent.click(await screen.findByRole(role, { name: /^Synthetic task,/ }))
    await screen.findByText('No recent messages.')
    const finished = {
      ...task,
      activity: { state: 'idle' } as const,
      attention: { waiting: false, newReply: true, error: false },
      lastReply: {
        cursor: 'done',
        completedAt: NOW,
        isError: false,
        errorCode: null,
        newerTurnStarted: false
      }
    }
    act(() => fake.push(snapshot([finished, other])))
    expect(row()).toBeNull()
    expect(store.getSnapshot().listSelection).toBeNull()
    expect(store.getSnapshot().selection?.session.key).toEqual(task.key)
    expect(screen.getByRole('heading', { name: 'Synthetic task' })).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Active 1' })).toBeTruthy()
    await userEvent.click(screen.getByRole('button', { name: 'Inbox 1' }))
    expect(row()).toBeTruthy()
    expect(screen.queryByRole(role, { name: /^Synthetic other,/ })).toBeNull()
    await userEvent.click(row()!)
    const read = { ...finished, attention: { waiting: false, newReply: false, error: false } }
    act(() => fake.push(snapshot([read, other])))
    expect(screen.getByRole('button', { name: 'Inbox 0' })).toBeTruthy()
    expect(row()?.textContent).toContain('Kept here while selected.')
    act(() => fake.push(snapshot([{ ...read, activity: { state: 'running' } }, other])))
    expect(row()).toBeNull()
    expect(store.getSnapshot().listSelection).toBeNull()
    await userEvent.click(screen.getByRole('button', { name: 'Active 2' }))
    expect(row()?.textContent).toContain('Running')
  })

  it('keeps running ahead of old unread attention and leaves waiting sessions in All Sessions', async () => {
    const task = session('task', { attention: { waiting: false, error: true, newReply: true } })
    const waiting = session('waiting', {
      activity: { state: 'waiting', waitingFor: 'permission prompt' },
      attention: { waiting: true, error: false, newReply: false }
    })
    const fake = fakeApi(snapshot([task, waiting]))
    Object.defineProperty(window, 'agentpeek', { value: fake.api, configurable: true })
    const store = createSessionsStore(fake.api)
    store.setGrouping(grouping)
    render(<App store={store} />)
    const role = grouping === 'project' ? 'treeitem' : 'option'
    const running = await screen.findByRole(role, { name: /^Synthetic task,/ })
    expect(within(running).getByText('Running')).toBeTruthy()
    expect(screen.queryByRole(role, { name: /^Synthetic waiting,/ })).toBeNull()
    await userEvent.click(screen.getByRole('button', { name: 'Inbox 0' }))
    expect(screen.queryByRole(role, { name: /^Synthetic waiting,/ })).toBeNull()
    expect(screen.queryByRole(role, { name: /^Synthetic task,/ })).toBeNull()
    await userEvent.click(screen.getByRole('button', { name: 'All Sessions 2' }))
    expect(screen.getByRole(role, { name: /^Synthetic waiting,/ })).toBeTruthy()
  })
})
