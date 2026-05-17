'use client'

import { useEffect, useMemo, useRef, useState } from 'react'
import { ChevronDown, Plus, Search, SlidersHorizontal, Trash2 } from 'lucide-react'

import { AssistantMarkdownContent } from '@/components/dashboard/chat-markdown'
import {
  createMetadataCondition,
  getOperatorLabel,
  getRuleConditions,
  getRuleBehaviorLabel,
  getRulePreviewLabel,
  getRuleValuePlaceholder,
  isValidDateRuleValue,
  operatorOptionsForValueType,
  syncRuleWithConditions,
} from '@/components/dashboard/settings/retrieval-rule-helpers'
import { SettingsCard } from '@/components/dashboard/settings/settings-card'
import { retrievalSettingDocs } from '@/components/dashboard/settings/settings-docs'
import { SettingFieldHeader, SettingTooltip } from '@/components/dashboard/settings/settings-flow'
import { SettingsTabShell } from '@/components/dashboard/settings/settings-tab-shell'
import { useSettingsSaveStatus } from '@/components/dashboard/settings/use-settings-save-status'
import { Button } from '@/components/ui/button'
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { Slider } from '@/components/ui/slider'
import { LogoSpinner } from '@/components/ui/spinner'
import { Switch } from '@/components/ui/switch'
import { Textarea } from '@/components/ui/textarea'
import { type RetrievalSettings, settingsApi } from '@/lib/api'
import { useWorkspace } from '@/lib/workspace-context'

const metadataRuleCombinatorLabels = {
  and: 'All conditions (AND)',
  or: 'Any condition (OR)',
} as const

const metadataValueTypeLabels: Record<
  RetrievalSettings['metadataRules'][number]['valueType'],
  { label: string; description: string }
> = {
  string: {
    label: 'Text',
    description: 'Use text matching such as equals or contains.',
  },
  number: {
    label: 'Number',
    description: 'Use numeric comparisons such as less than or greater than.',
  },
  date: {
    label: 'Date',
    description: 'Use ISO dates like 2026-03-26 for date comparisons.',
  },
  boolean: {
    label: 'Boolean',
    description: 'Use true or false.',
  },
}

const metadataRuleEffectLabels: Record<
  RetrievalSettings['metadataRules'][number]['effect'],
  { label: string; description: string }
> = {
  boost: {
    label: 'Prefer match',
    description: 'Give matching results a ranking advantage without excluding other candidates.',
  },
  filter: {
    label: 'Require match',
    description: 'Only keep results that satisfy this rule.',
  },
}

const triggerModeLabels: Record<
  RetrievalSettings['metadataRules'][number]['triggerMode'],
  { label: string; description: string }
> = {
  always_on: {
    label: 'Always on',
    description: 'Apply this rule on every retrieval-backed turn.',
  },
  match_turn: {
    label: 'When matching intent',
    description: 'Apply this rule only when the current question matches the intent.',
  },
}

export function RetrievalSettingsPanel({
  onSaveStateChange,
}: {
  onSaveStateChange?: (input: { state: 'idle' | 'saved' | 'saving' | 'error'; message?: string | null }) => void
}) {
  const { activeWorkspaceId, isLoading: isWorkspaceLoading } = useWorkspace()
  const [settings, setSettings] = useState<RetrievalSettings | null>(null)
  const [isLoading, setIsLoading] = useState(true)
  const [lastSavedSettings, setLastSavedSettings] = useState<RetrievalSettings | null>(null)
  const { beginSave, isCurrentSave, markError, markSaved, resetSaveState } = useSettingsSaveStatus(onSaveStateChange)
  const [advancedOpen, setAdvancedOpen] = useState(false)
  const hasLoadedRef = useRef(false)
  const draftVersionRef = useRef(0)

  useEffect(() => {
    if (isWorkspaceLoading || !activeWorkspaceId) {
      // eslint-disable-next-line react-hooks/set-state-in-effect -- Workspace changes reset this async settings panel to loading.
      setIsLoading(true)
      return
    }

    let active = true
    const loadSettings = async () => {
      try {
        const data = await settingsApi.getRetrievalSettings()
        if (!active) return
        setSettings(data)
        setLastSavedSettings(data)
        resetSaveState()
      } catch (error) {
        if (!active) return
        console.error('Failed to load settings:', error)
      } finally {
        if (active) {
          setIsLoading(false)
          hasLoadedRef.current = true
        }
      }
    }
    void loadSettings()
    return () => {
      active = false
    }
  }, [activeWorkspaceId, isWorkspaceLoading, resetSaveState])

  const updateSettingsDraft = (updater: (current: RetrievalSettings) => RetrievalSettings) => {
    draftVersionRef.current += 1
    setSettings((current) => (current ? updater(current) : current))
  }

  const updateSetting = <K extends keyof RetrievalSettings>(key: K, value: RetrievalSettings[K]) => {
    updateSettingsDraft((current) => ({ ...current, [key]: value }))
  }

  const updateMetadataRule = (
    ruleId: RetrievalSettings['metadataRules'][number]['id'],
    updates: Partial<RetrievalSettings['metadataRules'][number]>
  ) => {
    if (!settings) return

    updateSettingsDraft((current) => ({
      ...current,
      metadataRules: current.metadataRules.map((rule) =>
        rule.id === ruleId ? { ...rule, ...updates } : rule
      ),
    }))
  }

  const applyMetadataField = (
    ruleId: RetrievalSettings['metadataRules'][number]['id'],
    conditionId: string,
    field: string
  ) => {
    if (!settings) return

    const suggestion = settings.metadataFieldSuggestions.find((candidate) => candidate.field === field)
    const valueType = suggestion?.inferredType
    const currentRule = settings.metadataRules.find((rule) => rule.id === ruleId)
    if (!currentRule) return
    const currentConditions = getRuleConditions(currentRule)
    const currentCondition = currentConditions.find((condition) => condition.id === conditionId)
    const nextValueType = valueType ?? currentCondition?.valueType ?? 'string'
    const allowedOperators = operatorOptionsForValueType(nextValueType)

    const nextConditions = currentConditions.map((condition) =>
      condition.id === conditionId
        ? {
            ...condition,
            field,
            ...(valueType ? { valueType } : {}),
            ...(!allowedOperators.includes(condition.operator) ? { operator: allowedOperators[0] } : {}),
          }
        : condition
    )

    updateMetadataRule(ruleId, syncRuleWithConditions(currentRule, nextConditions))
  }

  const applyMetadataValueType = (
    ruleId: RetrievalSettings['metadataRules'][number]['id'],
    conditionId: string,
    valueType: RetrievalSettings['metadataRules'][number]['valueType']
  ) => {
    if (!settings) return

    const currentRule = settings.metadataRules.find((rule) => rule.id === ruleId)
    if (!currentRule) return
    const currentConditions = getRuleConditions(currentRule)
    const allowedOperators = operatorOptionsForValueType(valueType)

    const nextConditions = currentConditions.map((condition) =>
      condition.id === conditionId
        ? {
            ...condition,
            valueType,
            ...(!allowedOperators.includes(condition.operator) ? { operator: allowedOperators[0] } : {}),
            ...(valueType === 'boolean' && condition.value !== 'true' && condition.value !== 'false'
              ? { value: 'true' }
              : {}),
          }
        : condition
    )

    updateMetadataRule(ruleId, syncRuleWithConditions(currentRule, nextConditions))
  }

  const addMetadataRule = () => {
    if (!settings) return

    const suggestedField = settings.metadataFieldSuggestions[0]
    updateSettingsDraft((current) => ({
      ...current,
      metadataRules: [
        ...current.metadataRules,
        syncRuleWithConditions({
          id: globalThis.crypto?.randomUUID?.() ?? `rule-${Date.now()}`,
          field: suggestedField?.field ?? '',
          valueType: suggestedField?.inferredType ?? 'string',
          operator: 'equals',
          value: suggestedField?.inferredType === 'boolean' ? 'true' : '',
          combinator: 'and',
          effect: 'boost',
          enabled: true,
          triggerMode: 'always_on',
        }, [
          createMetadataCondition({
            field: suggestedField?.field ?? '',
            valueType: suggestedField?.inferredType ?? 'string',
            operator: 'equals',
            value: suggestedField?.inferredType === 'boolean' ? 'true' : '',
          }),
        ]),
      ],
    }))
  }

  const updateMetadataCondition = (
    ruleId: RetrievalSettings['metadataRules'][number]['id'],
    conditionId: string,
    updates: Partial<ReturnType<typeof createMetadataCondition>>
  ) => {
    if (!settings) return

    const currentRule = settings.metadataRules.find((rule) => rule.id === ruleId)
    if (!currentRule) return

    const nextConditions = getRuleConditions(currentRule).map((condition) =>
      condition.id === conditionId ? { ...condition, ...updates } : condition
    )

    updateMetadataRule(ruleId, syncRuleWithConditions(currentRule, nextConditions))
  }

  const addMetadataCondition = (ruleId: RetrievalSettings['metadataRules'][number]['id']) => {
    if (!settings) return
    const currentRule = settings.metadataRules.find((rule) => rule.id === ruleId)
    if (!currentRule) return

    const nextConditions = [...getRuleConditions(currentRule), createMetadataCondition()]
    updateMetadataRule(ruleId, syncRuleWithConditions(currentRule, nextConditions))
  }

  const removeMetadataCondition = (
    ruleId: RetrievalSettings['metadataRules'][number]['id'],
    conditionId: string
  ) => {
    if (!settings) return
    const currentRule = settings.metadataRules.find((rule) => rule.id === ruleId)
    if (!currentRule) return

    const remainingConditions = getRuleConditions(currentRule).filter((condition) => condition.id !== conditionId)
    updateMetadataRule(ruleId, syncRuleWithConditions(currentRule, remainingConditions))
  }

  const updateRuleTriggerMode = (
    ruleId: RetrievalSettings['metadataRules'][number]['id'],
    triggerMode: RetrievalSettings['metadataRules'][number]['triggerMode']
  ) => {
    updateMetadataRule(ruleId, {
      triggerMode,
      ...(triggerMode === 'always_on' ? { triggerInstruction: undefined } : {}),
    })
  }

  const removeMetadataRule = (ruleId: string) => {
    if (!settings) return

    updateSettingsDraft((current) => ({
      ...current,
      metadataRules: current.metadataRules.filter((rule) => rule.id !== ruleId),
    }))
  }

  const settingsSignature = useMemo(() => JSON.stringify(settings), [settings])
  const lastSavedSignature = useMemo(() => JSON.stringify(lastSavedSettings), [lastSavedSettings])

  useEffect(() => {
    if (!hasLoadedRef.current || !settings || !lastSavedSettings) {
      return
    }

    if (settingsSignature === lastSavedSignature) {
      return
    }

    const saveId = beginSave()

    const timeout = window.setTimeout(async () => {
      const draftVersionAtRequestStart = draftVersionRef.current
      try {
        const saved = await settingsApi.updateRetrievalSettings(settings)
        if (!isCurrentSave(saveId)) {
          return
        }
        setLastSavedSettings(saved)
        if (draftVersionRef.current === draftVersionAtRequestStart) {
          setSettings(saved)
          markSaved()
        }
      } catch (error) {
        if (!isCurrentSave(saveId)) {
          return
        }
        console.error('Failed to save settings:', error)
        markError('Failed to save changes. Your latest edits are still in the browser.')
      }
    }, 700)

    return () => window.clearTimeout(timeout)
  }, [beginSave, isCurrentSave, lastSavedSettings, lastSavedSignature, markError, markSaved, settings, settingsSignature])

  if (isLoading) {
    return (
      <div className="flex h-full items-center justify-center">
        <LogoSpinner imageClassName="h-7 w-7" />
      </div>
    )
  }

  if (!settings) {
    return (
      <div className="flex h-full items-center justify-center">
        <p className="text-muted-foreground">Failed to load settings</p>
      </div>
    )
  }

  return (
    <SettingsTabShell>
      <div className="space-y-6">
        <SettingsCard
          id="query-rewrite"
          icon={<Search className="h-5 w-5 text-primary" />}
          eyebrow="Find The Right Evidence"
          title="Query rewrite"
          description="Let the system rewrite the user’s question into optimized semantic and lexical search queries."
        >
          <div className="flex items-center justify-between rounded-md border border-border bg-muted/20 p-3">
            <div>
              <div className="flex items-center gap-1.5">
                <Label htmlFor="queryRewrite" className="text-foreground">
                  {retrievalSettingDocs.queryRewriteEnabled.label}
                </Label>
                <SettingTooltip
                  label={retrievalSettingDocs.queryRewriteEnabled.label}
                  content={retrievalSettingDocs.queryRewriteEnabled.details}
                />
              </div>
              <div className="mt-0.5 text-sm text-muted-foreground">
                <AssistantMarkdownContent content={retrievalSettingDocs.queryRewriteEnabled.summary} inline />
              </div>
            </div>
            <Switch
              id="queryRewrite"
              checked={settings.queryRewriteEnabled}
              onCheckedChange={(checked) => updateSetting('queryRewriteEnabled', checked)}
            />
          </div>
        </SettingsCard>

        <SettingsCard
          id="metadata-rules"
          eyebrow="Find The Right Evidence"
          icon={<SlidersHorizontal className="h-5 w-5 text-primary" />}
          title="Filtering and boosting by document metadata"
          description="Use document metadata to consistently prefer or require certain results during retrieval."
        >
          <div className="space-y-4">
            <div className="flex items-start justify-between gap-4">
              <div className="space-y-1">
                <div className="flex items-center gap-1.5">
                  <p className="text-sm font-medium text-foreground">{retrievalSettingDocs.metadataRules.label}</p>
                  <SettingTooltip
                    label={retrievalSettingDocs.metadataRules.label}
                    content={retrievalSettingDocs.metadataRules.details}
                  />
                </div>
                <p className="text-sm text-muted-foreground">{retrievalSettingDocs.metadataRules.summary}</p>
              </div>
              <Button type="button" variant="outline" size="sm" onClick={addMetadataRule}>
                <Plus className="mr-2 h-4 w-4" />
                Add rule
              </Button>
            </div>

            {settings.metadataRules.length === 0 ? (
              <div className="rounded-md border border-dashed border-border p-4 text-sm text-muted-foreground">
                No metadata rules yet. Add a rule to always boost or filter results using a metadata key.
              </div>
            ) : (
              <div className="space-y-3">
                {settings.metadataRules.map((rule, index) => (
                  <div
                    key={rule.id}
                    className={
                      index === 0
                        ? 'space-y-4'
                        : 'space-y-4 border-t border-border/70 pt-4'
                      }
                  >
                    {(() => {
                      const conditions = getRuleConditions(rule)
                      return (
                    <div className="space-y-4 rounded-md border border-border/70 bg-muted/15 p-3.5">
                      <div className="flex items-start justify-between gap-3">
                        <div className="flex-1 space-y-3">
                          <div className="flex flex-wrap items-center gap-3">
                            <Label className="text-sm font-medium text-foreground">When</Label>
                            <Select
                              value={rule.triggerMode}
                              onValueChange={(value) =>
                                updateRuleTriggerMode(
                                  rule.id,
                                  value as RetrievalSettings['metadataRules'][number]['triggerMode']
                                )
                              }
                            >
                              <SelectTrigger className="w-full sm:w-[220px]">
                                <SelectValue />
                              </SelectTrigger>
                              <SelectContent>
                                {Object.entries(triggerModeLabels).map(([value, meta]) => (
                                  <SelectItem key={value} value={value}>
                                    {meta.label}
                                  </SelectItem>
                                ))}
                              </SelectContent>
                            </Select>
                          </div>
                          <p className="text-sm text-muted-foreground">
                            {triggerModeLabels[rule.triggerMode].description}
                          </p>
                        </div>
                        <div className="flex items-center gap-2">
                          <SettingTooltip
                            label={retrievalSettingDocs.metadataEnabled.label}
                            content={retrievalSettingDocs.metadataEnabled.details}
                          />
                          <Switch
                            checked={rule.enabled}
                            onCheckedChange={(checked) => updateMetadataRule(rule.id, { enabled: checked })}
                          />
                          <Button
                            type="button"
                            variant="ghost"
                            size="icon"
                            onClick={() => removeMetadataRule(rule.id)}
                          >
                            <Trash2 className="h-4 w-4" />
                          </Button>
                        </div>
                      </div>

                      {rule.triggerMode === 'match_turn' ? (
                        <div className="space-y-2 border-t border-border/60 pt-3">
                          <Label className="text-foreground">Intent</Label>
                          <Textarea
                            value={rule.triggerInstruction ?? ''}
                            onChange={(event) =>
                              updateMetadataRule(rule.id, {
                                triggerInstruction: event.target.value.slice(0, 500),
                              })
                            }
                            placeholder="e.g. Upcoming events, conferences, courses, or camps."
                            rows={3}
                          />
                        </div>
                      ) : null}

                      <div className="border-t border-border/60 pt-3">
                        <div className="space-y-3">
                          {conditions.length > 1 ? (
                            <div className="flex items-center gap-3">
                              <Label className="text-foreground">Match</Label>
                              <Select
                                value={rule.combinator ?? 'and'}
                                onValueChange={(value) =>
                                  updateMetadataRule(rule.id, {
                                    combinator: value as 'and' | 'or',
                                  })
                                }
                              >
                                <SelectTrigger className="w-full sm:w-[220px]">
                                  <SelectValue />
                                </SelectTrigger>
                                <SelectContent>
                                  {Object.entries(metadataRuleCombinatorLabels).map(([value, label]) => (
                                    <SelectItem key={value} value={value}>
                                      {label}
                                    </SelectItem>
                                  ))}
                                </SelectContent>
                              </Select>
                            </div>
                          ) : null}

                          {conditions.map((condition, conditionIndex) => (
                            <div
                              key={condition.id}
                              className={
                                conditionIndex === 0
                                  ? 'space-y-3'
                                  : 'space-y-3 border-t border-border/60 pt-3'
                              }
                            >
                              <div className="flex items-center justify-between gap-3">
                                <p className="text-sm font-medium text-foreground">
                                  {conditions.length > 1 ? `Condition ${conditionIndex + 1}` : 'Condition'}
                                </p>
                                <div className="flex items-center gap-2">
                                  {conditions.length > 1 ? (
                                    <Button
                                      type="button"
                                      variant="ghost"
                                      size="sm"
                                      onClick={() => removeMetadataCondition(rule.id, condition.id)}
                                    >
                                      Remove
                                    </Button>
                                  ) : null}
                                  {conditionIndex === conditions.length - 1 ? (
                                    <Button
                                      type="button"
                                      variant="outline"
                                      size="sm"
                                      onClick={() => addMetadataCondition(rule.id)}
                                    >
                                      <Plus className="mr-2 h-4 w-4" />
                                      Add condition
                                    </Button>
                                  ) : null}
                                </div>
                              </div>

                              <div className="grid gap-3 xl:grid-cols-[minmax(0,1.1fr)_minmax(0,0.9fr)_minmax(0,1fr)_minmax(0,1.05fr)]">
                                <div className="space-y-2">
                                  <Label htmlFor={`metadata-key-${rule.id}-${condition.id}`} className="text-foreground">
                                    Field
                                  </Label>
                                  <Input
                                    id={`metadata-key-${rule.id}-${condition.id}`}
                                    value={condition.field}
                                    onChange={(event) => applyMetadataField(rule.id, condition.id, event.target.value)}
                                    placeholder="e.g. language or parsedData.url"
                                    list="metadata-field-suggestions"
                                  />
                                </div>

                                <div className="space-y-2">
                                  <Label className="text-foreground">Value type</Label>
                                  <Select
                                    value={condition.valueType}
                                    onValueChange={(value) =>
                                      applyMetadataValueType(
                                        rule.id,
                                        condition.id,
                                        value as RetrievalSettings['metadataRules'][number]['valueType']
                                      )
                                    }
                                  >
                                    <SelectTrigger className="w-full">
                                      <SelectValue />
                                    </SelectTrigger>
                                    <SelectContent>
                                      {Object.entries(metadataValueTypeLabels).map(([value, meta]) => (
                                        <SelectItem key={value} value={value}>
                                          {meta.label}
                                        </SelectItem>
                                      ))}
                                    </SelectContent>
                                  </Select>
                                </div>

                                <div className="space-y-2">
                                  <Label className="text-foreground">Comparison</Label>
                                  <Select
                                    value={condition.operator}
                                    onValueChange={(value) =>
                                      updateMetadataCondition(rule.id, condition.id, {
                                        operator: value as RetrievalSettings['metadataRules'][number]['operator'],
                                      })
                                    }
                                  >
                                    <SelectTrigger className="w-full">
                                      <SelectValue />
                                    </SelectTrigger>
                                    <SelectContent>
                                      {operatorOptionsForValueType(condition.valueType).map((value) => (
                                        <SelectItem key={value} value={value}>
                                          {getOperatorLabel(value, condition.valueType)}
                                        </SelectItem>
                                      ))}
                                    </SelectContent>
                                  </Select>
                                </div>

                                <div className="space-y-2">
                                  <Label className="text-foreground">Value</Label>
                                  {condition.valueType === 'boolean' ? (
                                    <Select
                                      value={condition.value === 'false' ? 'false' : 'true'}
                                      onValueChange={(value) =>
                                        updateMetadataCondition(rule.id, condition.id, { value })
                                      }
                                    >
                                      <SelectTrigger className="w-full">
                                        <SelectValue />
                                      </SelectTrigger>
                                      <SelectContent>
                                        <SelectItem value="true">True</SelectItem>
                                        <SelectItem value="false">False</SelectItem>
                                      </SelectContent>
                                    </Select>
                                  ) : condition.valueType === 'date' ? (
                                    <div className="space-y-2">
                                      <Input
                                        type="text"
                                        value={condition.value}
                                        onChange={(event) =>
                                          updateMetadataCondition(rule.id, condition.id, {
                                            value: event.target.value,
                                          })
                                        }
                                        placeholder="2026-03-26 or today()"
                                        list="metadata-date-value-suggestions"
                                      />
                                      {condition.value.trim().length > 0 && !isValidDateRuleValue(condition.value) ? (
                                        <p className="text-sm text-destructive">
                                          Enter an ISO date like 2026-03-26 or use <code>today()</code>.
                                        </p>
                                      ) : null}
                                    </div>
                                  ) : (
                                    <Input
                                      type={condition.valueType === 'number' ? 'number' : 'text'}
                                      value={condition.value}
                                      onChange={(event) =>
                                        updateMetadataCondition(rule.id, condition.id, {
                                          value: event.target.value,
                                        })
                                      }
                                      placeholder={getRuleValuePlaceholder(condition.valueType)}
                                    />
                                  )}
                                </div>
                              </div>
                            </div>
                          ))}

                          <div className="grid gap-3 sm:grid-cols-[minmax(0,1fr)_auto] sm:items-end">
                            <div className="space-y-2">
                              <Label className="text-foreground">Effect</Label>
                              <Select
                                value={rule.effect}
                                onValueChange={(value) =>
                                  updateMetadataRule(rule.id, {
                                    effect: value as RetrievalSettings['metadataRules'][number]['effect'],
                                  })
                                }
                              >
                                <SelectTrigger className="w-full sm:w-[220px]">
                                  <SelectValue />
                                </SelectTrigger>
                                <SelectContent>
                                  {Object.entries(metadataRuleEffectLabels).map(([value, meta]) => (
                                    <SelectItem key={value} value={value}>
                                      {meta.label}
                                    </SelectItem>
                                  ))}
                                </SelectContent>
                              </Select>
                            </div>
                          </div>
                        </div>
                      </div>

                      <div className="border-t border-border/60 pt-3">
                        <p className="text-[11px] font-medium uppercase tracking-[0.18em] text-muted-foreground">
                          Preview
                        </p>
                        <p className="mt-1 text-sm font-medium text-foreground">{getRulePreviewLabel(rule)}</p>
                        <p className="mt-1 text-sm text-muted-foreground">{getRuleBehaviorLabel(rule)}</p>
                      </div>
                    </div>
                      )
                    })()}
                  </div>
                ))}
              </div>
            )}

            <datalist id="metadata-field-suggestions">
              {settings.metadataFieldSuggestions.map((field) => (
                <option key={field.field} value={field.field} />
              ))}
            </datalist>
            <datalist id="metadata-date-value-suggestions">
              <option value="today()" />
            </datalist>
          </div>
        </SettingsCard>

        <SettingsCard
          id="answer-behavior"
          icon={<Search className="h-5 w-5 text-primary" />}
          eyebrow="Shape The Answer"
          title="Grounded answer presentation"
          description="Control retrieval-owned answer evidence presentation. Assistant follow-up behavior lives under Assistant settings."
        >
          <div className="space-y-4">
            <div className="flex items-center justify-between">
              <div>
                <div className="flex items-center gap-1.5">
                  <Label htmlFor="answerSupportValidation" className="text-foreground">
                    {retrievalSettingDocs.answerSupportValidationEnabled.label}
                  </Label>
                  <SettingTooltip
                    label={retrievalSettingDocs.answerSupportValidationEnabled.label}
                    content={retrievalSettingDocs.answerSupportValidationEnabled.details}
                  />
                </div>
                <div className="mt-0.5 text-sm text-muted-foreground">
                  <AssistantMarkdownContent content={retrievalSettingDocs.answerSupportValidationEnabled.summary} inline />
                </div>
              </div>
              <Switch
                id="answerSupportValidation"
                checked={settings.answerSupportValidationEnabled}
                onCheckedChange={(checked) => updateSetting('answerSupportValidationEnabled', checked)}
              />
            </div>

          </div>
        </SettingsCard>

        <SettingsCard
          id="search-tuning"
          eyebrow="Advanced"
          icon={<Search className="h-5 w-5 text-primary" />}
          title="Advanced search tuning"
          description="Adjust candidate recall, thresholding, and reranking. These controls are most useful when you are actively tuning retrieval quality."
        >
          <Collapsible open={advancedOpen} onOpenChange={setAdvancedOpen}>
            <CollapsibleTrigger asChild>
              <button
                type="button"
                className="flex w-full items-center justify-between rounded-xl border border-border bg-muted/20 px-4 py-3 text-left"
              >
                <div>
                  <p className="text-sm font-medium text-foreground">Searching and reranking</p>
                  <p className="text-sm text-muted-foreground">
                    Advanced controls for recall, filtering sensitivity, and reranking behavior.
                  </p>
                </div>
                <ChevronDown
                  className={`h-4 w-4 text-muted-foreground transition-transform ${advancedOpen ? 'rotate-180' : ''}`}
                />
              </button>
            </CollapsibleTrigger>
            <CollapsibleContent className="pt-4">
              <div className="space-y-4">
                <div className="space-y-4 rounded-md border border-border bg-muted/20 p-4">
                  <div className="space-y-3">
                    <div className="flex items-center justify-between">
                      <SettingFieldHeader
                        htmlFor="vectorTopK"
                        label={retrievalSettingDocs.vectorTopK.label}
                        description={retrievalSettingDocs.vectorTopK.summary}
                        tooltip={retrievalSettingDocs.vectorTopK.details}
                        className="pr-4"
                      />
                      <span className="text-sm font-mono text-muted-foreground">{settings.vectorTopK}</span>
                    </div>
                    <Slider
                      id="vectorTopK"
                      min={1}
                      max={300}
                      step={1}
                      value={[settings.vectorTopK]}
                      onValueChange={([value]) => updateSetting('vectorTopK', value)}
                    />
                  </div>

                  <div className="space-y-3">
                    <div className="flex items-center justify-between">
                      <SettingFieldHeader
                        htmlFor="similarity"
                        label={retrievalSettingDocs.similarityThreshold.label}
                        description={retrievalSettingDocs.similarityThreshold.summary}
                        tooltip={retrievalSettingDocs.similarityThreshold.details}
                        className="pr-4"
                      />
                      <span className="text-sm font-mono text-muted-foreground">
                        {settings.similarityThreshold.toFixed(2)}
                      </span>
                    </div>
                    <Slider
                      id="similarity"
                      min={0}
                      max={1}
                      step={0.01}
                      value={[settings.similarityThreshold]}
                      onValueChange={([value]) => updateSetting('similarityThreshold', value)}
                    />
                  </div>
                </div>

                <div className="space-y-4 rounded-md border border-border bg-muted/20 p-4">
                  <div className="flex items-center justify-between rounded-md border border-border bg-background/60 p-3">
                    <div>
                      <div className="flex items-center gap-1.5">
                        <Label htmlFor="rerank" className="text-foreground">
                          {retrievalSettingDocs.rerankEnabled.label}
                        </Label>
                        <SettingTooltip
                          label={retrievalSettingDocs.rerankEnabled.label}
                          content={retrievalSettingDocs.rerankEnabled.details}
                        />
                      </div>
                      <div className="mt-0.5 text-sm text-muted-foreground">
                        <AssistantMarkdownContent content={retrievalSettingDocs.rerankEnabled.summary} inline />
                      </div>
                    </div>
                    <Switch
                      id="rerank"
                      checked={settings.rerankEnabled}
                      onCheckedChange={(checked) => updateSetting('rerankEnabled', checked)}
                    />
                  </div>

                  {settings.rerankEnabled ? (
                    <div className="space-y-3">
                      <div className="flex items-center justify-between">
                        <SettingFieldHeader
                          htmlFor="rerankTopK"
                          label={retrievalSettingDocs.rerankTopK.label}
                          description={retrievalSettingDocs.rerankTopK.summary}
                          tooltip={retrievalSettingDocs.rerankTopK.details}
                          className="pr-4"
                        />
                        <span className="text-sm font-mono text-muted-foreground">{settings.rerankTopK}</span>
                      </div>
                      <Slider
                        id="rerankTopK"
                        min={1}
                        max={50}
                        step={1}
                        value={[settings.rerankTopK]}
                        onValueChange={([value]) => updateSetting('rerankTopK', value)}
                      />
                    </div>
                  ) : (
                    <p className="text-sm text-muted-foreground">
                      Enable reranking to tune how many candidates survive the rerank pass.
                    </p>
                  )}
                </div>
              </div>
            </CollapsibleContent>
          </Collapsible>
        </SettingsCard>
      </div>
    </SettingsTabShell>
  )
}
