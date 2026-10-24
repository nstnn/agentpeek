import { act, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'
import type { SkillContent } from '../../core/skills'
import { fakeApi } from '../test-support'
import { PromptSkills, type PromptSkillContext } from './PromptSkills'

const path = '/synthetic/.agents/skills/pr/SKILL.md'
const text = `Before [$pr](${path}) after.`
function setup(visible = true) {
  const { api } = fakeApi()
  const onLink = vi.fn()
  const context: PromptSkillContext = {
    api,
    at: 1,
    sessionKey: { tool: 'codex', id: 'synthetic' },
    visible
  }
  return { api, onLink, context }
}

describe('prompt skill cards', () => {
  it('does not turn a clipped code sample or partially visible link into a request', () => {
    const f = setup()
    const code = '`' + text + '`'
    const first = render(
      <PromptSkills text={code} limit={code.length - 1} context={f.context} onLink={f.onLink} />
    )
    expect(first.container.querySelector('.skill-card')).toBeNull()
    first.rerender(
      <PromptSkills text={text} limit={text.length - 10} context={f.context} onLink={f.onLink} />
    )
    expect(first.container.querySelector('.skill-card')).toBeNull()
    expect(f.api.getSkill).not.toHaveBeenCalled()
  })
  it('loads only on expansion and renders provenance, description and safe Markdown with surrounding text intact', async () => {
    const f = setup()
    f.api.getSkill.mockResolvedValue({
      kind: 'skill',
      source: 'conversation',
      description: 'Synthetic description',
      truncated: false,
      text: '# Synthetic skill\n\n<script>globalThis.syntheticInjected=true</script>\n\n![Synthetic image](https://example.invalid/a)\n\n[Safe](https://example.invalid) [Bad](javascript:alert%281%29)'
    })
    const { container } = render(<PromptSkills text={text} context={f.context} onLink={f.onLink} />)
    expect(f.api.getSkill).not.toHaveBeenCalled()
    expect(container.querySelector('details')?.open).toBe(false)
    expect(container.textContent).toContain('Before ')
    expect(container.textContent).toContain(' after.')
    await userEvent.click(screen.getByText('pr'))
    expect(await screen.findByRole('heading', { name: 'Synthetic skill' })).toBeTruthy()
    expect(f.api.getSkill).toHaveBeenCalledWith(f.context.sessionKey, { at: 1, name: 'pr', path })
    expect(screen.getByText('From this conversation')).toBeTruthy()
    expect(screen.getByText('Synthetic description')).toBeTruthy()
    expect(container.querySelector('script,img,iframe')).toBeNull()
    expect(screen.getByText('Image: Synthetic image')).toBeTruthy()
    expect(screen.getAllByRole('link')).toHaveLength(1)
    await userEvent.click(screen.getByRole('link', { name: 'Safe' }))
    expect(f.onLink).toHaveBeenCalledWith('https://example.invalid')
  })
  it('defers hidden cards, preserves expansion through append, and discards an old-session response', async () => {
    const f = setup(false)
    let resolve!: (result: SkillContent) => void
    f.api.getSkill.mockImplementation(
      () =>
        new Promise((done) => {
          resolve = done
        })
    )
    const view = render(<PromptSkills text={text} context={f.context} onLink={f.onLink} />)
    await userEvent.click(screen.getByText('pr'))
    expect(f.api.getSkill).not.toHaveBeenCalled()
    view.rerender(
      <PromptSkills text={text} context={{ ...f.context, visible: true }} onLink={f.onLink} />
    )
    expect(await screen.findByRole('status')).toBeTruthy()
    expect(f.api.getSkill).toHaveBeenCalledTimes(1)
    view.rerender(
      <PromptSkills
        text={text + ' More text.'}
        context={{ ...f.context, visible: true }}
        onLink={f.onLink}
      />
    )
    expect(view.container.querySelector('details')?.open).toBe(true)
    expect(f.api.getSkill).toHaveBeenCalledTimes(1)
    view.rerender(
      <PromptSkills
        text={text}
        context={{ ...f.context, visible: true, sessionKey: { tool: 'codex', id: 'replacement' } }}
        onLink={f.onLink}
      />
    )
    await act(async () => {
      resolve({
        kind: 'skill',
        source: 'conversation',
        description: null,
        truncated: false,
        text: '# Old private response'
      })
      await Promise.resolve()
    })
    expect(screen.queryByRole('heading', { name: 'Old private response' })).toBeNull()
    expect(view.container.querySelector('details')?.open).toBe(false)
    expect(f.api.getSkill).toHaveBeenCalledTimes(1)
  })
  it('sanitizes failures, supports retry/local reload, labels limited content and keeps file details collapsed', async () => {
    const f = setup()
    f.api.getSkill.mockRejectedValueOnce(new Error('/private/synthetic-secret'))
    f.api.getSkill.mockResolvedValue({
      kind: 'skill',
      source: 'local',
      description: null,
      truncated: true,
      text: '# Synthetic local skill'
    })
    const view = render(<PromptSkills text={text} context={f.context} onLink={f.onLink} />)
    await userEvent.click(screen.getByText('pr'))
    expect(await screen.findByText('Could not read this skill.')).toBeTruthy()
    expect(view.container.textContent).not.toContain('synthetic-secret')
    await userEvent.click(screen.getByRole('button', { name: 'Try Again' }))
    expect(await screen.findByText('Current local version')).toBeTruthy()
    expect(screen.getByText('This file may have changed since the conversation.')).toBeTruthy()
    expect(
      screen.getByText('Skill content is limited. Open the skill in your editor to read the rest.')
    ).toBeTruthy()
    expect(view.container.querySelector<HTMLDetailsElement>('.skill-file-details')?.open).toBe(
      false
    )
    f.api.getSkill.mockResolvedValueOnce({
      kind: 'skill',
      source: 'local',
      description: null,
      truncated: false,
      text: '# Reloaded synthetic local skill'
    })
    await userEvent.click(screen.getByRole('button', { name: 'Reload Skill' }))
    expect(
      await screen.findByRole('heading', { name: 'Reloaded synthetic local skill' })
    ).toBeTruthy()
    expect(view.container.querySelector('details')?.open).toBe(true)
  })
})
