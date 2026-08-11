'use client'

import { ChatPreview, ThemeContrastWarning } from '@/components/dashboard/settings/assistant-chat-preview'
import { DEFAULT_ASSISTANT_THEME } from '@/components/dashboard/settings/assistant-theme-form-helpers'
import type { AssistantBehaviorSettings, GeneralSettings, RetrievalDefaults } from '@/lib/api'
import type { WebsiteEmbedCopyOverrides } from '@/lib/embed-widget'

export interface AssistantPreviewRailProps {
  anonSettings: GeneralSettings
  assistantBehaviorSettings: AssistantBehaviorSettings
  retrievalDefaults: Pick<RetrievalDefaults, 'suggestedQuestionsEnabled'>
  /** Wording pack currently being edited, so the preview tracks unsaved edits. */
  copyOverrides?: WebsiteEmbedCopyOverrides | null
}

export function AssistantPreviewRail({
  anonSettings,
  assistantBehaviorSettings,
  retrievalDefaults,
  copyOverrides,
}: AssistantPreviewRailProps) {
  const theme = assistantBehaviorSettings.theme ?? DEFAULT_ASSISTANT_THEME
  const showSuggestedQuestions =
    assistantBehaviorSettings.retrievalSkillSettings?.suggestedQuestionsEnabled ??
    retrievalDefaults.suggestedQuestionsEnabled

  return (
    <aside className="lg:sticky lg:top-4 lg:self-start space-y-4" aria-label="Assistant preview">
      <div className="space-y-2">
        <p className="text-xs font-medium uppercase tracking-[0.18em] text-muted-foreground">
          Live preview
        </p>
        <ChatPreview
          themeSettings={theme}
          assistantName={anonSettings.assistantName}
          logoUrl={anonSettings.assistantLogoUrl ?? null}
          showSuggestedQuestions={showSuggestedQuestions}
          showProactiveGreeting={anonSettings.proactiveGreetingEnabled}
          assistantLinkUtmEnabled={assistantBehaviorSettings.assistantLinkUtmEnabled}
          branding={assistantBehaviorSettings.branding ?? null}
          copyOverrides={copyOverrides}
        />
        <div className="space-y-2">
          <ThemeContrastWarning theme={theme} />
          <p className="text-xs text-muted-foreground">
            Updates as you edit. Uses sample conversation data rendered with the public chat and website widget components.
          </p>
        </div>
      </div>
    </aside>
  )
}
