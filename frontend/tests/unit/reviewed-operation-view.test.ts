import { describe, expect, it } from 'vitest'

import type { CopilotProposalDetail } from '@/lib/api-copilot'
import { buildReviewedOperationView } from '@/lib/reviewed-operation-view'

type ReviewedOperation = NonNullable<CopilotProposalDetail['reviewedOperation']>

const detail = (overrides: Partial<Omit<CopilotProposalDetail, 'reviewedOperation'>> & { reviewedOperation?: Partial<ReviewedOperation> }): CopilotProposalDetail => ({
  id: 'proposal-1',
  workspaceId: 'workspace-1',
  targetType: 'agent_publication',
  targetLabel: 'Publish Support',
  status: 'pending',
  currentVersionMatches: true,
  evidenceCases: null,
  preview: { current: null, proposed: null },
  ...overrides,
  reviewedOperation: {
    requirement: 'signed_in_approval',
    effect: { exposure: 'live', reversibility: 'reversible', metered: false },
    reviewDigest: 'd'.repeat(43),
    reviewCode: 'AB12CD34',
    expiresAt: null,
    approvedAt: null,
    clientName: 'Client',
    summary: null,
    reach: false,
    affectedAgents: { agents: [], truncated: false },
    review: {},
    ...overrides.reviewedOperation,
  },
} as CopilotProposalDetail)

describe('buildReviewedOperationView', () => {
  it('reads a publication as the fields that change between live and the candidate', () => {
    const view = buildReviewedOperationView(detail({
      preview: { current: { customInstruction: 'Be brief.' }, proposed: { customInstruction: 'Be brief and kind.', 'directives d1': '{"name":"Refunds"}' } },
      reviewedOperation: { affectedAgents: { agents: [{ id: 'a1', name: 'Support' }], truncated: false } },
    }))
    expect(view.label).toBe('Publish Support')
    expect(view.effects).toEqual(['Goes live when applied'])
    expect(view.agents).toEqual({ names: ['Support'], hasMore: false })
    expect(view.rows.map((row) => [row.path, row.kind])).toEqual([['$.customInstruction', 'changed'], ['$.directives d1', 'added']])
  })

  it('reads a document removal as titles that go away, flagged as permanent', () => {
    const view = buildReviewedOperationView(detail({
      targetLabel: 'Remove 2 documents',
      preview: { current: { 'Returns policy': 'Stored', Shipping: 'Stored' }, proposed: {} },
      reviewedOperation: { effect: { exposure: 'live', reversibility: 'irreversible', metered: false } },
    }))
    expect(view.effects).toEqual(['Goes live when applied', "Can't be undone"])
    expect(view.rows.map((row) => [row.path, row.kind])).toEqual([['$.Returns policy', 'removed'], ['$.Shipping', 'removed']])
  })

  it('carries the summary, the reach warning and a truncated agent list', () => {
    const view = buildReviewedOperationView(detail({
      reviewedOperation: { summary: 'Open the agent to everyone.', reach: true, affectedAgents: { agents: [{ id: 'a1', name: 'Support' }], truncated: true } },
    }))
    expect(view).toMatchObject({ summary: 'Open the agent to everyone.', reach: true, agents: { names: ['Support'], hasMore: true } })
  })

  it('reads a backend that has not deployed summary, reach or affected agents as having none', () => {
    const base = detail({})
    const { summary: _summary, reach: _reach, affectedAgents: _agents, ...older } = base.reviewedOperation!
    const view = buildReviewedOperationView({ ...base, reviewedOperation: older as typeof base.reviewedOperation })
    expect(view).toMatchObject({ summary: null, reach: false, agents: { names: [], hasMore: false } })
  })
})
