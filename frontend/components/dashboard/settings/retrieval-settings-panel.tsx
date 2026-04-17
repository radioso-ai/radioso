'use client'

import { useEffect, useState } from 'react'
import { Bot, Plus, Save, Search, SlidersHorizontal, Trash2 } from 'lucide-react'

import { AssistantMarkdownContent } from '@/components/dashboard/chat-markdown'
import { SettingsCard } from '@/components/dashboard/settings/settings-card'
import { retrievalSettingDocs } from '@/components/dashboard/settings/settings-docs'
import { PipelineConnector, SettingFieldHeader, SettingTooltip } from '@/components/dashboard/settings/settings-flow'
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
import { Slider } from '@/components/ui/slider'
import { Spinner } from '@/components/ui/spinner'
import { Switch } from '@/components/ui/switch'
import { Textarea } from '@/components/ui/textarea'
import { type RetrievalSettings, settingsApi } from '@/lib/api'

const metadataRuleOperatorLabels: Record<
  RetrievalSettings['metadataRules'][number]['operator'],
  { label: string; description: string }
> = {
  equals: {
    label: 'Equals',
    description: 'Match when the metadata value equals the rule value.',
  },
  not_equals: {
    label: 'Does Not Equal',
    description: 'Match when the metadata value is different from the rule value.',
  },
  contains: {
    label: 'Contains',
    description: 'Match when the metadata value contains the rule value.',
  },
  not_contains: {
    label: 'Does Not Contain',
    description: 'Match when the metadata value does not contain the rule value.',
  },
  lt: {
    label: 'Less Than',
    description: 'Match when the metadata value is less than the rule value.',
  },
  lte: {
    label: 'Less Than Or Equal',
    description: 'Match when the metadata value is less than or equal to the rule value.',
  },
  gt: {
    label: 'Greater Than',
    description: 'Match when the metadata value is greater than the rule value.',
  },
  gte: {
    label: 'Greater Than Or Equal',
    description: 'Match when the metadata value is greater than or equal to the rule value.',
  },
}

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
    label: 'Boost',
    description: 'Prefer matching results without excluding other candidates.',
  },
  filter: {
    label: 'Filter',
    description: 'Only keep results that match this rule.',
  },
}

const answerSupportPolicyLabels: Record<
  RetrievalSettings['answerSupportPolicy'],
  { label: string; description: string }
> = {
  strict: {
    label: 'Strict grounding',
    description:
      'Replace unsupported claims with a short model-generated non-verification notice in the user’s language.',
  },
  warn: {
    label: 'Warn only',
    description:
      'Keep unsupported text visible and record support validation details for review.',
  },
  off: {
    label: 'Off',
    description:
      'Skip post-generation support replacement entirely and return the model answer unchanged.',
  },
}

const conversationModeLabels: Record<
  RetrievalSettings['conversationMode'],
  { label: string; description: string }
> = {
  factual: {
    label: 'Factual',
    description: 'Answer the current question directly and stop unless clarification is required.',
  },
  guided: {
    label: 'Guided',
    description: 'Answer directly, then suggest one or two grounded nearby directions when useful.',
  },
  exploratory: {
    label: 'Exploratory',
    description: 'Answer directly, then surface more of what the workspace covers and invite grounded follow-up.',
  },
}

const operatorOptionsForValueType = (
  valueType: RetrievalSettings['metadataRules'][number]['valueType']
): RetrievalSettings['metadataRules'][number]['operator'][] => {
  if (valueType === 'string') {
    return ['equals', 'not_equals', 'contains', 'not_contains']
  }
  if (valueType === 'boolean') {
    return ['equals', 'not_equals']
  }

  return ['equals', 'not_equals', 'lt', 'lte', 'gt', 'gte']
}

const suggestedQuestionCountLabel = (count: number) =>
  `${count} suggested question${count === 1 ? '' : 's'}`

export function RetrievalSettingsPanel() {
  const [settings, setSettings] = useState<RetrievalSettings | null>(null)
  const [isLoading, setIsLoading] = useState(true)
  const [isSaving, setIsSaving] = useState(false)
  const [hasChanges, setHasChanges] = useState(false)

  useEffect(() => {
    const loadSettings = async () => {
      try {
        const data = await settingsApi.getRetrievalSettings()
        setSettings(data)
      } catch (error) {
        console.error('Failed to load settings:', error)
      } finally {
        setIsLoading(false)
      }
    }
    void loadSettings()
  }, [])

  const updateSetting = <K extends keyof RetrievalSettings>(key: K, value: RetrievalSettings[K]) => {
    if (!settings) return
    setSettings({ ...settings, [key]: value })
    setHasChanges(true)
  }

  const updateMetadataRule = (
    ruleId: RetrievalSettings['metadataRules'][number]['id'],
    updates: Partial<RetrievalSettings['metadataRules'][number]>
  ) => {
    if (!settings) return

    setSettings({
      ...settings,
      metadataRules: settings.metadataRules.map((rule) =>
        rule.id === ruleId ? { ...rule, ...updates } : rule
      ),
    })
    setHasChanges(true)
  }

  const applyMetadataField = (
    ruleId: RetrievalSettings['metadataRules'][number]['id'],
    field: string
  ) => {
    if (!settings) return

    const suggestion = settings.metadataFieldSuggestions.find((candidate) => candidate.field === field)
    const valueType = suggestion?.inferredType
    const currentRule = settings.metadataRules.find((rule) => rule.id === ruleId)
    const nextValueType = valueType ?? currentRule?.valueType ?? 'string'
    const allowedOperators = operatorOptionsForValueType(nextValueType)

    updateMetadataRule(ruleId, {
      field,
      ...(valueType ? { valueType } : {}),
      ...(currentRule && !allowedOperators.includes(currentRule.operator)
        ? { operator: allowedOperators[0] }
        : {}),
    })
  }

  const applyMetadataValueType = (
    ruleId: RetrievalSettings['metadataRules'][number]['id'],
    valueType: RetrievalSettings['metadataRules'][number]['valueType']
  ) => {
    if (!settings) return

    const currentRule = settings.metadataRules.find((rule) => rule.id === ruleId)
    const allowedOperators = operatorOptionsForValueType(valueType)

    updateMetadataRule(ruleId, {
      valueType,
      ...(currentRule && !allowedOperators.includes(currentRule.operator)
        ? { operator: allowedOperators[0] }
        : {}),
      ...(valueType === 'boolean' && currentRule?.value !== 'true' && currentRule?.value !== 'false'
        ? { value: 'true' }
        : {}),
    })
  }

  const addMetadataRule = () => {
    if (!settings) return

    const suggestedField = settings.metadataFieldSuggestions[0]
    setSettings({
      ...settings,
      metadataRules: [
        ...settings.metadataRules,
        {
          id: globalThis.crypto?.randomUUID?.() ?? `rule-${Date.now()}`,
          field: suggestedField?.field ?? '',
          valueType: suggestedField?.inferredType ?? 'string',
          operator: 'equals',
          value: suggestedField?.inferredType === 'boolean' ? 'true' : '',
          effect: 'boost',
          enabled: true,
        },
      ],
    })
    setHasChanges(true)
  }

  const removeMetadataRule = (ruleId: string) => {
    if (!settings) return

    setSettings({
      ...settings,
      metadataRules: settings.metadataRules.filter((rule) => rule.id !== ruleId),
    })
    setHasChanges(true)
  }

  const handleSave = async () => {
    if (!settings) return
    setIsSaving(true)
    try {
      await settingsApi.updateRetrievalSettings(settings)
      setHasChanges(false)
    } catch (error) {
      console.error('Failed to save settings:', error)
    } finally {
      setIsSaving(false)
    }
  }

  if (isLoading) {
    return (
      <div className="flex items-center justify-center h-full">
        <Spinner className="w-6 h-6" />
      </div>
    )
  }

  if (!settings) {
    return (
      <div className="flex items-center justify-center h-full">
        <p className="text-muted-foreground">Failed to load settings</p>
      </div>
    )
  }

  return (
    <div className="flex flex-col h-full">
      <div className="border-b border-border px-6 py-4 flex items-center justify-between">
        <div>
          <h2 className="text-lg font-medium text-foreground">Retrieval Settings</h2>
          <p className="text-sm text-muted-foreground">Tune retrieval and response behavior</p>
        </div>
        <Button size="sm" onClick={handleSave} disabled={!hasChanges || isSaving}>
          {isSaving ? <Spinner className="mr-2" /> : <Save className="w-4 h-4 mr-2" />}
          Save Changes
        </Button>
      </div>

      <div className="flex-1 overflow-y-auto p-6">
        <div className="max-w-3xl space-y-2">
          <SettingsCard
            id="retrieval-pipeline"
            eyebrow="Stage 1"
            icon={<Search className="h-5 w-5 text-primary" />}
            title="Rewrite the incoming question"
            description="Start by deciding whether the system should generate retrieval-specific semantic and lexical rewrites."
          >
            <div className="space-y-4">
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

              <div className="space-y-4 rounded-md border border-border bg-muted/20 p-4">
                <SettingFieldHeader
                  htmlFor="semanticRewriteInstructions"
                  label={retrievalSettingDocs.semanticRewriteInstructions.label}
                  description={retrievalSettingDocs.semanticRewriteInstructions.summary}
                  tooltip={retrievalSettingDocs.semanticRewriteInstructions.details}
                />
                <Textarea
                  id="semanticRewriteInstructions"
                  value={settings.semanticRewriteInstructions}
                  onChange={(event) =>
                    updateSetting('semanticRewriteInstructions', event.target.value.slice(0, 2000))
                  }
                  placeholder="e.g. Keep the same meaning, preserve proper nouns, and rewrite follow-ups into standalone questions."
                  rows={4}
                />
                <p className="text-xs text-muted-foreground text-right">
                  {settings.semanticRewriteInstructions.length} / 2000
                </p>

                <SettingFieldHeader
                  htmlFor="lexicalRewriteInstructions"
                  label={retrievalSettingDocs.lexicalRewriteInstructions.label}
                  description={retrievalSettingDocs.lexicalRewriteInstructions.summary}
                  tooltip={retrievalSettingDocs.lexicalRewriteInstructions.details}
                />
                <Textarea
                  id="lexicalRewriteInstructions"
                  value={settings.lexicalRewriteInstructions}
                  onChange={(event) =>
                    updateSetting('lexicalRewriteInstructions', event.target.value.slice(0, 2000))
                  }
                  placeholder="e.g. Prefer section symbols, abbreviations, and exact citation notation when grounded in the query or context."
                  rows={4}
                />
                <p className="text-xs text-muted-foreground text-right">
                  {settings.lexicalRewriteInstructions.length} / 2000
                </p>

                <p className="text-sm text-muted-foreground">
                  Phase 1 runs one semantic query and one lexical query per request. These instructions tune those two
                  query shapes independently.
                </p>
              </div>
            </div>
          </SettingsCard>

          <PipelineConnector />

          <SettingsCard
            eyebrow="Stage 2"
            icon={<Search className="h-5 w-5 text-primary" />}
            title="Retrieve and shape the candidate pool"
            description="Run semantic search, apply thresholds, and keep persistent metadata rules close to the retrieval step they influence."
          >
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
                <div className="space-y-2">
                  <div className="flex items-center justify-between gap-4">
                    <SettingFieldHeader
                      label={retrievalSettingDocs.metadataRules.label}
                      description={retrievalSettingDocs.metadataRules.summary}
                      tooltip={retrievalSettingDocs.metadataRules.details}
                      className="flex-1"
                    />
                    <Button type="button" variant="outline" size="sm" onClick={addMetadataRule}>
                      <Plus className="mr-2 h-4 w-4" />
                      Add Rule
                    </Button>
                  </div>
                  <p className="text-sm text-muted-foreground">
                    Suggested keys from this workspace:{' '}
                    {settings.metadataFieldSuggestions.length > 0
                      ? settings.metadataFieldSuggestions.map((field) => `${field.field} (${field.inferredType})`).join(', ')
                      : 'none discovered yet'}
                  </p>
                  <p className="text-sm text-muted-foreground">
                    Format hints: dates use <code>YYYY-MM-DD</code>, numbers use plain values like <code>100</code> or <code>12.5</code>, and booleans use <code>true</code> or <code>false</code>.
                  </p>
                </div>

                {settings.metadataRules.length === 0 ? (
                  <div className="rounded-md border border-dashed border-border bg-card p-4 text-sm text-muted-foreground">
                    No metadata rules yet. Add a rule to always boost or filter results using a metadata key.
                  </div>
                ) : (
                  <div className="space-y-3">
                    {settings.metadataRules.map((rule) => (
                      <div key={rule.id} className="space-y-3 rounded-md border border-border bg-card p-4">
                        <div className="flex items-start justify-between gap-3">
                          <div className="grid flex-1 gap-3 md:grid-cols-2">
                            <div className="space-y-2">
                              <SettingFieldHeader
                                label={retrievalSettingDocs.metadataKey.label}
                                description={retrievalSettingDocs.metadataKey.summary}
                                tooltip={retrievalSettingDocs.metadataKey.details}
                              />
                              <Input
                                value={rule.field}
                                onChange={(event) => applyMetadataField(rule.id, event.target.value)}
                                placeholder="e.g. language or parsedData.url"
                                list="metadata-field-suggestions"
                              />
                            </div>
                            <div className="space-y-2">
                              <SettingFieldHeader
                                label={retrievalSettingDocs.metadataValueType.label}
                                description={retrievalSettingDocs.metadataValueType.summary}
                                tooltip={retrievalSettingDocs.metadataValueType.details}
                              />
                              <Select
                                value={rule.valueType}
                                onValueChange={(value) =>
                                  applyMetadataValueType(
                                    rule.id,
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
                              <p className="text-sm text-muted-foreground">
                                {metadataValueTypeLabels[rule.valueType].description}
                              </p>
                            </div>
                            <div className="space-y-2">
                              <SettingFieldHeader
                                label={retrievalSettingDocs.metadataValue.label}
                                description={retrievalSettingDocs.metadataValue.summary}
                                tooltip={retrievalSettingDocs.metadataValue.details}
                              />
                              {rule.valueType === 'boolean' ? (
                                <Select
                                  value={rule.value === 'false' ? 'false' : 'true'}
                                  onValueChange={(value) => updateMetadataRule(rule.id, { value })}
                                >
                                  <SelectTrigger className="w-full">
                                    <SelectValue />
                                  </SelectTrigger>
                                  <SelectContent>
                                    <SelectItem value="true">True</SelectItem>
                                    <SelectItem value="false">False</SelectItem>
                                  </SelectContent>
                                </Select>
                              ) : (
                                <Input
                                  type={rule.valueType === 'date' ? 'date' : rule.valueType === 'number' ? 'number' : 'text'}
                                  value={rule.value}
                                  onChange={(event) => updateMetadataRule(rule.id, { value: event.target.value })}
                                  placeholder={
                                    rule.valueType === 'date'
                                      ? '2026-03-26'
                                      : rule.valueType === 'number'
                                        ? '100'
                                        : 'e.g. et or example.com'
                                  }
                                />
                              )}
                            </div>
                            <div className="space-y-2">
                              <SettingFieldHeader
                                label={retrievalSettingDocs.metadataOperator.label}
                                description={retrievalSettingDocs.metadataOperator.summary}
                                tooltip={retrievalSettingDocs.metadataOperator.details}
                              />
                              <Select
                                value={rule.operator}
                                onValueChange={(value) =>
                                  updateMetadataRule(rule.id, {
                                    operator: value as RetrievalSettings['metadataRules'][number]['operator'],
                                  })
                                }
                              >
                                <SelectTrigger className="w-full">
                                  <SelectValue />
                                </SelectTrigger>
                                <SelectContent>
                                  {operatorOptionsForValueType(rule.valueType).map((value) => (
                                    <SelectItem key={value} value={value}>
                                      {metadataRuleOperatorLabels[value].label}
                                    </SelectItem>
                                  ))}
                                </SelectContent>
                              </Select>
                              <p className="text-sm text-muted-foreground">
                                {metadataRuleOperatorLabels[rule.operator].description}
                              </p>
                            </div>
                            <div className="space-y-2">
                              <SettingFieldHeader
                                label={retrievalSettingDocs.metadataEffect.label}
                                description={retrievalSettingDocs.metadataEffect.summary}
                                tooltip={retrievalSettingDocs.metadataEffect.details}
                              />
                              <Select
                                value={rule.effect}
                                onValueChange={(value) =>
                                  updateMetadataRule(rule.id, {
                                    effect: value as RetrievalSettings['metadataRules'][number]['effect'],
                                  })
                                }
                              >
                                <SelectTrigger className="w-full">
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
                              <p className="text-sm text-muted-foreground">
                                {metadataRuleEffectLabels[rule.effect].description}
                              </p>
                            </div>
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
                            <Button type="button" variant="ghost" size="icon" onClick={() => removeMetadataRule(rule.id)}>
                              <Trash2 className="h-4 w-4" />
                            </Button>
                          </div>
                        </div>
                      </div>
                    ))}
                  </div>
                )}

                <datalist id="metadata-field-suggestions">
                  {settings.metadataFieldSuggestions.map((field) => (
                    <option key={field.field} value={field.field} />
                  ))}
                </datalist>
              </div>
            </div>
          </SettingsCard>

          <PipelineConnector />

          <SettingsCard
            eyebrow="Stage 3"
            icon={<SlidersHorizontal className="h-5 w-5 text-primary" />}
            title="Rerank the retrieved candidates"
            description="Optionally apply a stronger relevance pass before the final context is assembled."
          >
            <div className="space-y-4">
              <div className="flex items-center justify-between rounded-md border border-border bg-muted/20 p-3">
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

              <div className="space-y-4 rounded-md border border-border bg-muted/20 p-4">
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
              </div>
            </div>
          </SettingsCard>

          <PipelineConnector />

          <SettingsCard
            id="assistant"
            eyebrow="Stage 4"
            icon={<Bot className="h-5 w-5 text-primary" />}
            title="Shape the final answer"
            description="Once evidence is assembled, configure how the grounded response should read and what support it should expose."
          >
            <div className="space-y-4">
              <div className="flex items-center justify-between rounded-md border border-border bg-muted/20 p-3">
                <div>
                  <div className="flex items-center gap-1.5">
                    <Label htmlFor="citationDisplay" className="text-foreground">
                      {retrievalSettingDocs.citationDisplayEnabled.label}
                    </Label>
                    <SettingTooltip
                      label={retrievalSettingDocs.citationDisplayEnabled.label}
                      content={retrievalSettingDocs.citationDisplayEnabled.details}
                    />
                  </div>
                  <div className="mt-0.5 text-sm text-muted-foreground">
                    <AssistantMarkdownContent content={retrievalSettingDocs.citationDisplayEnabled.summary} inline />
                  </div>
                </div>
                <Switch
                  id="citationDisplay"
                  checked={settings.citationDisplayEnabled}
                  onCheckedChange={(checked) => updateSetting('citationDisplayEnabled', checked)}
                />
              </div>

              <div className="space-y-2 rounded-md border border-border bg-muted/20 p-4">
                <SettingFieldHeader
                  htmlFor="conversationMode"
                  label={retrievalSettingDocs.conversationMode.label}
                  description={retrievalSettingDocs.conversationMode.summary}
                  tooltip={retrievalSettingDocs.conversationMode.details}
                />
                <Select
                  value={settings.conversationMode}
                  onValueChange={(value) =>
                    updateSetting('conversationMode', value as RetrievalSettings['conversationMode'])
                  }
                >
                  <SelectTrigger id="conversationMode" className="w-full">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {Object.entries(conversationModeLabels).map(([value, meta]) => (
                      <SelectItem key={value} value={value}>
                        {meta.label}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                <p className="text-sm text-muted-foreground">
                  {conversationModeLabels[settings.conversationMode].description}
                </p>
              </div>

              <div className="flex items-center justify-between rounded-md border border-border bg-muted/20 p-3">
                <div>
                  <div className="flex items-center gap-1.5">
                    <Label htmlFor="suggestedQuestionsEnabled" className="text-foreground">
                      {retrievalSettingDocs.suggestedQuestionsEnabled.label}
                    </Label>
                    <SettingTooltip
                      label={retrievalSettingDocs.suggestedQuestionsEnabled.label}
                      content={retrievalSettingDocs.suggestedQuestionsEnabled.details}
                    />
                  </div>
                  <div className="mt-0.5 text-sm text-muted-foreground">
                    <AssistantMarkdownContent content={retrievalSettingDocs.suggestedQuestionsEnabled.summary} inline />
                  </div>
                </div>
                <Switch
                  id="suggestedQuestionsEnabled"
                  checked={settings.suggestedQuestionsEnabled}
                  onCheckedChange={(checked) => updateSetting('suggestedQuestionsEnabled', checked)}
                />
              </div>

              <div className="space-y-3 rounded-md border border-border bg-muted/20 p-4">
                <SettingFieldHeader
                  htmlFor="suggestedQuestionsCount"
                  label={retrievalSettingDocs.suggestedQuestionsCount.label}
                  description={retrievalSettingDocs.suggestedQuestionsCount.summary}
                  tooltip={retrievalSettingDocs.suggestedQuestionsCount.details}
                />
                <Slider
                  id="suggestedQuestionsCount"
                  min={1}
                  max={4}
                  step={1}
                  value={[settings.suggestedQuestionsCount]}
                  disabled={!settings.suggestedQuestionsEnabled}
                  onValueChange={(value) => updateSetting('suggestedQuestionsCount', value[0] ?? 1)}
                />
                <div className="flex items-center justify-between text-sm text-muted-foreground">
                  <span>{suggestedQuestionCountLabel(settings.suggestedQuestionsCount)}</span>
                  <span>{settings.suggestedQuestionsEnabled ? 'Shown when grounded suggestions are available.' : 'Enable suggested questions to use this setting.'}</span>
                </div>
              </div>

              <div className="space-y-2 rounded-md border border-border bg-muted/20 p-4">
                <SettingFieldHeader
                  htmlFor="answerSupportPolicy"
                  label={retrievalSettingDocs.answerSupportPolicy.label}
                  description={retrievalSettingDocs.answerSupportPolicy.summary}
                  tooltip={retrievalSettingDocs.answerSupportPolicy.details}
                />
                <Select
                  value={settings.answerSupportPolicy}
                  onValueChange={(value) =>
                    updateSetting('answerSupportPolicy', value as RetrievalSettings['answerSupportPolicy'])
                  }
                >
                  <SelectTrigger id="answerSupportPolicy" className="w-full">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {Object.entries(answerSupportPolicyLabels).map(([value, meta]) => (
                      <SelectItem key={value} value={value}>
                        {meta.label}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                <p className="text-sm text-muted-foreground">
                  {answerSupportPolicyLabels[settings.answerSupportPolicy].description}
                </p>
              </div>

              <div className="space-y-3">
                <SettingFieldHeader
                  htmlFor="customInstruction"
                  label={retrievalSettingDocs.customInstruction.label}
                  description={retrievalSettingDocs.customInstruction.summary}
                  tooltip={retrievalSettingDocs.customInstruction.details}
                />
                <Textarea
                  id="customInstruction"
                  value={settings.customInstruction}
                  onChange={(event) => updateSetting('customInstruction', event.target.value.slice(0, 2000))}
                  placeholder="e.g. Always cite the specific section of the Act when referencing legal provisions."
                  rows={4}
                />
                <p className="text-xs text-right text-muted-foreground">
                  {settings.customInstruction.length} / 2000
                </p>
              </div>

              <p className="text-sm text-muted-foreground">
                The assistant may still ask a clarification question when your request is missing information needed for a reliable answer.
              </p>
            </div>
          </SettingsCard>
        </div>
      </div>
    </div>
  )
}
