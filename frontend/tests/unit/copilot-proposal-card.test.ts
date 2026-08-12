import { describe, expect, it } from 'vitest'

import {
  createCopilotProposalCardState,
  failCopilotProposalApply,
  optimisticallyApplyCopilotProposal,
  optimisticallyDismissCopilotProposal,
  reconcileCopilotProposalApply,
  reconcileCopilotProposalDetail,
  reconcileCopilotProposalDismiss,
  revertCopilotProposalDismiss,
} from '@/lib/copilot-proposal-state'

describe('copilot proposal card state', () => {
  it('optimistically applies and reconciles a successful server result', () => {
    const pending = createCopilotProposalCardState('pending')
    const optimistic = optimisticallyApplyCopilotProposal(pending)
    expect(optimistic).toMatchObject({ status: 'applied', isApplying: true })

    expect(reconcileCopilotProposalApply(optimistic, {
      status: 'applied',
      appliedRef: { directiveId: 'directive-1' },
    })).toMatchObject({ status: 'applied', isApplying: false, appliedRef: { directiveId: 'directive-1' } })
  })

  it('reconciles stale and failed server outcomes instead of keeping the optimistic state', () => {
    const optimistic = optimisticallyApplyCopilotProposal(createCopilotProposalCardState('pending'))
    expect(reconcileCopilotProposalApply(optimistic, { status: 'stale' })).toMatchObject({ status: 'stale', isApplying: false })
    expect(reconcileCopilotProposalApply(optimistic, { status: 'failed', reason: 'Directive validation failed.' })).toMatchObject({ status: 'failed', reason: 'Directive validation failed.' })
  })

  it('uses the proposal detail to resolve a non-pending 409', () => {
    const optimistic = optimisticallyApplyCopilotProposal(createCopilotProposalCardState('pending'))
    expect(reconcileCopilotProposalDetail(optimistic, {
      status: 'stale',
      reason: null,
      appliedRef: null,
    })).toMatchObject({ status: 'stale', isApplying: false })
  })

  it('optimistically dismisses and restores pending when dismissal fails', () => {
    const dismissed = optimisticallyDismissCopilotProposal(createCopilotProposalCardState('pending'))
    expect(dismissed).toMatchObject({ status: 'dismissed', isDismissing: true })
    expect(reconcileCopilotProposalDismiss(dismissed)).toMatchObject({ status: 'dismissed', isDismissing: false })
    expect(revertCopilotProposalDismiss(dismissed, 'Could not save dismissal.')).toMatchObject({ status: 'pending', isDismissing: false, reason: 'Could not save dismissal.' })
  })

  it('keeps an apply failure visible as a failed proposal', () => {
    const optimistic = optimisticallyApplyCopilotProposal(createCopilotProposalCardState('pending'))
    expect(failCopilotProposalApply(optimistic, 'The target is invalid.')).toMatchObject({ status: 'failed', isApplying: false, reason: 'The target is invalid.' })
  })
})
