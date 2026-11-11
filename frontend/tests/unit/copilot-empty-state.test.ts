import { describe, expect, it } from 'vitest'

import type { CopilotEmptyState } from '@/lib/api-copilot'
import type { CopilotEntity } from '@/lib/copilot-context'
import {
  isDashboardHref,
  requestLocale,
  resolveCopilotEmptyState,
} from '@/lib/copilot-empty-state'

const setupState: CopilotEmptyState = {
  phase: 'setup',
  greeting: "Let's pick up your setup.",
  suggestions: [
    { kind: 'setup_step', step: 'documents', text: 'Add your documents', href: '/w/acme/knowledge' },
    { kind: 'setup_step', step: 'conversation', text: 'Ask a first question', href: '/w/acme/agents' },
  ],
}

const openState: CopilotEmptyState = {
  phase: 'open',
  greeting: 'What shall we work on?',
  suggestions: [
    { kind: 'prompt', intent: 'crawl_more', text: 'Crawl more of my website' },
    { kind: 'prompt', intent: 'draft_routine', text: 'Draft a routine' },
  ],
}

const focusedConversation: CopilotEntity = { type: 'conversation', id: 'c-1', label: 'Conversation 1', focused: true }

describe('resolveCopilotEmptyState', () => {
  it('shows nothing the operator could read as a claim while the state loads', () => {
    expect(resolveCopilotEmptyState({ status: 'loading' }, 'other', [])).toEqual({ status: 'pending', greeting: null, showStaticSubtitle: false, chips: [] })
  })

  it('names the next steps as links on a workspace whose setup is open', () => {
    expect(resolveCopilotEmptyState({ status: 'ready', state: setupState }, 'other', [])).toEqual({
      status: 'ready',
      greeting: "Let's pick up your setup.",
      showStaticSubtitle: false,
      chips: [
        { kind: 'link', text: 'Add your documents', href: '/w/acme/knowledge' },
        { kind: 'link', text: 'Ask a first question', href: '/w/acme/agents' },
      ],
    })
  })

  it('keeps the screen out of it while setup is open, even over a focused conversation', () => {
    const resolved = resolveCopilotEmptyState({ status: 'ready', state: setupState }, 'activity', [focusedConversation])
    expect(resolved.chips.map((chip) => chip.text)).toEqual(['Add your documents', 'Ask a first question'])
  })

  it('shows no retrospective copy when setup is open and the model wrote nothing', () => {
    const resolved = resolveCopilotEmptyState({ status: 'ready', state: { phase: 'setup', greeting: null, suggestions: [] } }, 'other', [])
    expect(resolved).toEqual({ status: 'ready', greeting: null, showStaticSubtitle: false, chips: [] })
  })

  it('drops a link that does not point inside the dashboard', () => {
    const resolved = resolveCopilotEmptyState({
      status: 'ready',
      state: { phase: 'setup', greeting: 'Hi', suggestions: [
        { kind: 'setup_step', step: 'documents', text: 'Elsewhere', href: 'https://elsewhere.example/knowledge' },
        { kind: 'setup_step', step: 'credential', text: 'Protocol relative', href: '//elsewhere.example/settings' },
        { kind: 'setup_step', step: 'conversation', text: 'Ask a first question', href: '/w/acme/agents' },
      ] },
    }, 'other', [])
    expect(resolved.chips.map((chip) => chip.text)).toEqual(['Ask a first question'])
  })

  it('moves to the open-ended requests once setup is over', () => {
    expect(resolveCopilotEmptyState({ status: 'ready', state: openState }, 'other', [])).toEqual({
      status: 'ready',
      greeting: 'What shall we work on?',
      showStaticSubtitle: false,
      chips: [
        { kind: 'prompt', text: 'Crawl more of my website' },
        { kind: 'prompt', text: 'Draft a routine' },
      ],
    })
  })

  it('lets what the operator is looking at lead once setup is over', () => {
    const resolved = resolveCopilotEmptyState({ status: 'ready', state: openState }, 'activity', [focusedConversation])
    expect(resolved.chips[0]).toEqual({ kind: 'prompt', text: 'Explain what happened in Conversation 1' })
  })

  it('falls back to the screen-derived suggestions and greeting when the server has no copy', () => {
    const resolved = resolveCopilotEmptyState({ status: 'ready', state: { phase: 'open', greeting: null, suggestions: [] } }, 'quality', [])
    expect(resolved).toMatchObject({ greeting: null, showStaticSubtitle: true })
    expect(resolved.chips.map((chip) => chip.text)).toContain('What needs attention in this workspace?')
  })

  it('falls back to the screen-derived suggestions when the state could not be read', () => {
    const resolved = resolveCopilotEmptyState({ status: 'failed' }, 'evals', [])
    expect(resolved).toMatchObject({ status: 'ready', greeting: null, showStaticSubtitle: true })
    expect(resolved.chips.map((chip) => chip.text)).toContain('Which eval cases need attention?')
  })
})

describe('isDashboardHref', () => {
  it('accepts only workspace-scoped dashboard paths', () => {
    expect(isDashboardHref('/w/acme/knowledge')).toBe(true)
    expect(isDashboardHref('/w/acme/agents?tab=behavior&anchor=assistant-directives')).toBe(true)
    expect(isDashboardHref('/account/1/agents')).toBe(false)
    expect(isDashboardHref('https://elsewhere.example/w/acme/knowledge')).toBe(false)
    expect(isDashboardHref('//elsewhere.example/w/acme')).toBe(false)
    expect(isDashboardHref('/w//knowledge')).toBe(false)
  })
})

describe('requestLocale', () => {
  it('sends the language and region and nothing a locale tag cannot carry', () => {
    expect(requestLocale('fr-CA')).toBe('fr-CA')
    expect(requestLocale('en-US-u-ca-gregory')).toBe('en-US')
    expect(requestLocale('de')).toBe('de')
  })

  it('sends no language when the browser names none or names nonsense', () => {
    expect(requestLocale(undefined)).toBeNull()
    expect(requestLocale('')).toBeNull()
    expect(requestLocale('not a locale')).toBeNull()
  })
})
