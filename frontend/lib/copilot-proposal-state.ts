import type {
  CopilotProposalApplyResult,
  CopilotProposalDetail,
  CopilotProposalStatus,
} from './api-copilot'

export interface CopilotProposalCardState {
  status: CopilotProposalStatus
  isApplying: boolean
  isDismissing: boolean
  appliedRef: Record<string, unknown> | null
  reason: string | null
}

export const createCopilotProposalCardState = (status: CopilotProposalStatus): CopilotProposalCardState => ({
  status,
  isApplying: false,
  isDismissing: false,
  appliedRef: null,
  reason: null,
})

export const optimisticallyApplyCopilotProposal = (state: CopilotProposalCardState): CopilotProposalCardState => ({
  ...state,
  status: 'applied',
  isApplying: true,
  reason: null,
})

export const reconcileCopilotProposalApply = (
  state: CopilotProposalCardState,
  result: CopilotProposalApplyResult,
): CopilotProposalCardState => ({
  ...state,
  status: result.status,
  isApplying: false,
  appliedRef: result.appliedRef ?? state.appliedRef,
  reason: result.reason ?? null,
})

export const reconcileCopilotProposalDetail = (
  state: CopilotProposalCardState,
  detail: Pick<CopilotProposalDetail, 'status' | 'reason' | 'appliedRef'>,
): CopilotProposalCardState => ({
  ...state,
  status: detail.status,
  isApplying: false,
  appliedRef: detail.appliedRef ?? state.appliedRef,
  reason: detail.reason ?? null,
})

export const optimisticallyDismissCopilotProposal = (state: CopilotProposalCardState): CopilotProposalCardState => ({
  ...state,
  status: 'dismissed',
  isDismissing: true,
  reason: null,
})

export const reconcileCopilotProposalDismiss = (state: CopilotProposalCardState): CopilotProposalCardState => ({
  ...state,
  status: 'dismissed',
  isDismissing: false,
})

export const revertCopilotProposalDismiss = (state: CopilotProposalCardState, reason: string): CopilotProposalCardState => ({
  ...state,
  status: 'pending',
  isDismissing: false,
  reason,
})

export const failCopilotProposalApply = (state: CopilotProposalCardState, reason: string): CopilotProposalCardState => ({
  ...state,
  status: 'failed',
  isApplying: false,
  reason,
})
