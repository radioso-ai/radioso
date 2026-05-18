'use client'

import { useMemo, useState } from 'react'
import { Bot, Database, Search } from 'lucide-react'

import { AssistantLocaleCombobox } from '@/components/dashboard/settings/assistant-locale-combobox'
import { SettingsCard } from '@/components/dashboard/settings/settings-card'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Spinner } from '@/components/ui/spinner'
import { Switch } from '@/components/ui/switch'
import { Textarea } from '@/components/ui/textarea'
import type { AssistantBehaviorSettings, DocumentSourceListItem, GeneralSettings } from '@/lib/api'

const INSTRUCTION_MAX_LENGTH = 2000

type InstructionPreset = { label: string; text: string }

const INSTRUCTION_PRESETS: InstructionPreset[] = [
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
  isAnonSaving: boolean
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
  isAnonSaving,
  sourceList = [],
  isSourceListLoading = false,
  sourceListError = null,
}: AssistantBehaviorSectionProps) {
  const sourceScope = assistantBehaviorSettings.sourceScope ?? { mode: 'all' as const }
  const selectedSourceIds = sourceScope.mode === 'selected' ? sourceScope.sourceIds : []
  const [sourceSearch, setSourceSearch] = useState('')
  const [pendingPreset, setPendingPreset] = useState<InstructionPreset | null>(null)
  const [presetDraft, setPresetDraft] = useState('')
  const hasPersonaText = assistantBehaviorSettings.customInstruction.trim().length > 0

  const openPreset = (preset: InstructionPreset) => {
    setPendingPreset(preset)
    setPresetDraft(preset.text)
  }

  const closePreset = () => {
    setPendingPreset(null)
  }

  const applyPreset = (mode: 'replace' | 'append') => {
    const draft = presetDraft.slice(0, INSTRUCTION_MAX_LENGTH)
    onAssistantBehaviorDraft((current) => {
      if (mode === 'replace' || current.customInstruction.trim().length === 0) {
        return { ...current, customInstruction: draft }
      }
      const combined = `${current.customInstruction.trimEnd()}\n\n${draft}`.slice(0, INSTRUCTION_MAX_LENGTH)
      return { ...current, customInstruction: combined }
    })
    closePreset()
  }

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
    <SettingsCard
      id="assistant-behavior"
      icon={<Bot className="h-5 w-5 text-primary" />}
      title="Assistant behavior"
      description="How the assistant answers and starts conversations."
    >
      <div className="space-y-6">
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
                onClick={() => openPreset(preset)}
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
                customInstruction: event.target.value.slice(0, INSTRUCTION_MAX_LENGTH),
              }))
            }
            placeholder="e.g. Help visitors choose the right course. Be concise, practical, and concrete."
            rows={4}
          />
          <div className="flex items-center justify-between text-xs text-muted-foreground">
            <span>Sets the purpose, scope, and tone applied to every answer. Pick a preset to start.</span>
            <span>{assistantBehaviorSettings.customInstruction.length} / {INSTRUCTION_MAX_LENGTH}</span>
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
                <Label htmlFor="assistantDefaultLocale" className="text-foreground">Fallback greeting language</Label>
                <AssistantLocaleCombobox
                  id="assistantDefaultLocale"
                  value={assistantLocaleInput}
                  onChange={onAssistantLocaleInputChange}
                />
                <p className="text-xs text-muted-foreground">
                  Used only when we can&apos;t detect the visitor&apos;s language. Replies still follow the visitor&apos;s message.
                </p>
              </div>
            ) : null}
          </div>
        </div>
      </div>

      <Dialog open={pendingPreset !== null} onOpenChange={(open) => { if (!open) closePreset() }}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{pendingPreset?.label}</DialogTitle>
            <DialogDescription>
              Edit before adding to the assistant&apos;s instructions.
            </DialogDescription>
          </DialogHeader>
          <Textarea
            value={presetDraft}
            onChange={(event) => setPresetDraft(event.target.value.slice(0, INSTRUCTION_MAX_LENGTH))}
            rows={6}
            aria-label="Preset instructions preview"
          />
          <div className="text-right text-xs text-muted-foreground">
            {presetDraft.length} / {INSTRUCTION_MAX_LENGTH}
          </div>
          <DialogFooter>
            <Button variant="ghost" onClick={closePreset}>Cancel</Button>
            {hasPersonaText ? (
              <>
                <Button variant="outline" onClick={() => applyPreset('append')}>
                  Append to instructions
                </Button>
                <Button onClick={() => applyPreset('replace')}>
                  Replace instructions
                </Button>
              </>
            ) : (
              <Button onClick={() => applyPreset('replace')}>
                Use this preset
              </Button>
            )}
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </SettingsCard>
  )
}
