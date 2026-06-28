import type { AgentConfigOverrideInput, EvalAssertion, EvalRunOverridesInput } from './api-eval'
import type { DashboardRouteState } from './dashboard-routes'

export const buildQualityTurnEvalRoute = (
  caseId: string,
  routeState: Pick<DashboardRouteState, 'workspaceId' | 'workspacePublicRouteKey'> = {},
): DashboardRouteState => ({
  section: 'eval',
  workspaceId: routeState.workspaceId,
  workspacePublicRouteKey: routeState.workspacePublicRouteKey,
  evalCaseId: caseId,
})

const hasAgentConfigOverride = (override: AgentConfigOverrideInput | undefined): override is AgentConfigOverrideInput =>
  Boolean(override && Object.keys(override).length > 0)

export interface EvalPromotionPayloadInput {
  conversationId: string
  assistantMessageId: string
  snapshotId: string
  name: string
  originalAnswer?: string
  agentConfigOverride?: AgentConfigOverrideInput
}

export interface EvalPromotionPayload {
  captureSnapshot: { conversationId: string; messageId: string }
  createCase: {
    snapshotId: string
    name: string
    assertions: EvalAssertion[]
  }
  runCase?: {
    mode: 'full_assistant'
    overrides: EvalRunOverridesInput
  }
}

export const buildEvalPromotionPayload = ({
  conversationId,
  assistantMessageId,
  snapshotId,
  name,
  originalAnswer,
  agentConfigOverride,
}: EvalPromotionPayloadInput): EvalPromotionPayload => {
  const trimmedAnswer = originalAnswer?.trim()
  const assertions: EvalAssertion[] = trimmedAnswer
    ? [{ type: 'llm_judge', expectedAnswer: trimmedAnswer }]
    : []

  return {
    captureSnapshot: {
      conversationId,
      messageId: assistantMessageId,
    },
    createCase: {
      snapshotId,
      name,
      assertions,
    },
    ...(trimmedAnswer || hasAgentConfigOverride(agentConfigOverride)
      ? {
        runCase: {
          mode: 'full_assistant' as const,
          overrides: hasAgentConfigOverride(agentConfigOverride) ? { agentConfigOverride } : {},
        },
      }
      : {}),
  }
}
