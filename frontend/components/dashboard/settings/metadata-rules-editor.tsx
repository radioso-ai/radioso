'use client'

import { Plus, Trash2 } from 'lucide-react'

import {
  createMetadataCondition,
  createDefaultMetadataRule,
  getOperatorLabel,
  getRuleBehaviorLabel,
  getRuleConditions,
  getRulePreviewLabel,
  getRuleValuePlaceholder,
  isValidDateRuleValue,
  operatorOptionsForValueType,
  syncRuleWithConditions,
} from '@/components/dashboard/settings/retrieval-rule-helpers'
import { retrievalSettingDocs } from '@/components/dashboard/settings/settings-docs'
import { SettingTooltip } from '@/components/dashboard/settings/settings-flow'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { Switch } from '@/components/ui/switch'
import { Textarea } from '@/components/ui/textarea'
import type {
  MetadataFieldSuggestion,
  RetrievalMetadataCondition,
  RetrievalMetadataRule,
  RetrievalMetadataValueType,
} from '@/lib/api'

const metadataRuleCombinatorLabels = {
  and: 'All conditions (AND)',
  or: 'Any condition (OR)',
} as const

const metadataValueTypeLabels: Record<
  RetrievalMetadataValueType,
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
  RetrievalMetadataRule['effect'],
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
  NonNullable<RetrievalMetadataRule['triggerMode']>,
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

export function MetadataRulesEditor({
  metadataRules,
  metadataFieldSuggestions,
  onChange,
  readOnly = false,
  showHeader = true,
}: {
  metadataRules: RetrievalMetadataRule[]
  metadataFieldSuggestions: MetadataFieldSuggestion[]
  onChange: (next: RetrievalMetadataRule[]) => void
  readOnly?: boolean
  showHeader?: boolean
}) {
  const addMetadataRule = () => {
    onChange([
      ...metadataRules,
      createDefaultMetadataRule(metadataFieldSuggestions),
    ])
  }

  const updateMetadataRule = (
    ruleId: RetrievalMetadataRule['id'],
    updates: Partial<RetrievalMetadataRule>
  ) => {
    onChange(metadataRules.map((rule) => (rule.id === ruleId ? { ...rule, ...updates } : rule)))
  }

  const applyMetadataField = (
    ruleId: RetrievalMetadataRule['id'],
    conditionId: string,
    field: string
  ) => {
    const suggestion = metadataFieldSuggestions.find((candidate) => candidate.field === field)
    const valueType = suggestion?.inferredType
    const currentRule = metadataRules.find((rule) => rule.id === ruleId)
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
    ruleId: RetrievalMetadataRule['id'],
    conditionId: string,
    valueType: RetrievalMetadataValueType
  ) => {
    const currentRule = metadataRules.find((rule) => rule.id === ruleId)
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

  const updateMetadataCondition = (
    ruleId: RetrievalMetadataRule['id'],
    conditionId: string,
    updates: Partial<RetrievalMetadataCondition>
  ) => {
    const currentRule = metadataRules.find((rule) => rule.id === ruleId)
    if (!currentRule) return

    const nextConditions = getRuleConditions(currentRule).map((condition) =>
      condition.id === conditionId ? { ...condition, ...updates } : condition
    )

    updateMetadataRule(ruleId, syncRuleWithConditions(currentRule, nextConditions))
  }

  const addMetadataCondition = (ruleId: RetrievalMetadataRule['id']) => {
    const currentRule = metadataRules.find((rule) => rule.id === ruleId)
    if (!currentRule) return

    const nextConditions = [...getRuleConditions(currentRule), createMetadataCondition()]
    updateMetadataRule(ruleId, syncRuleWithConditions(currentRule, nextConditions))
  }

  const removeMetadataCondition = (
    ruleId: RetrievalMetadataRule['id'],
    conditionId: string
  ) => {
    const currentRule = metadataRules.find((rule) => rule.id === ruleId)
    if (!currentRule) return

    const remainingConditions = getRuleConditions(currentRule).filter((condition) => condition.id !== conditionId)
    updateMetadataRule(ruleId, syncRuleWithConditions(currentRule, remainingConditions))
  }

  const updateRuleTriggerMode = (
    ruleId: RetrievalMetadataRule['id'],
    triggerMode: NonNullable<RetrievalMetadataRule['triggerMode']>
  ) => {
    updateMetadataRule(ruleId, {
      triggerMode,
      ...(triggerMode === 'always_on' ? { triggerInstruction: undefined } : {}),
    })
  }

  const removeMetadataRule = (ruleId: string) => {
    onChange(metadataRules.filter((rule) => rule.id !== ruleId))
  }

  return (
    <div className="space-y-4">
      {showHeader ? (
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
          {!readOnly ? (
            <Button type="button" variant="outline" size="sm" onClick={addMetadataRule}>
              <Plus className="mr-2 h-4 w-4" />
              Add rule
            </Button>
          ) : null}
        </div>
      ) : !readOnly ? (
        <div className="flex justify-end">
          <Button type="button" variant="outline" size="sm" onClick={addMetadataRule}>
            <Plus className="mr-2 h-4 w-4" />
            Add rule
          </Button>
        </div>
      ) : null}

      {metadataRules.length === 0 ? (
        <div className="rounded-md border border-dashed border-border p-4 text-sm text-muted-foreground">
          No metadata rules yet. Add a rule to always boost or filter results using a metadata key.
        </div>
      ) : (
        <div className="space-y-3">
          {metadataRules.map((rule, index) => {
            const conditions = getRuleConditions(rule)
            const triggerMode = rule.triggerMode ?? 'always_on'
            return (
              <div
                key={rule.id}
                className={index === 0 ? 'space-y-4' : 'space-y-4 border-t border-border/70 pt-4'}
              >
                <div className="space-y-4 rounded-md border border-border/70 bg-muted/15 p-3.5">
                  <div className="flex items-start justify-between gap-3">
                    <div className="flex-1 space-y-3">
                      <div className="flex flex-wrap items-center gap-3">
                        <Label className="text-sm font-medium text-foreground">When</Label>
                        <Select
                          value={triggerMode}
                          disabled={readOnly}
                          onValueChange={(value) =>
                            updateRuleTriggerMode(rule.id, value as NonNullable<RetrievalMetadataRule['triggerMode']>)
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
                        {triggerModeLabels[triggerMode].description}
                      </p>
                    </div>
                    <div className="flex items-center gap-2">
                      <SettingTooltip
                        label={retrievalSettingDocs.metadataEnabled.label}
                        content={retrievalSettingDocs.metadataEnabled.details}
                      />
                      <Switch
                        checked={rule.enabled}
                        disabled={readOnly}
                        onCheckedChange={(checked) => updateMetadataRule(rule.id, { enabled: checked })}
                      />
                      {!readOnly ? (
                        <Button
                          type="button"
                          variant="ghost"
                          size="icon"
                          onClick={() => removeMetadataRule(rule.id)}
                        >
                          <Trash2 className="h-4 w-4" />
                        </Button>
                      ) : null}
                    </div>
                  </div>

                  {triggerMode === 'match_turn' ? (
                    <div className="space-y-2 border-t border-border/60 pt-3">
                      <Label className="text-foreground">Intent</Label>
                      <Textarea
                        value={rule.triggerInstruction ?? ''}
                        disabled={readOnly}
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
                            disabled={readOnly}
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
                            {!readOnly ? (
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
                            ) : null}
                          </div>

                          <div className="grid gap-3 xl:grid-cols-[minmax(0,1.1fr)_minmax(0,0.9fr)_minmax(0,1fr)_minmax(0,1.05fr)]">
                            <div className="space-y-2">
                              <Label htmlFor={`metadata-key-${rule.id}-${condition.id}`} className="text-foreground">
                                Field
                              </Label>
                              <Input
                                id={`metadata-key-${rule.id}-${condition.id}`}
                                value={condition.field}
                                disabled={readOnly}
                                onChange={(event) => applyMetadataField(rule.id, condition.id, event.target.value)}
                                placeholder="e.g. language or parsedData.url"
                                list="metadata-field-suggestions"
                              />
                            </div>

                            <div className="space-y-2">
                              <Label className="text-foreground">Value type</Label>
                              <Select
                                value={condition.valueType}
                                disabled={readOnly}
                                onValueChange={(value) =>
                                  applyMetadataValueType(rule.id, condition.id, value as RetrievalMetadataValueType)
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
                                disabled={readOnly}
                                onValueChange={(value) =>
                                  updateMetadataCondition(rule.id, condition.id, {
                                    operator: value as RetrievalMetadataRule['operator'],
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
                                  disabled={readOnly}
                                  onValueChange={(value) => updateMetadataCondition(rule.id, condition.id, { value })}
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
                                    disabled={readOnly}
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
                                  disabled={readOnly}
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
                            disabled={readOnly}
                            onValueChange={(value) =>
                              updateMetadataRule(rule.id, {
                                effect: value as RetrievalMetadataRule['effect'],
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
              </div>
            )
          })}
        </div>
      )}

      <datalist id="metadata-field-suggestions">
        {metadataFieldSuggestions.map((field) => (
          <option key={field.field} value={field.field} />
        ))}
      </datalist>
      <datalist id="metadata-date-value-suggestions">
        <option value="today()" />
      </datalist>
    </div>
  )
}
