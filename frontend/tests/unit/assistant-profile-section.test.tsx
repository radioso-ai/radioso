/* @vitest-environment jsdom */

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'

import { AssistantProfileSection } from '@/components/dashboard/settings/assistant-profile-section'
import type { AssistantBehaviorSettings, GeneralSettings } from '@/lib/api'

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

describe('assistant profile section', () => {
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

  const renderSection = (props: {
    anonSettings: GeneralSettings
    showInternalName?: boolean
    onAssistantSettingChange?: <K extends keyof GeneralSettings>(key: K, value: GeneralSettings[K]) => void
  }) => {
    act(() => {
      root.render(
        <AssistantProfileSection
          anonSettings={props.anonSettings}
          assistantBehaviorSettings={behaviorSettings()}
          assistantLocaleInput=""
          showInternalName={props.showInternalName}
          onAssistantSettingChange={props.onAssistantSettingChange ?? (() => undefined)}
          onAssistantLocaleInputChange={() => undefined}
          onAssistantBehaviorDraft={() => undefined}
          isAnonSaving={false}
        />,
      )
    })
  }

  it('hides the internal name field unless showInternalName is set', () => {
    renderSection({ anonSettings: generalSettings() })

    expect(container.querySelector('#agentInternalName')).toBeNull()
  })

  it('edits internalName through onAssistantSettingChange when shown', () => {
    const changes: Array<[string, unknown]> = []
    renderSection({
      anonSettings: { ...generalSettings(), internalName: 'Claudio (IT)' },
      showInternalName: true,
      onAssistantSettingChange: (key, value) => changes.push([key, value]),
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
