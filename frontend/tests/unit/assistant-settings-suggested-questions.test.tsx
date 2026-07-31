/* @vitest-environment jsdom */

import { act, type ReactNode } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

import { AssistantBehaviorSection } from '@/components/dashboard/settings/assistant-behavior-section'
import { AssistantPreviewRail } from '@/components/dashboard/settings/assistant-preview-rail'
import type { AssistantBehaviorSettings, GeneralSettings, RetrievalDefaults } from '@/lib/api'

vi.mock('@/components/dashboard/settings/assistant-chat-preview', () => ({
  ChatPreview: ({ showSuggestedQuestions }: { showSuggestedQuestions: boolean }) => (
    <div data-testid="chat-preview">{showSuggestedQuestions ? 'suggestions:on' : 'suggestions:off'}</div>
  ),
  ThemeContrastWarning: () => null,
}))

vi.mock('next/link', () => ({
  default: ({ children, href }: { children: ReactNode; href: string }) => <a href={href}>{children}</a>,
}))

beforeAll(() => {
  ;(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
})

const generalSettings = (): GeneralSettings => ({
  anonymousChatEnabled: true,
  anonymousChatUrl: 'http://localhost:3000/chat/anon-token',
  anonymousChatLastUsedAt: null,
  websiteEmbedEnabled: true,
  websiteEmbedToken: 'embed-token',
  websiteEmbedLastUsedAt: null,
  websiteEmbedScriptUrl: 'http://localhost:3000/embed.js',
  websiteEmbedSnippet: '<script src="http://localhost:3000/embed.js"></script>',
  websiteEmbedAllowedOrigins: [],
  websiteEmbedLauncherLabel: 'Chat',
  websiteEmbedLauncherPosition: 'bottom-right',
  assistantName: 'Support Bot',
  greetingInstruction: '',
  assistantDefaultLocale: null,
  proactiveGreetingEnabled: false,
  assistantBootstrapActive: false,
  assistantLogoUrl: null,
  websiteEmbedTheme: {
    brand: '#0f172a',
    brandText: '#ffffff',
    surface: '#ffffff',
    text: '#0f172a',
  },
  websiteEmbedCopy: {},
  websiteEmbedExpertOverrides: {},
})

const behaviorSettings = (overrides: Partial<AssistantBehaviorSettings> = {}): AssistantBehaviorSettings => ({
  suggestedQuestionsEnabled: true,
  customInstruction: '',
  assistantLinkUtmEnabled: true,
  citationDisplayEnabled: true,
  contactRequestsEnabled: false,
  theme: {
    brand: '#0f172a',
    brandText: '#ffffff',
    surface: '#ffffff',
    text: '#0f172a',
  },
  branding: {
    hidePoweredBy: false,
    privacyPolicyUrl: null,
  },
  sourceScope: { mode: 'all' },
  retrievalEnabled: true,
  skillSettings: {},
  retrievalSkillSettings: {},
  ...overrides,
})

const retrievalDefaults = (overrides: Partial<RetrievalDefaults> = {}): RetrievalDefaults => ({
  queryRewriteEnabled: true,
  temporalStructuredLookupEnabled: true,
  temporalBoostUpcomingEnabled: true,
  temporalDeterministicSortEnabled: true,
  semanticRewriteInstructions: '',
  lexicalRewriteInstructions: '',
  suggestedQuestionsEnabled: true,
  suggestedQuestionsCount: 3,
  rerankEnabled: false,
  vectorTopK: 20,
  rerankTopK: 5,
  metadataRules: [],
  metadataFieldSuggestions: [],
  customInstruction: '',
  retrievalStrategy: 'fixed',
  ...overrides,
})

describe('assistant suggested question settings UI', () => {
  let container: HTMLDivElement
  let root: Root

  beforeEach(() => {
    container = document.createElement('div')
    document.body.appendChild(container)
    root = createRoot(container)
  })

  afterEach(() => {
    act(() => {
      root.unmount()
    })
    container.remove()
  })

  it('does not render the legacy behavior-section suggested questions toggle', () => {
    act(() => {
      root.render(
        <AssistantBehaviorSection
          anonSettings={generalSettings()}
          assistantBehaviorSettings={behaviorSettings()}
          assistantLocaleInput=""
          onAssistantSettingChange={() => undefined}
          onAssistantLocaleInputChange={() => undefined}
          onAssistantBehaviorDraft={() => undefined}
          isAnonSaving={false}
        />,
      )
    })

    expect(container.textContent).not.toContain('Suggested follow-up questions')
    expect(container.querySelector('#assistantSuggestedQuestionsEnabled')).toBeNull()
  })

  it('renders preview suggestions from the retrieval skill override before the legacy field', () => {
    act(() => {
      root.render(
        <AssistantPreviewRail
          anonSettings={generalSettings()}
          assistantBehaviorSettings={behaviorSettings({
            suggestedQuestionsEnabled: true,
            retrievalSkillSettings: { suggestedQuestionsEnabled: false },
          })}
          retrievalDefaults={retrievalDefaults({ suggestedQuestionsEnabled: true })}
        />,
      )
    })

    expect(container.textContent).toContain('suggestions:off')
  })

  it('renders preview suggestions from retrieval defaults when no agent override exists', () => {
    act(() => {
      root.render(
        <AssistantPreviewRail
          anonSettings={generalSettings()}
          assistantBehaviorSettings={behaviorSettings({
            suggestedQuestionsEnabled: true,
            retrievalSkillSettings: {},
          })}
          retrievalDefaults={retrievalDefaults({ suggestedQuestionsEnabled: false })}
        />,
      )
    })

    expect(container.textContent).toContain('suggestions:off')
  })
})
