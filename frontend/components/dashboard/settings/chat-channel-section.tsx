'use client'

import { useMemo, useState } from 'react'
import { ChevronDown, ExternalLink, Link as LinkIcon, Pencil, Plus, RefreshCw, Sparkles, Trash2, Upload } from 'lucide-react'

import { CopyValueField } from '@/components/ui/copy-value-field'
import { AssistantPreviewRail } from '@/components/dashboard/settings/assistant-preview-rail'
import {
  ADVANCED_THEME_FIELDS,
  applyBrand,
  applySurface,
  applySurfaceMode,
  DEFAULT_ASSISTANT_THEME,
  getSurfaceMode,
} from '@/components/dashboard/settings/assistant-theme-form-helpers'
import { SettingsCard } from '@/components/dashboard/settings/settings-card'
import {
  WebsiteEmbedSettingsController,
  type WebsiteEmbedSettingsControllerProps,
} from '@/components/dashboard/settings/website-embed-settings-controller'
import { Button } from '@/components/ui/button'
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from '@/components/ui/collapsible'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Spinner } from '@/components/ui/spinner'
import { Switch } from '@/components/ui/switch'
import type {
  AgentBrandingSettings,
  AssistantBehaviorSettings,
  RetrievalDefaults,
} from '@/lib/api'
import { editionController } from '@/lib/edition-controller'
import type { WebsiteEmbedCopyOverrides } from '@/lib/embed-widget'
import { formatLastUsed } from '@/lib/format-last-used'
import { cn } from '@/lib/utils'

const DEFAULT_BRANDING_SETTINGS: AgentBrandingSettings = {
  hidePoweredBy: false,
  privacyPolicyUrl: null,
}

/** The locale pack edited by default; also the website widget's last-resort pack. */
const BASE_COPY_LOCALE = 'en'

const COPY_FIELDS = [
  ['publicChatSubtitle', 'Header subtitle', 'Ask questions and get AI-powered answers'],
  ['publicChatEmptyTitle', 'Empty-state title', 'Start a conversation'],
  ['publicChatEmptyMessage', 'Empty-state message', 'Ask a question and get an AI-powered answer.'],
  ['startPrompt', 'Composer placeholder', 'Ask a question...'],
  ['publicChatNewChatLabel', 'New chat button', 'Clear chat'],
  ['publicChatContactHumanLabel', 'Contact-human button', 'Talk to a human'],
  ['publicChatContactHumanMessage', 'Contact-human message', 'I want to talk to a human.'],
  ['publicChatDisclaimerTemplate', 'Disclaimer', '{name} uses AI and can make mistakes.'],
  ['publicChatOpenFullScreenLabel', 'Full-screen button', 'Open full screen'],
  ['publicChatOpenNewTabLabel', 'New-tab menu item', 'Open in new tab'],
] as const

function BlockHeading({ title, description }: { title: string; description: string }) {
  return (
    <div className="space-y-0.5">
      <h3 className="text-sm font-semibold text-foreground">{title}</h3>
      <p className="text-xs text-muted-foreground">{description}</p>
    </div>
  )
}

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
  const [isAddingLocale, setIsAddingLocale] = useState(false)
  const [newLocaleDraft, setNewLocaleDraft] = useState('')
  const [isWordingOpen, setIsWordingOpen] = useState(false)

  const copyPacks = useMemo(() => anonSettings?.websiteEmbedCopy ?? {}, [anonSettings?.websiteEmbedCopy])
  const translationLocales = useMemo(
    () => Object.keys(copyPacks).filter((locale) => locale !== BASE_COPY_LOCALE).sort(),
    [copyPacks],
  )
  const activeCopyPack: WebsiteEmbedCopyOverrides = copyPacks[activeCopyLocale] ?? {}
  const basePack: WebsiteEmbedCopyOverrides = copyPacks[BASE_COPY_LOCALE] ?? {}
  const customizedCopyCount = COPY_FIELDS.filter(
    ([key]) => (basePack[key] ?? '').trim().length > 0,
  ).length
  const isEditingTranslation = activeCopyLocale !== BASE_COPY_LOCALE

  const handleCopyFieldChange = (key: string, value: string) => {
    if (!anonSettings) return
    const locale = activeCopyLocale.trim() || BASE_COPY_LOCALE
    const nextCopy = { ...(anonSettings.websiteEmbedCopy ?? {}) }
    const nextPack = { ...(nextCopy[locale] ?? {}) }
    if (value.trim()) {
      nextPack[key] = value
    } else {
      delete nextPack[key]
    }
    if (Object.keys(nextPack).length > 0) {
      nextCopy[locale] = nextPack
    } else {
      delete nextCopy[locale]
    }
    anonDraftVersionRef.current += 1
    setAnonSettings({ ...anonSettings, websiteEmbedCopy: nextCopy })
  }

  if (!anonSettings || !assistantBehaviorSettings) {
    return <p className="text-sm text-muted-foreground">Failed to load chat settings.</p>
  }

  const theme = assistantBehaviorSettings.theme ?? DEFAULT_ASSISTANT_THEME
  const surfaceMode = getSurfaceMode(theme)
  const branding = assistantBehaviorSettings.branding ?? DEFAULT_BRANDING_SETTINGS
  const canHideBranding = editionController.canHideAssistantBranding()
  const logoUrl = anonSettings.assistantLogoUrl

  const updateBranding = (next: AgentBrandingSettings) => {
    onAssistantBehaviorDraft((current) => ({ ...current, branding: next }))
  }

  return (
    <section id="web-chat" className="scroll-mt-24">
      <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_22rem] lg:items-start">
        <div className="space-y-6">
          <SettingsCard
            id="chat-look"
            icon={<Sparkles className="h-5 w-5 text-primary" />}
            title="Look"
            description="Logo and colors, used everywhere this chat appears."
          >
            <div className="space-y-6">
              <LogoField
                logoUrl={logoUrl ?? null}
                busy={isAnonSaving || isAssistantLogoSaving}
                isSaving={isAssistantLogoSaving}
                onUpload={onAssistantLogoUpload}
                onDelete={onAssistantLogoDelete}
              />

              <div className="space-y-1">
                <Label htmlFor="assistantTheme-brand" className="text-foreground">Brand color</Label>
                <div className="flex items-center gap-2">
                  <Input
                    id="assistantTheme-brand"
                    type="color"
                    value={theme.brand}
                    onChange={(event) =>
                      onAssistantBehaviorDraft((current) => ({
                        ...current,
                        theme: applyBrand(current.theme ?? DEFAULT_ASSISTANT_THEME, event.target.value),
                      }))
                    }
                    className="h-9 w-14 cursor-pointer p-1"
                  />
                  <span className="text-xs font-mono text-muted-foreground">{theme.brand}</span>
                </div>
                <p className="text-xs text-muted-foreground">
                  Drives the chat header, user message bubbles, and the send button.
                </p>
              </div>

              <div className="space-y-2">
                <Label className="text-foreground">Surface style</Label>
                <div className="inline-flex rounded-md border border-border bg-muted/40 p-0.5" role="group">
                  {(['light', 'dark', 'custom'] as const).map((surfaceOption) => {
                    const isActive = surfaceMode === surfaceOption
                    return (
                      <button
                        key={surfaceOption}
                        type="button"
                        className={cn(
                          'rounded-sm px-3 py-1 text-xs font-medium capitalize transition-colors',
                          isActive ? 'bg-background text-foreground shadow-sm' : 'text-muted-foreground hover:text-foreground',
                        )}
                        onClick={() => {
                          if (surfaceOption === 'custom') {
                            if (surfaceMode !== 'custom') {
                              onAssistantBehaviorDraft((current) => ({
                                ...current,
                                theme: applySurface(current.theme ?? DEFAULT_ASSISTANT_THEME, '#f6f7f9'),
                              }))
                            }
                            return
                          }
                          onAssistantBehaviorDraft((current) => ({
                            ...current,
                            theme: applySurfaceMode(current.theme ?? DEFAULT_ASSISTANT_THEME, surfaceOption),
                          }))
                        }}
                      >
                        {surfaceOption}
                      </button>
                    )
                  })}
                </div>
                <p className="text-xs text-muted-foreground">
                  Background of the message area. Pick Light or Dark for a sensible neutral, or Custom to choose any color.
                </p>
                {surfaceMode === 'custom' ? (
                  <div className="flex items-center gap-2 pt-1">
                    <Input
                      id="assistantTheme-surface"
                      type="color"
                      value={theme.surface}
                      onChange={(event) =>
                        onAssistantBehaviorDraft((current) => ({
                          ...current,
                          theme: applySurface(current.theme ?? DEFAULT_ASSISTANT_THEME, event.target.value),
                        }))
                      }
                      className="h-9 w-14 cursor-pointer p-1"
                    />
                    <span className="text-xs font-mono text-muted-foreground">{theme.surface}</span>
                  </div>
                ) : null}
              </div>

              <Collapsible className="space-y-3">
                <CollapsibleTrigger className="group inline-flex items-center gap-1 text-xs font-medium text-muted-foreground hover:text-foreground">
                  <ChevronDown className="h-3 w-3 transition-transform group-data-[state=open]:rotate-180" />
                  Advanced colors
                </CollapsibleTrigger>
                <CollapsibleContent>
                  <div className="grid gap-3 sm:grid-cols-2">
                    {ADVANCED_THEME_FIELDS.map(({ key, label, hint }) => (
                      <div key={key} className="space-y-1">
                        <Label htmlFor={`assistantTheme-${key}`} className="text-foreground">{label}</Label>
                        <div className="flex items-center gap-2">
                          <Input
                            id={`assistantTheme-${key}`}
                            type="color"
                            value={theme[key]}
                            onChange={(event) =>
                              onAssistantBehaviorDraft((current) => ({
                                ...current,
                                theme: {
                                  ...(current.theme ?? DEFAULT_ASSISTANT_THEME),
                                  [key]: event.target.value,
                                },
                              }))
                            }
                            className="h-9 w-14 cursor-pointer p-1"
                          />
                          <span className="text-xs font-mono text-muted-foreground">{theme[key]}</span>
                        </div>
                        <p className="text-xs text-muted-foreground">{hint}</p>
                      </div>
                    ))}
                  </div>
                </CollapsibleContent>
              </Collapsible>
            </div>
          </SettingsCard>

          <SettingsCard
            id="chat-wording"
            icon={<Pencil className="h-5 w-5 text-primary" />}
            title="Wording"
            description="What visitors read around the conversation — buttons, placeholders, and the disclaimer."
          >
            <Collapsible
              open={isWordingOpen || isEditingTranslation}
              onOpenChange={setIsWordingOpen}
              className="space-y-4"
            >
              <div className="flex flex-wrap items-center justify-between gap-2">
                <p className="text-sm text-muted-foreground">
                  {customizedCopyCount === 0
                    ? 'Using the built-in wording.'
                    : `${customizedCopyCount} of ${COPY_FIELDS.length} phrases customized.`}
                  {translationLocales.length > 0
                    ? ` ${translationLocales.length} added ${translationLocales.length === 1 ? 'translation' : 'translations'}.`
                    : ''}
                </p>
                <CollapsibleTrigger className="group inline-flex items-center gap-1 text-xs font-medium text-muted-foreground hover:text-foreground">
                  <ChevronDown className="h-3 w-3 transition-transform group-data-[state=open]:rotate-180" />
                  Edit wording
                </CollapsibleTrigger>
              </div>
              <CollapsibleContent className="space-y-4">
              {isEditingTranslation ? (
                <div className="flex flex-wrap items-center gap-2 rounded-lg border border-border bg-muted/40 px-3 py-2">
                  <span className="text-xs text-muted-foreground">
                    Editing the <code>{activeCopyLocale}</code> translation.
                  </span>
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    className="h-7"
                    onClick={() => setActiveCopyLocale(BASE_COPY_LOCALE)}
                  >
                    Back to default wording
                  </Button>
                </div>
              ) : null}

              <div className="grid gap-4 sm:grid-cols-2">
                {COPY_FIELDS.map(([key, label, placeholder]) => (
                  <div key={key} className="space-y-2">
                    <Label htmlFor={`websiteEmbedCopy-${key}`} className="text-foreground">{label}</Label>
                    <Input
                      id={`websiteEmbedCopy-${key}`}
                      value={activeCopyPack[key] ?? ''}
                      onChange={(event) => handleCopyFieldChange(key, event.target.value)}
                      placeholder={placeholder}
                    />
                  </div>
                ))}
              </div>

              <p className="text-xs text-muted-foreground">
                Leave a field blank to use the built-in wording.
              </p>

              <div className="space-y-3 rounded-xl border border-border bg-background/60 p-4">
                <BlockHeading
                  title="Translations"
                  description="Spanish, French, German, Italian, Portuguese, Dutch, Polish, Chinese, Japanese, and Russian are built in. Add a language here only to override its wording."
                />
                <div className="flex flex-wrap items-center gap-2">
                  {translationLocales.map((locale) => (
                    <Button
                      key={locale}
                      type="button"
                      variant={activeCopyLocale === locale ? 'default' : 'outline'}
                      size="sm"
                      className="h-7"
                      onClick={() => setActiveCopyLocale(locale)}
                    >
                      {locale}
                    </Button>
                  ))}
                  {isAddingLocale ? (
                    <form
                      className="flex items-center gap-2"
                      onSubmit={(event) => {
                        event.preventDefault()
                        const next = newLocaleDraft.trim()
                        if (!next || next === BASE_COPY_LOCALE) {
                          setIsAddingLocale(false)
                          setNewLocaleDraft('')
                          return
                        }
                        setActiveCopyLocale(next)
                        setIsAddingLocale(false)
                        setNewLocaleDraft('')
                      }}
                    >
                      <Input
                        id="websiteEmbedCopyLocale"
                        aria-label="Language code"
                        value={newLocaleDraft}
                        onChange={(event) => setNewLocaleDraft(event.target.value)}
                        placeholder="it, fr-CA"
                        className="h-7 w-28"
                        autoFocus
                      />
                      <Button type="submit" size="sm" className="h-7">Add</Button>
                    </form>
                  ) : (
                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      className="h-7"
                      onClick={() => setIsAddingLocale(true)}
                    >
                      <Plus className="mr-1 h-3 w-3" />
                      Add a translation
                    </Button>
                  )}
                </div>
                <p className="text-xs text-muted-foreground">
                  Use the short language code (e.g. <code>it</code> for Italian, <code>fr-CA</code> for Canadian French).
                </p>
              </div>
              </CollapsibleContent>
            </Collapsible>
          </SettingsCard>

          <SettingsCard
            id="chat-footer"
            icon={<ExternalLink className="h-5 w-5 text-primary" />}
            title="Footer"
            description="What appears below the chat composer."
          >
            <div className="divide-y divide-border rounded-lg border border-border">
              <div className="space-y-2 p-3">
                <Label htmlFor="brandingPrivacyPolicyUrl" className="text-foreground">
                  Privacy policy URL
                </Label>
                <Input
                  id="brandingPrivacyPolicyUrl"
                  type="url"
                  inputMode="url"
                  placeholder="https://example.com/privacy"
                  value={branding.privacyPolicyUrl ?? ''}
                  maxLength={2048}
                  onChange={(event) => {
                    const trimmed = event.target.value.trim()
                    updateBranding({
                      ...branding,
                      privacyPolicyUrl: trimmed.length > 0 ? event.target.value : null,
                    })
                  }}
                />
                <p className="text-xs text-muted-foreground">
                  When set, a &ldquo;Privacy&rdquo; link is shown in the chat footer.
                </p>
              </div>
              {canHideBranding ? (
                <div className="flex items-start justify-between gap-4 p-3">
                  <div className="min-w-0">
                    <Label htmlFor="brandingHidePoweredBy" className="text-foreground">
                      Hide &ldquo;Answers by Radioso&rdquo;
                    </Label>
                    <p className="text-sm text-muted-foreground mt-0.5">
                      Removes Radioso attribution from the chat footer.
                    </p>
                  </div>
                  <Switch
                    id="brandingHidePoweredBy"
                    checked={branding.hidePoweredBy}
                    onCheckedChange={(checked) => updateBranding({ ...branding, hidePoweredBy: checked })}
                  />
                </div>
              ) : null}
            </div>
          </SettingsCard>

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

export function LogoField({
  logoUrl,
  busy,
  isSaving,
  onUpload,
  onDelete,
}: {
  logoUrl: string | null
  busy: boolean
  isSaving: boolean
  onUpload: (file: File | null) => void
  onDelete: () => void
}) {
  const [failedLogoUrl, setFailedLogoUrl] = useState<string | null>(null)
  const [fileInput, setFileInput] = useState<HTMLInputElement | null>(null)
  const hasLogo = Boolean(logoUrl)
  const showLogo = Boolean(logoUrl && failedLogoUrl !== logoUrl)

  return (
    <div className="space-y-2">
      <Label className="text-foreground">Logo</Label>
      <div className="flex items-center gap-3">
        <div className="relative h-11 w-11">
          <div className="flex h-full w-full items-center justify-center overflow-hidden rounded-2xl border border-border bg-background">
            {showLogo ? (
              // eslint-disable-next-line @next/next/no-img-element
              <img
                src={logoUrl ?? ''}
                alt=""
                className="h-full w-full object-contain"
                onError={() => setFailedLogoUrl(logoUrl)}
              />
            ) : (
              <Sparkles className="h-5 w-5 text-primary" />
            )}
          </div>
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <button
                type="button"
                aria-label="Edit assistant logo"
                disabled={busy}
                className="absolute -bottom-1 -right-1 flex h-5 w-5 items-center justify-center rounded-full border border-border bg-background text-foreground shadow-sm transition-colors hover:bg-muted disabled:cursor-not-allowed disabled:opacity-60"
              >
                {isSaving ? <Spinner className="h-3 w-3" /> : <Pencil className="h-3 w-3" />}
              </button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="start">
              <DropdownMenuItem
                onSelect={(event) => {
                  event.preventDefault()
                  fileInput?.click()
                }}
              >
                <Upload className="mr-2 h-4 w-4" />
                {hasLogo ? 'Replace' : 'Upload'}
              </DropdownMenuItem>
              <DropdownMenuItem onSelect={() => onDelete()} disabled={!hasLogo}>
                <Trash2 className="mr-2 h-4 w-4" />
                Remove
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
          <input
            ref={setFileInput}
            type="file"
            accept="image/png,image/jpeg,image/webp,image/gif"
            className="sr-only"
            onChange={(event) => {
              onUpload(event.target.files?.[0] ?? null)
              event.currentTarget.value = ''
            }}
          />
        </div>
        <p className="text-xs text-muted-foreground">
          Shown in the chat header and beside each answer.
        </p>
      </div>
    </div>
  )
}
