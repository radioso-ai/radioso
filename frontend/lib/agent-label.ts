export interface AgentLabelSource {
  internalName?: string | null
  name?: string | null
}

const trimToValue = (value: string | null | undefined): string | null => {
  const trimmed = value?.trim()
  return trimmed ? trimmed : null
}

/** Label for operator surfaces: the internal label when set, else the visitor-facing name. */
export const getAgentOperatorLabel = (
  agent: AgentLabelSource | null | undefined,
  fallback = 'Agent',
): string => trimToValue(agent?.internalName) ?? trimToValue(agent?.name) ?? fallback

/** The visitor-facing name when it differs from the operator label. */
export const getAgentPublicNameHint = (agent: AgentLabelSource | null | undefined): string | null => {
  const publicName = trimToValue(agent?.name)
  const operatorLabel = trimToValue(agent?.internalName)
  return operatorLabel && publicName && operatorLabel !== publicName ? publicName : null
}
