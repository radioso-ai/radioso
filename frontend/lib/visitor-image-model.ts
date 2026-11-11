import type { KnownModelsByProvider, LlmCapabilityPreference, WorkspaceLlmModels } from '@/lib/api-llm-providers'

/**
 * Whether an agent's chat model reads photos, as the dashboard can tell it. The backend decides
 * for real when a visitor opens the chat; this lets the setting say so before then. A model in the
 * catalog reads images. An `openai-compatible` endpoint serves whatever model it names, and a model
 * outside the catalog is unvetted, so neither is assumed to.
 */
export const modelReadsImages = (selection: LlmCapabilityPreference, known: KnownModelsByProvider): boolean =>
  selection.provider !== 'openai-compatible' && known[selection.provider].includes(selection.model)

type AgentImageReading = 'reads' | 'cannot_read' | 'unknown'

/**
 * The agent's own model, else the plan's, else the workspace's chat preference. When none is set
 * the deployment's default decides, which the dashboard cannot see, so it does not say.
 */
export const agentImageReading = ({
  override,
  models,
}: {
  override: LlmCapabilityPreference | null | undefined
  models: Pick<WorkspaceLlmModels, 'chat' | 'managed' | 'knownModelsByProvider'> | null
}): AgentImageReading => {
  if (!models) {
    return 'unknown'
  }
  const selection = override ?? models.managed.chat ?? models.chat
  if (!selection) {
    return 'unknown'
  }
  return modelReadsImages(selection, models.knownModelsByProvider) ? 'reads' : 'cannot_read'
}
