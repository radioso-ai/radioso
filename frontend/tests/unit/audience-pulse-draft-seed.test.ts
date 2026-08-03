/* @vitest-environment jsdom */

import { beforeEach, describe, expect, it } from 'vitest'

import {
  AUDIENCE_PULSE_DRAFT_SEED_KEY,
  clearAudiencePulseDraftSeed,
  consumeAudiencePulseDraftSeed,
  formatDraftQuestionsAsMarkdown,
  writeAudiencePulseDraftSeed,
} from '@/lib/audience-pulse-draft-seed'

const scope = { accountId: 'account-1', workspaceId: 'workspace-1' }

describe('audience-pulse-draft-seed', () => {
  beforeEach(() => {
    window.sessionStorage.clear()
  })

  it('round-trips a seed for the matching account and workspace, then clears storage', () => {
    writeAudiencePulseDraftSeed({
      ...scope,
      seed: { title: 'Refund policy', questions: ['How long?', 'What items?'] },
    })

    const consumed = consumeAudiencePulseDraftSeed(scope)

    expect(consumed).toEqual({ title: 'Refund policy', questions: ['How long?', 'What items?'] })
    expect(window.sessionStorage.getItem(AUDIENCE_PULSE_DRAFT_SEED_KEY)).toBeNull()
  })

  it('discards a seed written for a different workspace and clears it from storage', () => {
    writeAudiencePulseDraftSeed({
      accountId: scope.accountId,
      workspaceId: 'workspace-2',
      seed: { title: 'Ignored', questions: ['ignored'] },
    })

    const consumed = consumeAudiencePulseDraftSeed(scope)

    expect(consumed).toBeNull()
    expect(window.sessionStorage.getItem(AUDIENCE_PULSE_DRAFT_SEED_KEY)).toBeNull()
  })

  it('discards a seed written for a different account and clears it from storage', () => {
    writeAudiencePulseDraftSeed({
      accountId: 'account-2',
      workspaceId: scope.workspaceId,
      seed: { title: 'Ignored', questions: ['ignored'] },
    })

    const consumed = consumeAudiencePulseDraftSeed(scope)

    expect(consumed).toBeNull()
    expect(window.sessionStorage.getItem(AUDIENCE_PULSE_DRAFT_SEED_KEY)).toBeNull()
  })

  it('returns null and is a no-op when nothing is stored', () => {
    expect(consumeAudiencePulseDraftSeed(scope)).toBeNull()
    expect(window.sessionStorage.getItem(AUDIENCE_PULSE_DRAFT_SEED_KEY)).toBeNull()
  })

  it('ignores malformed JSON but still clears the corrupt entry', () => {
    window.sessionStorage.setItem(AUDIENCE_PULSE_DRAFT_SEED_KEY, '{not-json')

    expect(consumeAudiencePulseDraftSeed(scope)).toBeNull()
    expect(window.sessionStorage.getItem(AUDIENCE_PULSE_DRAFT_SEED_KEY)).toBeNull()
  })

  it('clearAudiencePulseDraftSeed removes any stored entry', () => {
    writeAudiencePulseDraftSeed({
      ...scope,
      seed: { title: 'Draft', questions: ['q1'] },
    })

    clearAudiencePulseDraftSeed()

    expect(window.sessionStorage.getItem(AUDIENCE_PULSE_DRAFT_SEED_KEY)).toBeNull()
  })

  it('overwrites an existing seed when writing a new one', () => {
    writeAudiencePulseDraftSeed({
      ...scope,
      seed: { title: 'First', questions: ['a'] },
    })
    writeAudiencePulseDraftSeed({
      ...scope,
      seed: { title: 'Second', questions: ['b', 'c'] },
    })

    expect(consumeAudiencePulseDraftSeed(scope)).toEqual({ title: 'Second', questions: ['b', 'c'] })
  })

  it('formats questions as a Markdown bullet list, trimming empty entries', () => {
    expect(formatDraftQuestionsAsMarkdown(['  How much? ', 'When?', ''])).toBe('- How much?\n- When?')
    expect(formatDraftQuestionsAsMarkdown([])).toBe('')
  })
})
