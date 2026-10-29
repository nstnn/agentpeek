import { act, cleanup, render, screen } from '@testing-library/react'
import { afterEach, expect, it } from 'vitest'
import { VALID_STATUS_FRAME } from '../../../src/core/remote/protocol-vectors'
import { App } from './App'

// The page with a scripted Mac; the browser-level runs are in remote/web/browser.

afterEach(cleanup)

const settle = () => act(() => new Promise((done) => setTimeout(done, 10)))

/** A stream that sends `text` and stays open, as the Mac's does. */
function openStream(text: string): Response {
  const body = new ReadableStream<Uint8Array>({
    start: (controller) => controller.enqueue(new TextEncoder().encode(text))
  })
  return new Response(body, { headers: { 'Content-Type': 'text/event-stream; charset=utf-8' } })
}

function stream(text: string): typeof fetch {
  return () => Promise.resolve(openStream(text))
}

function refuse(error: string, status: number): typeof fetch {
  return () =>
    Promise.resolve(
      new Response(JSON.stringify({ v: 1, error }), {
        status,
        headers: { 'Content-Type': 'application/json' }
      })
    )
}

it('shows Connecting until the first status, then Live with the shared projects', async () => {
  let release: (response: Response) => void = () => undefined
  const fetch = (() => new Promise<Response>((done) => (release = done))) as typeof globalThis.fetch
  render(<App fetch={fetch} />)
  expect(screen.getByRole('heading', { level: 1, name: 'AgentPeek' })).toBeTruthy()
  expect(screen.getByRole('status').textContent).toBe('Connecting…')
  release(openStream(`event: status\ndata: ${JSON.stringify(VALID_STATUS_FRAME)}\n\n`))
  await settle()
  expect(screen.getByRole('status').textContent).toBe('Live')
  const label = VALID_STATUS_FRAME.status.projects[0]!.label
  expect(screen.getByRole('heading', { level: 2, name: label })).toBeTruthy()
})

it('shows Not allowed with no data and no button', async () => {
  render(<App fetch={refuse('not-allowed', 403)} />)
  await settle()
  expect(
    screen.getByText(
      'Not allowed. This page only opens for the Tailscale login set in AgentPeek on the Mac.'
    )
  ).toBeTruthy()
  expect(screen.queryByTestId('status')).toBeNull()
  expect(screen.queryByRole('button')).toBeNull()
})

it('shows the wrong-address state for bad-host', async () => {
  render(<App fetch={refuse('bad-host', 421)} />)
  await settle()
  expect(screen.getByText('Open this page with the Mac address set in AgentPeek.')).toBeTruthy()
})

it('asks for a reload when the versions differ', async () => {
  render(<App fetch={refuse('unsupported-version', 404)} />)
  await settle()
  expect(screen.getByRole('status').textContent).toBe('Update needed')
  expect(screen.getByRole('button', { name: 'Reload' })).toBeTruthy()
})

it('shows Too many open pages with Retry for busy', async () => {
  render(<App fetch={refuse('busy', 503)} />)
  await settle()
  expect(screen.getByRole('status').textContent).toBe('Too many open pages')
  expect(screen.getByRole('button', { name: 'Retry' })).toBeTruthy()
})

it('says when nothing is shared', async () => {
  const empty = { ...VALID_STATUS_FRAME, status: { ...VALID_STATUS_FRAME.status, projects: [] } }
  render(<App fetch={stream(`event: status\ndata: ${JSON.stringify(empty)}\n\n`)} />)
  await settle()
  expect(screen.getByText(/No projects are shared\./)).toBeTruthy()
})
