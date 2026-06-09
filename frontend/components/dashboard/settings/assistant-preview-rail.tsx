'use client'

import { ArrowUpRight, Globe, Link as LinkIcon } from 'lucide-react'
import NextLink from 'next/link'

import { ChatPreview, ThemeContrastWarning } from '@/components/dashboard/settings/assistant-chat-preview'
import { DEFAULT_ASSISTANT_THEME } from '@/components/dashboard/settings/assistant-theme-form-helpers'
import type { AssistantBehaviorSettings, GeneralSettings, RetrievalDefaults } from '@/lib/api'

export interface AssistantPreviewRailProps {
  anonSettings: GeneralSettings
  assistantBehaviorSettings: AssistantBehaviorSettings
  retrievalDefaults: Pick<RetrievalDefaults, 'suggestedQuestionsEnabled'>
  channelsTabHref?: string
}

export function AssistantPreviewRail({
  anonSettings,
  assistantBehaviorSettings,
  retrievalDefaults,
  channelsTabHref,
}: AssistantPreviewRailProps) {
  const theme = assistantBehaviorSettings.theme ?? DEFAULT_ASSISTANT_THEME
  const publicChatOn = Boolean(anonSettings.anonymousChatEnabled)
  const websiteEmbedOn = Boolean(anonSettings.websiteEmbedEnabled)
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
        />
        <div className="space-y-2">
          <ThemeContrastWarning theme={theme} />
          <p className="text-xs text-muted-foreground">
            Updates as you edit. Uses sample conversation data rendered with the public chat and website widget components.
          </p>
        </div>
      </div>

      <div className="rounded-xl border border-border bg-card/95 p-4 shadow-sm">
        <div className="flex items-center justify-between gap-2">
          <p className="text-xs font-medium uppercase tracking-[0.18em] text-muted-foreground">
            Where it runs
          </p>
          {channelsTabHref ? (
            <NextLink
              href={channelsTabHref}
              className="inline-flex items-center gap-0.5 text-xs font-medium text-primary hover:underline"
            >
              Channels
              <ArrowUpRight className="h-3 w-3" />
            </NextLink>
          ) : null}
        </div>
        <ul className="mt-3 space-y-2 text-sm">
          <li className="flex items-center justify-between gap-3">
            <span className="flex items-center gap-2 text-foreground">
              <LinkIcon className="h-3.5 w-3.5 text-muted-foreground" />
              Public chat link
            </span>
            <span className={publicChatOn ? 'text-emerald-600 dark:text-emerald-400' : 'text-muted-foreground'}>
              {publicChatOn ? 'On' : 'Off'}
            </span>
          </li>
          <li className="flex items-center justify-between gap-3">
            <span className="flex items-center gap-2 text-foreground">
              <Globe className="h-3.5 w-3.5 text-muted-foreground" />
              Website chat widget
            </span>
            <span className={websiteEmbedOn ? 'text-emerald-600 dark:text-emerald-400' : 'text-muted-foreground'}>
              {websiteEmbedOn ? 'On' : 'Off'}
            </span>
          </li>
        </ul>
      </div>
    </aside>
  )
}
