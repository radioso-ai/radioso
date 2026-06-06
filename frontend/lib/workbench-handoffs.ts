import type { AgentConfigOverrideInput, EvalAssertion, EvalRunOverridesInput } from './api-eval'
import type { LowQualityTurn } from './api-quality'
import type { DashboardRouteState } from './dashboard-routes'

export const buildQualityTurnWorkbenchRoute = (
  turn: Pick<LowQualityTurn, 'conversationId' | 'assistantMessageId'> & { agentId: string },
  routeState: Pick<DashboardRouteState, 'workspaceId' | 'workspacePublicRouteKey'> = {},
): DashboardRouteState => ({
  section: 'agents',
  workspaceId: routeState.workspaceId,
  workspacePublicRouteKey: routeState.workspacePublicRouteKey,
  agentId: turn.agentId,
  agentTab: 'chat',
  workbenchConversationId: turn.conversationId,
  workbenchMessageId: turn.assistantMessageId,
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
    ...(hasAgentConfigOverride(agentConfigOverride)
      ? {
        runCase: {
          mode: 'full_assistant' as const,
          overrides: { agentConfigOverride },
        },
      }
      : {}),
  }
}
