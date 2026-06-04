import type { AssistantBehaviorSettings } from '@/lib/api'

export const resolveAssistantRetrievalSettingsViewState = ({
  isAssistantBehaviorLoading,
  assistantBehaviorSettings,
}: {
  isAssistantBehaviorLoading: boolean
  assistantBehaviorSettings: AssistantBehaviorSettings | null
}): 'loading' | 'controls' | 'disabled' | 'unavailable' => {
  if (isAssistantBehaviorLoading) {
    return 'loading'
  }
  if (!assistantBehaviorSettings) {
    return 'unavailable'
  }
  if (!(assistantBehaviorSettings.retrievalEnabled ?? true)) {
    return 'disabled'
  }
  return 'controls'
}
