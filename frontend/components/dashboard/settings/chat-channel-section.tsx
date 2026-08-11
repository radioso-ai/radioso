'use client'

import { useState } from 'react'
import { ExternalLink, Link as LinkIcon, RefreshCw } from 'lucide-react'

import { CopyValueField } from '@/components/ui/copy-value-field'
import { AssistantPreviewRail } from '@/components/dashboard/settings/assistant-preview-rail'
import { DEFAULT_ASSISTANT_THEME } from '@/components/dashboard/settings/assistant-theme-form-helpers'
import { BlockHeading } from '@/components/dashboard/settings/block-heading'
import { ChatFooterCard } from '@/components/dashboard/settings/chat-footer-card'
import { ChatLookCard } from '@/components/dashboard/settings/chat-look-card'
import {
  BASE_COPY_LOCALE,
  ChatWordingCard,
} from '@/components/dashboard/settings/chat-wording-card'
import { SettingsCard } from '@/components/dashboard/settings/settings-card'
import {
  WebsiteEmbedSettingsController,
  type WebsiteEmbedSettingsControllerProps,
} from '@/components/dashboard/settings/website-embed-settings-controller'
import { Button } from '@/components/ui/button'
import { Label } from '@/components/ui/label'
import { Spinner } from '@/components/ui/spinner'
import { Switch } from '@/components/ui/switch'
import type {
  AgentBrandingSettings,
  AssistantBehaviorSettings,
  RetrievalDefaults,
  WebsiteEmbedCopyPacks,
  WebsiteEmbedThemeSettings,
} from '@/lib/api'
import type { WebsiteEmbedCopyOverrides } from '@/lib/embed-widget'
import { formatLastUsed } from '@/lib/format-last-used'

/**
 * Everything the website widget placement needs is also what this page needs, so the
 * widget's contract is the shared port rather than a second copy of the same fields.
 */
export interface ChatChannelSectionProps extends WebsiteEmbedSettingsControllerProps {
  assistantBehaviorSettings: AssistantBehaviorSettings | null
  retrievalDefaults: Pick<RetrievalDefaults, 'suggestedQuestionsEnabled'>
  onAssistantBehaviorDraft: (updater: (current: AssistantBehaviorSettings) => AssistantBehaviorSettings) => void
  onAssistantLogoUpload: (file: File | null) => void
  onAssistantLogoDelete: () => void
  onAnonymousChatToggle: (enabled: boolean) => void
  onAnonymousChatTokenRotate: () => void
  isAssistantLogoSaving: boolean
}

/**
 * The public link and the website widget are two placements of one chat surface, so
 * look, wording, and footer are configured once here and both placements inherit them.
 */
export function ChatChannelSection(props: ChatChannelSectionProps) {
  const {
    anonSettings,
    assistantBehaviorSettings,
    retrievalDefaults,
    onAssistantBehaviorDraft,
    onAssistantLogoUpload,
    onAssistantLogoDelete,
    onAnonymousChatToggle,
    onAnonymousChatTokenRotate,
    isAnonSaving,
    isAssistantLogoSaving,
    setAnonSettings,
    anonDraftVersionRef,
  } = props
  const [activeCopyLocale, setActiveCopyLocale] = useState(BASE_COPY_LOCALE)

  const handleCopyPacksChange = (next: NonNullable<WebsiteEmbedCopyPacks>) => {
    if (!anonSettings) return
    anonDraftVersionRef.current += 1
    setAnonSettings({ ...anonSettings, websiteEmbedCopy: next })
  }

  const handleThemeChange = (
    updater: (current: WebsiteEmbedThemeSettings) => WebsiteEmbedThemeSettings,
  ) => {
    onAssistantBehaviorDraft((current) => ({
      ...current,
      theme: updater(current.theme ?? DEFAULT_ASSISTANT_THEME),
    }))
  }

  const handleBrandingChange = (next: AgentBrandingSettings) => {
    onAssistantBehaviorDraft((current) => ({ ...current, branding: next }))
  }

  if (!anonSettings || !assistantBehaviorSettings) {
    return <p className="text-sm text-muted-foreground">Failed to load chat settings.</p>
  }

  const copyPacks = anonSettings.websiteEmbedCopy ?? {}
  const activeCopyPack: WebsiteEmbedCopyOverrides = copyPacks[activeCopyLocale] ?? {}

  return (
    <section id="web-chat" className="scroll-mt-24">
      <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_22rem] lg:items-start">
        <div className="space-y-6">
          <ChatLookCard
            theme={assistantBehaviorSettings.theme ?? DEFAULT_ASSISTANT_THEME}
            logoUrl={anonSettings.assistantLogoUrl ?? null}
            isLogoBusy={isAnonSaving || isAssistantLogoSaving}
            isLogoSaving={isAssistantLogoSaving}
            onThemeChange={handleThemeChange}
            onLogoUpload={onAssistantLogoUpload}
            onLogoDelete={onAssistantLogoDelete}
          />

          <ChatWordingCard
            copyPacks={copyPacks}
            activeLocale={activeCopyLocale}
            onActiveLocaleChange={setActiveCopyLocale}
            onCopyPacksChange={handleCopyPacksChange}
          />

          <ChatFooterCard
            branding={assistantBehaviorSettings.branding ?? null}
            onBrandingChange={handleBrandingChange}
          />

          <div className="space-y-4">
            <BlockHeading
              title="Where it runs"
              description="Turn on the places visitors can reach this chat. Both use the look and wording above."
            />

            <SettingsCard
              id="public-chat-link"
              icon={<LinkIcon className="h-5 w-5 text-primary" />}
              title="Public link"
              description="A shareable URL anyone can open without signing in."
              headerEnd={
                <Switch
                  id="anonChatToggle"
                  checked={anonSettings.anonymousChatEnabled}
                  onCheckedChange={onAnonymousChatToggle}
                  disabled={isAnonSaving}
                />
              }
            >
              <div className="mb-3 flex flex-wrap items-center gap-2 text-xs">
                <span className="text-muted-foreground">
                  {formatLastUsed(anonSettings.anonymousChatLastUsedAt)}
                </span>
              </div>
              {anonSettings.anonymousChatEnabled && anonSettings.anonymousChatUrl ? (
                <div className="space-y-3 rounded-xl bg-muted/50 p-4">
                  <div className="flex items-center gap-2 text-foreground">
                    <LinkIcon className="h-4 w-4" />
                    <Label className="text-foreground">Share this link</Label>
                  </div>
                  <p className="text-xs text-muted-foreground">
                    Send this URL to anyone who needs the chat. They can open it without signing in.
                  </p>
                  <CopyValueField
                    value={anonSettings.anonymousChatUrl}
                    ariaLabel="Copy public chat link"
                    className="w-full"
                  />
                  <div className="flex flex-wrap items-center justify-between gap-2 pt-1">
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={onAnonymousChatTokenRotate}
                      disabled={isAnonSaving}
                      className="text-muted-foreground hover:text-foreground"
                      title="Generates a new public chat URL. The current link will stop working."
                    >
                      {isAnonSaving ? <Spinner className="mr-2 h-4 w-4" /> : <RefreshCw className="mr-2 h-4 w-4" />}
                      Generate new link
                    </Button>
                    <Button asChild variant="default">
                      <a href={anonSettings.anonymousChatUrl} target="_blank" rel="noreferrer">
                        <ExternalLink className="mr-2 h-4 w-4" />
                        Try the chat
                      </a>
                    </Button>
                  </div>
                </div>
              ) : null}
            </SettingsCard>

            <WebsiteEmbedSettingsController {...props} />
          </div>
        </div>

        <AssistantPreviewRail
          anonSettings={anonSettings}
          assistantBehaviorSettings={assistantBehaviorSettings}
          retrievalDefaults={retrievalDefaults}
          copyOverrides={activeCopyPack}
        />
      </div>
    </section>
  )
}
