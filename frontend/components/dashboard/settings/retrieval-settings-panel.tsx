'use client'

import { useEffect, useState } from 'react'
import { Bot, Plus, Save, Search, SlidersHorizontal, Trash2 } from 'lucide-react'

import { SettingsCard } from '@/components/dashboard/settings/settings-card'
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
        <div className="max-w-xl space-y-8">
          <SettingsCard
            icon={<Bot className="h-5 w-5 text-primary" />}
            title="Assistant"
            description="Control how grounded answers are presented to the user."
          >
            <div className="space-y-4">
              <div className="space-y-3">
                <div className="flex items-center justify-between">
                  <Label htmlFor="warmthLevel" className="text-foreground">Warmth</Label>
                  <span className="text-sm text-muted-foreground font-mono">
                    {settings.warmthLevel}
                  </span>
                </div>
                <Slider
                  id="warmthLevel"
                  min={1}
                  max={10}
                  step={1}
                  value={[settings.warmthLevel]}
                  onValueChange={([value]) => updateSetting('warmthLevel', value)}
                />
                <div className="flex items-center justify-between text-xs text-muted-foreground">
                  <span>Terse</span>
                  <span>Very warm</span>
                </div>
                <p className="text-sm text-muted-foreground">
                  Controls how concise or warm the assistant sounds without changing the underlying answer.
                </p>
              </div>

              <div className="flex items-center justify-between rounded-md border border-border bg-muted/20 p-3">
                <div>
                  <Label htmlFor="citationDisplay" className="text-foreground">Show Citations</Label>
                  <p className="text-sm text-muted-foreground mt-0.5">
                    Show inline source markers when supporting evidence is available.
                  </p>
                </div>
                <Switch
                  id="citationDisplay"
                  checked={settings.citationDisplayEnabled}
                  onCheckedChange={(checked) => updateSetting('citationDisplayEnabled', checked)}
                />
              </div>

              <div className="space-y-3">
                <div className="space-y-1">
                  <Label htmlFor="customInstruction" className="text-foreground">Custom Instruction</Label>
                  <p className="text-sm text-muted-foreground">
                    Give the assistant workspace-specific instructions. For example: &quot;Always cite the paragraph number when referencing legal provisions&quot; or &quot;Include a direct URL instead of saying visit their website.&quot;
                  </p>
                </div>
                <Textarea
                  id="customInstruction"
                  value={settings.customInstruction}
                  onChange={(event) => updateSetting('customInstruction', event.target.value.slice(0, 2000))}
                  placeholder="e.g. Always cite the specific section of the Act when referencing legal provisions."
                  rows={4}
                />
                <p className="text-xs text-muted-foreground text-right">
                  {settings.customInstruction.length} / 2000
                </p>
              </div>

              <p className="text-sm text-muted-foreground">
                The assistant may still ask a clarification question when your request is missing information needed for a reliable answer.
              </p>
            </div>
          </SettingsCard>

          <SettingsCard
            icon={<Search className="h-5 w-5 text-primary" />}
            title="Retrieval Pipeline"
            description="Control how the system expands, filters, and reranks evidence."
          >
            <div className="space-y-4">
              <div className="flex items-center justify-between rounded-md border border-border bg-muted/20 p-3">
                <div>
                  <Label htmlFor="queryRewrite" className="text-foreground">Query Rewrite</Label>
                  <p className="text-sm text-muted-foreground mt-0.5">
                    Automatically optimize queries for better retrieval.
                  </p>
                </div>
                <Switch
                  id="queryRewrite"
                  checked={settings.queryRewriteEnabled}
                  onCheckedChange={(checked) => updateSetting('queryRewriteEnabled', checked)}
                />
              </div>

              <div className="flex items-center justify-between rounded-md border border-border bg-muted/20 p-3">
                <div>
                  <Label htmlFor="rerank" className="text-foreground">Reranking</Label>
                  <p className="text-sm text-muted-foreground mt-0.5">
                    Use a reranker to improve result relevance.
                  </p>
                </div>
                <Switch
                  id="rerank"
                  checked={settings.rerankEnabled}
                  onCheckedChange={(checked) => updateSetting('rerankEnabled', checked)}
                />
              </div>

              <div className="space-y-4 rounded-md border border-border bg-muted/20 p-4">
                <div className="space-y-2">
                  <div className="flex items-center justify-between gap-4">
                    <div className="space-y-1">
                      <Label className="text-foreground">Metadata Rules</Label>
                      <p className="text-sm text-muted-foreground">
                        Create always-on rules that boost or filter results by document metadata.
                      </p>
                    </div>
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
                              <Label className="text-foreground">Metadata Key</Label>
                              <Input
                                value={rule.field}
                                onChange={(event) => applyMetadataField(rule.id, event.target.value)}
                                placeholder="e.g. language or parsedData.url"
                                list="metadata-field-suggestions"
                              />
                            </div>
                            <div className="space-y-2">
                              <Label className="text-foreground">Value Type</Label>
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
                              <Label className="text-foreground">Value</Label>
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
                              <Label className="text-foreground">Operator</Label>
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
                              <Label className="text-foreground">Effect</Label>
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

          <SettingsCard
            icon={<SlidersHorizontal className="h-5 w-5 text-primary" />}
            title="Search Tuning"
            description="Adjust lower-level retrieval thresholds and candidate counts."
          >
            <div className="space-y-4 rounded-md border border-border bg-muted/20 p-4">
              <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">Advanced</p>

              <div className="space-y-3">
                <div className="flex items-center justify-between">
                  <Label htmlFor="vectorTopK" className="text-foreground">Vector Top K</Label>
                  <span className="text-sm text-muted-foreground font-mono">{settings.vectorTopK}</span>
                </div>
                <Slider
                  id="vectorTopK"
                  min={1}
                  max={300}
                  step={1}
                  value={[settings.vectorTopK]}
                  onValueChange={([value]) => updateSetting('vectorTopK', value)}
                />
                <p className="text-sm text-muted-foreground">Number of chunks to retrieve from vector search.</p>
              </div>

              <div className="space-y-3">
                <div className="flex items-center justify-between">
                  <Label htmlFor="similarity" className="text-foreground">Similarity Threshold</Label>
                  <span className="text-sm text-muted-foreground font-mono">
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
                <p className="text-sm text-muted-foreground">Minimum similarity score for retrieved chunks.</p>
              </div>

              <div className="space-y-3">
                <div className="flex items-center justify-between">
                  <Label htmlFor="rerankTopK" className="text-foreground">Rerank Top K</Label>
                  <span className="text-sm text-muted-foreground font-mono">{settings.rerankTopK}</span>
                </div>
                <Slider
                  id="rerankTopK"
                  min={1}
                  max={50}
                  step={1}
                  value={[settings.rerankTopK]}
                  onValueChange={([value]) => updateSetting('rerankTopK', value)}
                />
                <p className="text-sm text-muted-foreground">Number of chunks to keep after reranking.</p>
              </div>
            </div>
          </SettingsCard>
        </div>
      </div>
    </div>
  )
}
