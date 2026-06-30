/* @vitest-environment jsdom */

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'

import { AssistantIdentityAppearanceSection } from '@/components/dashboard/settings/assistant-identity-appearance-section'
import type { AssistantBehaviorSettings, GeneralSettings } from '@/lib/api'

beforeAll(() => {
  ;(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
})

const generalSettings = (assistantLogoUrl: string | null): GeneralSettings => ({
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
  assistantLogoUrl,
  websiteEmbedTheme: {
    brand: '#0f172a',
    brandText: '#ffffff',
    surface: '#ffffff',
    text: '#0f172a',
  },
  websiteEmbedCopy: {},
  websiteEmbedExpertOverrides: {},
})

const behaviorSettings = (): AssistantBehaviorSettings => ({
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
})

describe('assistant identity appearance section', () => {
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

  it('falls back from a broken admin logo image and retries when the logo URL changes', () => {
    const renderSection = (logoUrl: string) => {
      root.render(
        <AssistantIdentityAppearanceSection
          anonSettings={generalSettings(logoUrl)}
          assistantBehaviorSettings={behaviorSettings()}
          onAssistantSettingChange={() => undefined}
          onAssistantBehaviorDraft={() => undefined}
          onAssistantLogoUpload={() => undefined}
          onAssistantLogoDelete={() => undefined}
          isAnonSaving={false}
          isAssistantLogoSaving={false}
        />,
      )
    }

    act(() => {
      renderSection('/backend/api/v1/public/chat/old-token/assistant-logo')
    })
    expect(container.querySelector('img[src="/backend/api/v1/public/chat/old-token/assistant-logo"]')).not.toBeNull()

    act(() => {
      container.querySelector('img')?.dispatchEvent(new Event('error', { bubbles: true }))
    })
    expect(container.querySelector('img')).toBeNull()

    act(() => {
      renderSection('/backend/api/v1/public/chat/new-token/assistant-logo')
    })
    expect(container.querySelector('img[src="/backend/api/v1/public/chat/new-token/assistant-logo"]')).not.toBeNull()
  })

  it('hides the internal name field unless showInternalName is set', () => {
    act(() => {
      root.render(
        <AssistantIdentityAppearanceSection
          anonSettings={generalSettings(null)}
          assistantBehaviorSettings={behaviorSettings()}
          onAssistantSettingChange={() => undefined}
          onAssistantBehaviorDraft={() => undefined}
          onAssistantLogoUpload={() => undefined}
          onAssistantLogoDelete={() => undefined}
          isAnonSaving={false}
          isAssistantLogoSaving={false}
        />,
      )
    })
    expect(container.querySelector('#agentInternalName')).toBeNull()
  })

  it('edits internalName through onAssistantSettingChange when shown', () => {
    const changes: Array<[string, unknown]> = []
    act(() => {
      root.render(
        <AssistantIdentityAppearanceSection
          anonSettings={{ ...generalSettings(null), internalName: 'Claudio (IT)' }}
          assistantBehaviorSettings={behaviorSettings()}
          showInternalName
          onAssistantSettingChange={(key, value) => changes.push([key, value])}
          onAssistantBehaviorDraft={() => undefined}
          onAssistantLogoUpload={() => undefined}
          onAssistantLogoDelete={() => undefined}
          isAnonSaving={false}
          isAssistantLogoSaving={false}
        />,
      )
    })
    const input = container.querySelector<HTMLInputElement>('#agentInternalName')
    expect(input).not.toBeNull()
    expect(input?.value).toBe('Claudio (IT)')

    const nativeSetter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')?.set
    act(() => {
      nativeSetter?.call(input, 'Claudio (EN)')
      input?.dispatchEvent(new Event('input', { bubbles: true }))
    })
    expect(changes).toContainEqual(['internalName', 'Claudio (EN)'])
  })
})
