import { afterEach, describe, expect, it, vi } from 'vitest'

import type { AgentSettings, AssistantBehaviorSettings } from '@/lib/api-types'

const requestMock = vi.fn()

vi.mock('@/lib/api-client', () => ({
  request: requestMock,
}))

const behaviorSettings = (handoffOnRetrievalMiss: boolean): AssistantBehaviorSettings => ({
  suggestedQuestionsEnabled: true,
  customInstruction: '',
  assistantLinkUtmEnabled: true,
  citationDisplayEnabled: true,
  contactRequestsEnabled: false,
  webhookExportsEnabled: false,
  handoffOnRetrievalMiss,
  contactRequestDelivery: { recipientEmails: [], webhook: null },
  theme: {
    brand: '#0f172a',
    brandText: '#ffffff',
    surface: '#ffffff',
    text: '#0f172a',
  },
  branding: { hidePoweredBy: false, privacyPolicyUrl: null },
  sourceScope: { mode: 'all' },
  chatModelOverride: null,
  retrievalEnabled: true,
  skillSettings: {},
  retrievalSkillSettings: {},
})

const responseAgent = (behavior: AssistantBehaviorSettings): AgentSettings => ({
  ...behavior,
  id: 'agent-1',
  workspaceId: 'workspace-1',
  name: 'Support',
  internalName: '',
  createdAt: '2026-09-01T10:00:00.000Z',
  updatedAt: '2026-09-01T10:00:00.000Z',
  isDefault: true,
  logo: null,
  greetingInstruction: '',
  assistantDefaultLocale: null,
  proactiveGreetingEnabled: false,
  assistantBootstrapActive: false,
  surfaceSettings: {
    authenticatedChat: { enabled: true },
    anonymousChat: { enabled: false, token: null },
    websiteEmbed: {
      enabled: false,
      token: null,
      allowedOrigins: [],
      launcherLabel: 'Chat',
      launcherPosition: 'bottom-right',
      theme: behavior.theme,
      copy: {},
      expertOverrides: {},
    },
  },
} as AgentSettings)

describe('agentsApi.updateBehaviorSettings', () => {
  afterEach(() => requestMock.mockReset())

  it('sends a retrieval-miss handoff change in the agent update payload', async () => {
    const saved = behaviorSettings(false)
    const next = behaviorSettings(true)
    requestMock.mockResolvedValueOnce(responseAgent(next))

    const { agentsApi } = await import('@/lib/api-settings')
    await agentsApi.updateBehaviorSettings('agent-1', next, saved)

    expect(requestMock).toHaveBeenCalledWith(
      '/agents/agent-1',
      { method: 'PUT', body: JSON.stringify({ handoffOnRetrievalMiss: true }) },
      { withSession: true },
    )
  })
})
