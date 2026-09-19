import { describe, expect, it } from 'vitest'

import {
  assembleTestableRevisions,
  candidateIsTestable,
  compareSelectionRepeatsRevision,
} from '@/lib/agent-revision-testable-revisions'
import type { AgentRevisionState, AgentRevisionSummary } from '@/lib/api-agent-revisions'

const summary = (overrides: Partial<AgentRevisionSummary> & { id: string }): AgentRevisionSummary => ({
  label: overrides.label ?? overrides.id,
  kind: overrides.kind ?? 'published',
  createdAt: overrides.createdAt ?? '2026-01-01T00:00:00.000Z',
  versionNumber: overrides.versionNumber ?? null,
  ...overrides,
})

const state = (overrides: Partial<AgentRevisionState> = {}): AgentRevisionState => ({
  agentId: 'agent-1',
  status: 'draft_clean',
  draft: { generation: 1, basePublishedRevisionId: null, updatedAt: '2026-01-01T00:00:00.000Z' },
  publishedRevision: null,
  canPublish: true,
  ...overrides,
})

describe('candidateIsTestable', () => {
  it('is not testable for a clean draft with a published revision', () => {
    expect(
      candidateIsTestable(state({ status: 'draft_clean', publishedRevision: summary({ id: 'p1' }) })),
    ).toBe(false)
  })

  it('is testable for a clean draft when nothing has ever been published', () => {
    expect(candidateIsTestable(state({ status: 'draft_clean', publishedRevision: null }))).toBe(true)
  })

  it.each(['draft_dirty', 'unpublished', 'published_changed_since_draft'] as const)(
    'is testable for status %s',
    (status) => {
      expect(candidateIsTestable(state({ status, publishedRevision: summary({ id: 'p1' }) }))).toBe(true)
    },
  )
})

describe('assembleTestableRevisions', () => {
  it('lists the candidate first and dedupes it out of the published list', () => {
    const candidate = summary({ id: 'c1', kind: 'candidate' })
    const published = [summary({ id: 'c1', kind: 'candidate' }), summary({ id: 'p1' }), summary({ id: 'p2' })]

    const result = assembleTestableRevisions({ state: state(), published, candidate })

    expect(result.revisions.map((revision) => revision.id)).toEqual(['c1', 'p1', 'p2'])
    expect(result.candidateId).toBe('c1')
  })

  it('defaults to the published revision id for a clean draft with no candidate', () => {
    const publishedRevision = summary({ id: 'p1' })
    const result = assembleTestableRevisions({
      state: state({ status: 'draft_clean', publishedRevision }),
      published: [publishedRevision, summary({ id: 'p2' })],
      candidate: null,
    })

    expect(result.candidateId).toBeNull()
    expect(result.defaultSelectedId).toBe('p1')
  })

  it('defaults to the candidate id when the draft has diverged', () => {
    const candidate = summary({ id: 'c1', kind: 'candidate' })
    const publishedRevision = summary({ id: 'p1' })
    const result = assembleTestableRevisions({
      state: state({ status: 'draft_dirty', publishedRevision }),
      published: [publishedRevision],
      candidate,
    })

    expect(result.defaultSelectedId).toBe('c1')
  })

  it('has no default selection when there is no published revision and no candidate', () => {
    const result = assembleTestableRevisions({
      state: state({ status: 'unpublished', publishedRevision: null }),
      published: [],
      candidate: null,
    })

    expect(result.revisions).toEqual([])
    expect(result.candidateId).toBeNull()
    expect(result.defaultSelectedId).toBeNull()
  })

  it('falls back to the first published revision when state.publishedRevision.id is absent from the published list', () => {
    const stale = summary({ id: 'stale-published' })
    const first = summary({ id: 'p1' })
    const result = assembleTestableRevisions({
      state: state({ status: 'draft_clean', publishedRevision: stale }),
      published: [first, summary({ id: 'p2' })],
      candidate: null,
    })

    expect(result.defaultSelectedId).toBe('p1')
  })
})

describe('compareSelectionRepeatsRevision', () => {
  it('flags a comparison whose two sides name the same revision', () => {
    expect(compareSelectionRepeatsRevision('compare', ['p1', 'p1'])).toBe(true)
  })

  it('accepts a comparison of two distinct revisions', () => {
    expect(compareSelectionRepeatsRevision('compare', ['p1', 'c1'])).toBe(false)
  })

  it('never flags a single chat or an incomplete comparison', () => {
    expect(compareSelectionRepeatsRevision('single', ['p1'])).toBe(false)
    expect(compareSelectionRepeatsRevision('compare', ['p1'])).toBe(false)
  })
})
