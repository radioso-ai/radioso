'use client'

import { useMemo, useState } from 'react'
import { ChevronDown, Database, Search, Sparkles, Trash2, Upload } from 'lucide-react'

import { ChatPreview, ThemeContrastWarning } from '@/components/dashboard/settings/assistant-chat-preview'
import { AssistantLocaleCombobox } from '@/components/dashboard/settings/assistant-locale-combobox'
import {
  ADVANCED_THEME_FIELDS,
  applyBrand,
  applySurface,
  applySurfaceMode,
  DEFAULT_ASSISTANT_THEME,
  getSurfaceMode,
} from '@/components/dashboard/settings/assistant-theme-form-helpers'
import { SettingsCard } from '@/components/dashboard/settings/settings-card'
import { Button } from '@/components/ui/button'
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from '@/components/ui/collapsible'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Spinner } from '@/components/ui/spinner'
import { Switch } from '@/components/ui/switch'
import { Textarea } from '@/components/ui/textarea'
import type { AssistantBehaviorSettings, DocumentSourceListItem, GeneralSettings } from '@/lib/api'

const INSTRUCTION_PRESETS: { label: string; text: string }[] = [
  {
    label: 'Helpful & concise',
    text: 'Answer clearly and concisely. Prefer short paragraphs and concrete examples. If you are not sure, say so.',
  },
  {
    label: 'Friendly support',
    text: 'Help visitors solve their problem. Be warm and patient, ask one clarifying question if the request is ambiguous, and link to the most relevant resource.',
  },
  {
    label: 'Sales advisor',
    text: 'Help visitors pick the right option. Ask about their goal, recommend the best fit, and call out any trade-offs honestly.',
  },
]

function SubsectionHeading({ title, description }: { title: string; description?: string }) {
  return (
    <div className="space-y-0.5">
      <h4 className="text-sm font-semibold text-foreground">{title}</h4>
      {description ? <p className="text-xs text-muted-foreground">{description}</p> : null}
    </div>
  )
}

export interface AssistantBehaviorSectionProps {
  anonSettings: GeneralSettings
  assistantBehaviorSettings: AssistantBehaviorSettings
  assistantLocaleInput: string
  onAssistantSettingChange: <K extends keyof GeneralSettings>(key: K, value: GeneralSettings[K]) => void
  onAssistantLocaleInputChange: (value: string) => void
  onAssistantBehaviorDraft: (updater: (current: AssistantBehaviorSettings) => AssistantBehaviorSettings) => void
  onAssistantLogoUpload: (file: File | null) => void
  onAssistantLogoDelete: () => void
  isAnonSaving: boolean
  isAssistantLogoSaving: boolean
  assistantSettingsError: string | null
  sourceList?: DocumentSourceListItem[]
  isSourceListLoading?: boolean
  sourceListError?: string | null
}

export function AssistantBehaviorSection({
  anonSettings,
  assistantBehaviorSettings,
  assistantLocaleInput,
  onAssistantSettingChange,
  onAssistantLocaleInputChange,
  onAssistantBehaviorDraft,
  onAssistantLogoUpload,
  onAssistantLogoDelete,
  isAnonSaving,
  isAssistantLogoSaving,
  assistantSettingsError,
  sourceList = [],
  isSourceListLoading = false,
  sourceListError = null,
}: AssistantBehaviorSectionProps) {
  const theme = assistantBehaviorSettings.theme ?? DEFAULT_ASSISTANT_THEME
  const surfaceMode = getSurfaceMode(theme)
  const sourceScope = assistantBehaviorSettings.sourceScope ?? { mode: 'all' as const }
  const selectedSourceIds = sourceScope.mode === 'selected' ? sourceScope.sourceIds : []
  const [sourceSearch, setSourceSearch] = useState('')
  const filteredSources = useMemo(() => {
    const query = sourceSearch.trim().toLowerCase()
    if (!query) {
      return sourceList
    }
    return sourceList.filter((source) =>
      `${source.name} ${source.kind} ${source.externalId ?? ''}`.toLowerCase().includes(query),
    )
  }, [sourceList, sourceSearch])

  const updateSourceScope = (nextSourceIds: string[]) => {
    onAssistantBehaviorDraft((current) => ({
      ...current,
      sourceScope: {
        mode: 'selected',
        sourceIds: [...new Set(nextSourceIds)],
      },
    }))
  }

  return (
    <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_22rem] lg:items-start">
      <SettingsCard
        icon={<Sparkles className="h-5 w-5 text-primary" />}
        title="Assistant profile"
        description="Name, look, and how the assistant answers."
      >
        {assistantSettingsError ? (
          <p className="text-sm text-destructive" role="alert">{assistantSettingsError}</p>
        ) : null}

        <div className="space-y-6">
        <div className="space-y-4">
          <SubsectionHeading
            title="Identity"
            description="What visitors see at the top of the chat."
          />

          <div className="flex items-center gap-3">
            <div className="flex h-14 w-14 shrink-0 items-center justify-center overflow-hidden rounded-2xl border border-border bg-background">
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img
                src={anonSettings.assistantLogoUrl ?? '/radioso-icon.svg'}
                alt=""
                className="h-12 w-12 object-contain"
              />
            </div>
            <div className="min-w-0 flex-1 space-y-1">
              <p className="text-sm font-medium text-foreground">Assistant logo</p>
              <div className="flex flex-wrap items-center gap-2">
                <Button asChild size="sm" variant="outline" disabled={isAnonSaving || isAssistantLogoSaving}>
                  <label>
                    {isAssistantLogoSaving ? <Spinner className="mr-1 h-3 w-3" /> : <Upload className="mr-1 h-3 w-3" />}
                    Upload
                    <input
                      type="file"
                      accept="image/png,image/jpeg,image/webp,image/gif"
                      className="sr-only"
                      onChange={(event) => {
                        onAssistantLogoUpload(event.target.files?.[0] ?? null)
                        event.currentTarget.value = ''
                      }}
                    />
                  </label>
                </Button>
                <Button
                  size="sm"
                  variant="ghost"
                  onClick={onAssistantLogoDelete}
                  disabled={isAnonSaving || isAssistantLogoSaving || !anonSettings.assistantLogoUrl}
                >
                  <Trash2 className="mr-1 h-3 w-3" />
                  Remove
                </Button>
              </div>
            </div>
          </div>

          <div className="space-y-2">
            <Label htmlFor="assistantName" className="text-foreground">Assistant name</Label>
            <Input
              id="assistantName"
              value={anonSettings.assistantName}
              maxLength={200}
              onChange={(event) => onAssistantSettingChange('assistantName', event.target.value)}
              placeholder="e.g. Marta"
            />
            <p className="text-xs text-muted-foreground">
              Shown as the chat title. Falls back to the workspace name when left blank.
            </p>
          </div>
        </div>

        <div className="h-px bg-border" />

        <div className="space-y-4">
          <SubsectionHeading
            title="Appearance"
            description="Colors used by the public chat and the hosted website widget."
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
              {(['light', 'dark', 'custom'] as const).map((mode) => {
                const isActive = surfaceMode === mode
                return (
                  <button
                    key={mode}
                    type="button"
                    className={`rounded-sm px-3 py-1 text-xs font-medium capitalize transition-colors ${
                      isActive ? 'bg-background text-foreground shadow-sm' : 'text-muted-foreground hover:text-foreground'
                    }`}
                    onClick={() => {
                      if (mode === 'custom') {
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
                        theme: applySurfaceMode(current.theme ?? DEFAULT_ASSISTANT_THEME, mode),
                      }))
                    }}
                  >
                    {mode}
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

        <div className="h-px bg-border" />

        <div className="space-y-4">
          <SubsectionHeading
            title="Behavior"
            description="How the assistant answers and starts conversations."
          />

          <div className="space-y-2">
            <Label htmlFor="assistantAnswerInstruction" className="text-foreground">
              Instructions for the assistant
            </Label>
            <div className="flex flex-wrap gap-2">
              {INSTRUCTION_PRESETS.map((preset) => (
                <Button
                  key={preset.label}
                  type="button"
                  size="sm"
                  variant="outline"
                  onClick={() =>
                    onAssistantBehaviorDraft((current) => ({
                      ...current,
                      customInstruction: preset.text.slice(0, 2000),
                    }))
                  }
                >
                  {preset.label}
                </Button>
              ))}
            </div>
            <Textarea
              id="assistantAnswerInstruction"
              value={assistantBehaviorSettings.customInstruction}
              onChange={(event) =>
                onAssistantBehaviorDraft((current) => ({
                  ...current,
                  customInstruction: event.target.value.slice(0, 2000),
                }))
              }
              placeholder="e.g. Help visitors choose the right course. Be concise, practical, and concrete."
              rows={4}
            />
            <div className="flex items-center justify-between text-xs text-muted-foreground">
              <span>Sets the purpose, scope, and tone applied to every answer. Pick a preset to start.</span>
              <span>{assistantBehaviorSettings.customInstruction.length} / 2000</span>
            </div>
          </div>

          <div className="space-y-3 rounded-lg border border-border p-3">
            <div className="flex flex-wrap items-start justify-between gap-3">
              <SubsectionHeading
                title="Knowledge scope"
                description="Choose which workspace sources this agent can use for grounded answers."
              />
              <div className="inline-flex rounded-md border border-border bg-muted/40 p-0.5" role="group">
                <button
                  type="button"
                  className={`rounded-sm px-3 py-1 text-xs font-medium transition-colors ${
                    sourceScope.mode === 'all' ? 'bg-background text-foreground shadow-sm' : 'text-muted-foreground hover:text-foreground'
                  }`}
                  onClick={() =>
                    onAssistantBehaviorDraft((current) => ({
                      ...current,
                      sourceScope: { mode: 'all' },
                    }))
                  }
                >
                  All sources
                </button>
                <button
                  type="button"
                  className={`rounded-sm px-3 py-1 text-xs font-medium transition-colors ${
                    sourceScope.mode === 'selected' ? 'bg-background text-foreground shadow-sm' : 'text-muted-foreground hover:text-foreground'
                  }`}
                  onClick={() =>
                    onAssistantBehaviorDraft((current) => ({
                      ...current,
                      sourceScope: {
                        mode: 'selected',
                        sourceIds: current.sourceScope?.mode === 'selected' ? current.sourceScope.sourceIds : [],
                      },
                    }))
                  }
                >
                  Selected sources
                </button>
              </div>
            </div>

            {sourceScope.mode === 'selected' ? (
              <div className="space-y-3">
                <div className="relative">
                  <Search className="pointer-events-none absolute left-2.5 top-2.5 h-4 w-4 text-muted-foreground" />
                  <Input
                    value={sourceSearch}
                    onChange={(event) => setSourceSearch(event.target.value)}
                    placeholder="Search sources"
                    className="pl-8"
                  />
                </div>
                {sourceListError ? (
                  <p className="text-sm text-destructive">{sourceListError}</p>
                ) : isSourceListLoading ? (
                  <div className="flex items-center gap-2 text-sm text-muted-foreground">
                    <Spinner className="h-4 w-4" />
                    Loading sources...
                  </div>
                ) : sourceList.length === 0 ? (
                  <p className="text-sm text-muted-foreground">
                    No persisted sources are available yet. Switch to all sources or add knowledge first.
                  </p>
                ) : (
                  <div className="max-h-56 divide-y divide-border overflow-auto rounded-md border border-border">
                    {filteredSources.length === 0 ? (
                      <p className="p-3 text-sm text-muted-foreground">No sources match this search.</p>
                    ) : filteredSources.map((source) => {
                      const checked = selectedSourceIds.includes(source.id)
                      return (
                        <label key={source.id} className="flex cursor-pointer items-start gap-3 p-3 hover:bg-muted/40">
                          <input
                            type="checkbox"
                            checked={checked}
                            onChange={(event) => {
                              updateSourceScope(event.target.checked
                                ? [...selectedSourceIds, source.id]
                                : selectedSourceIds.filter((sourceId) => sourceId !== source.id))
                            }}
                            className="mt-1 h-4 w-4 rounded border-border"
                          />
                          <Database className="mt-0.5 h-4 w-4 shrink-0 text-muted-foreground" />
                          <span className="min-w-0 flex-1">
                            <span className="block truncate text-sm font-medium text-foreground">{source.name}</span>
                            <span className="block truncate text-xs text-muted-foreground">
                              {source.kind} source - {source.documentCount} document{source.documentCount === 1 ? '' : 's'}
                            </span>
                          </span>
                        </label>
                      )
                    })}
                  </div>
                )}
                {selectedSourceIds.length === 0 ? (
                  <p className="text-xs text-amber-700">
                    This agent will not retrieve grounded context until at least one source is selected.
                  </p>
                ) : null}
              </div>
            ) : null}
          </div>

          <div className="divide-y divide-border rounded-lg border border-border">
            <div className="flex items-start justify-between gap-4 p-3">
              <div className="min-w-0">
                <Label htmlFor="assistantSuggestedQuestionsEnabled" className="text-foreground">
                  Suggested follow-up questions
                </Label>
                <p className="text-sm text-muted-foreground mt-0.5">
                  Show grounded follow-up chips after assistant answers when useful.
                </p>
              </div>
              <Switch
                id="assistantSuggestedQuestionsEnabled"
                checked={assistantBehaviorSettings.suggestedQuestionsEnabled}
                onCheckedChange={(checked) =>
                  onAssistantBehaviorDraft((current) => ({
                    ...current,
                    suggestedQuestionsEnabled: checked,
                  }))
                }
              />
            </div>
            <div className="space-y-3 p-3">
              <div className="flex items-start justify-between gap-4">
                <div className="min-w-0">
                  <Label htmlFor="proactiveGreetingEnabled" className="text-foreground">
                    Proactive first greeting
                  </Label>
                  <p className="text-sm text-muted-foreground mt-0.5">
                    Whether a brand-new chat opens with an assistant-first greeting.
                  </p>
                </div>
                <Switch
                  id="proactiveGreetingEnabled"
                  checked={anonSettings.proactiveGreetingEnabled}
                  onCheckedChange={(checked) => onAssistantSettingChange('proactiveGreetingEnabled', checked)}
                  disabled={isAnonSaving}
                />
              </div>
              {anonSettings.proactiveGreetingEnabled ? (
                <div className="space-y-2">
                  <Label htmlFor="assistantDefaultLocale" className="text-foreground">Greeting language</Label>
                  <AssistantLocaleCombobox
                    id="assistantDefaultLocale"
                    value={assistantLocaleInput}
                    onChange={onAssistantLocaleInputChange}
                  />
                  <p className="text-xs text-muted-foreground">
                    Pick from the list or type any BCP-47 tag (e.g. <code>en-GB</code>, <code>fr-CA</code>).
                    Used for the automatic first greeting when we can&apos;t detect the visitor&apos;s language.
                    Normal replies still follow the user&apos;s message language.
                  </p>
                </div>
              ) : null}
            </div>
          </div>
        </div>
        </div>
      </SettingsCard>

      <aside className="lg:sticky lg:top-4 lg:self-start" aria-label="Assistant preview">
        <div className="space-y-2">
          <p className="text-xs font-medium uppercase tracking-[0.18em] text-muted-foreground">
            Live preview
          </p>
          <ChatPreview
            themeSettings={theme}
            assistantName={anonSettings.assistantName}
            logoUrl={anonSettings.assistantLogoUrl ?? null}
            showSuggestedQuestions={assistantBehaviorSettings.suggestedQuestionsEnabled}
            showProactiveGreeting={anonSettings.proactiveGreetingEnabled}
          />
          <div className="space-y-2">
            <ThemeContrastWarning theme={theme} />
            <p className="text-xs text-muted-foreground">
              Updates as you edit. Mirrors the public chat and the website widget.
            </p>
          </div>
        </div>
      </aside>
    </div>
  )
}
