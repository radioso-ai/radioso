import { describe, expect, it } from 'vitest'

import { resolveAssistantRetrievalSettingsViewState } from '@/lib/assistant-retrieval-settings-view-state'
import type { AssistantBehaviorSettings } from '@/lib/api'

const behaviorSettings = (input: Partial<AssistantBehaviorSettings> = {}): AssistantBehaviorSettings => ({
  customInstruction: '',
  suggestedQuestionsEnabled: true,
  assistantLinkUtmEnabled: true,
  citationDisplayEnabled: true,
  contactRequestsEnabled: false,
  theme: {
    brand: '#0f172a',
    brandText: '#ffffff',
    surface: '#ffffff',
    text: '#0f172a',
  },
  retrievalEnabled: true,
  ...input,
})

describe('assistant retrieval settings view state', () => {
  it('renders override controls once behavior settings load even when retrieval defaults are absent', () => {
    expect(resolveAssistantRetrievalSettingsViewState({
      isAssistantBehaviorLoading: false,
      assistantBehaviorSettings: behaviorSettings(),
    })).toBe('controls')
  })

  it('does not render controls while behavior settings are still loading', () => {
    expect(resolveAssistantRetrievalSettingsViewState({
      isAssistantBehaviorLoading: true,
      assistantBehaviorSettings: null,
    })).toBe('loading')
  })
})
