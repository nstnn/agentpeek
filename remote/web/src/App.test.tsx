import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, expect, it } from 'vitest'
import { App } from './App'

afterEach(cleanup)

it('renders the page shell', () => {
  render(<App />)
  expect(screen.getByRole('heading', { name: 'AgentPeek' })).toBeTruthy()
})
