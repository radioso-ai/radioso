'use client'

import { ChevronDown, DatabaseZap } from 'lucide-react'

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
import { Switch } from '@/components/ui/switch'
import { Textarea } from '@/components/ui/textarea'
import type { RetrievalSettings } from '@/lib/api'
import type { RetrievalSkillSettingsOverride, RetrievalStrategy } from '@/lib/retrieval-skill-settings'

const hasOverride = <K extends keyof RetrievalSkillSettingsOverride>(
  value: RetrievalSkillSettingsOverride,
  field: K,
) => Object.prototype.hasOwnProperty.call(value, field)

const inheritedLabel = (value: string | number | boolean) => `Inherited from default: ${formatValue(value)}`

const formatValue = (value: string | number | boolean) => {
  if (typeof value === 'boolean') {
    return value ? 'On' : 'Off'
  }
  if (typeof value === 'string') {
    return value.trim().length > 0 ? value : 'None'
  }
  return String(value)
}

function FieldHeader({
  title,
  inherited,
  overridden,
  onClear,
}: {
  title: string
  inherited: string | number | boolean
  overridden: boolean
  onClear: () => void
}) {
  return (
    <div className="flex flex-wrap items-center justify-between gap-2">
      <div>
        <Label className="text-foreground">{title}</Label>
        <p className="text-xs text-muted-foreground">
          {overridden ? 'Overridden for this agent' : inheritedLabel(inherited)}
        </p>
      </div>
      {overridden ? (
        <Button type="button" size="sm" variant="ghost" onClick={onClear}>
          Clear override
        </Button>
      ) : null}
    </div>
  )
}

export function AssistantRetrievalSkillSettingsSection({
  defaults,
  value,
  retrievalEnabled,
  onChange,
  onRetrievalEnabledChange,
}: {
  defaults: RetrievalSettings
  value: RetrievalSkillSettingsOverride
  retrievalEnabled: boolean
  onChange: (next: RetrievalSkillSettingsOverride) => void
  onRetrievalEnabledChange: (enabled: boolean) => void
}) {
  const setField = <K extends keyof RetrievalSkillSettingsOverride>(
    field: K,
    nextValue: RetrievalSkillSettingsOverride[K],
  ) => {
    onChange({ ...value, [field]: nextValue })
  }

  const clearField = <K extends keyof RetrievalSkillSettingsOverride>(field: K) => {
    const next = { ...value }
    delete next[field]
    onChange(next)
  }

  const booleanSelectValue = (field: 'queryRewriteEnabled' | 'suggestedQuestionsEnabled' | 'rerankEnabled') =>
    hasOverride(value, field) ? String(value[field]) : 'inherit'

  const numberValue = (
    field: 'suggestedQuestionsCount' | 'vectorTopK' | 'rerankTopK',
    fallback: number,
  ) => hasOverride(value, field) ? value[field] ?? fallback : fallback

  return (
    <div id="retrieval-skill-settings" className="space-y-4 border-t border-border pt-5">
      <div className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
        <div className="flex min-w-0 gap-3">
          <div className="flex h-11 w-11 shrink-0 items-center justify-center rounded-2xl border border-primary/15 bg-primary/10">
            <DatabaseZap className="h-5 w-5 text-primary" />
          </div>
          <div className="min-w-0">
            <h3 className="font-medium text-foreground">Retrieval answers</h3>
            <p className="text-sm text-muted-foreground">
              Ground this agent in workspace knowledge, with per-field overrides that inherit defaults until changed.
            </p>
          </div>
        </div>
        <Switch
          id="retrievalEnabledToggle"
          checked={retrievalEnabled}
          onCheckedChange={onRetrievalEnabledChange}
          className="sm:mt-3"
        />
      </div>

      {retrievalEnabled ? (
        <div className="space-y-4">
          <div className="space-y-3 rounded-lg border border-border p-3">
            <FieldHeader
              title="Answer instruction"
              inherited={defaults.customInstruction}
              overridden={hasOverride(value, 'customInstruction')}
              onClear={() => clearField('customInstruction')}
            />
            {hasOverride(value, 'customInstruction') ? (
              <Textarea
                id="retrievalCustomInstruction"
                aria-label="Retrieval answer instruction"
                value={value.customInstruction ?? ''}
                onChange={(event) => setField('customInstruction', event.target.value.slice(0, 2000))}
                rows={3}
              />
            ) : (
              <Button type="button" size="sm" variant="outline" onClick={() => setField('customInstruction', defaults.customInstruction)}>
                Override answer instruction
              </Button>
            )}
          </div>

          <div className="grid gap-4 md:grid-cols-2">
            <div className="space-y-2 rounded-lg border border-border p-3">
              <FieldHeader
                title="Query rewrite"
                inherited={defaults.queryRewriteEnabled}
                overridden={hasOverride(value, 'queryRewriteEnabled')}
                onClear={() => clearField('queryRewriteEnabled')}
              />
              <Select
                value={booleanSelectValue('queryRewriteEnabled')}
                onValueChange={(next) =>
                  next === 'inherit' ? clearField('queryRewriteEnabled') : setField('queryRewriteEnabled', next === 'true')
                }
              >
                <SelectTrigger id="retrievalQueryRewrite" className="w-full">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="inherit">{inheritedLabel(defaults.queryRewriteEnabled)}</SelectItem>
                  <SelectItem value="true">On</SelectItem>
                  <SelectItem value="false">Off</SelectItem>
                </SelectContent>
              </Select>
            </div>

            <div className="space-y-2 rounded-lg border border-border p-3">
              <FieldHeader
                title="Answering strategy"
                inherited={defaults.retrievalStrategy}
                overridden={hasOverride(value, 'retrievalStrategy')}
                onClear={() => clearField('retrievalStrategy')}
              />
              <Select
                value={hasOverride(value, 'retrievalStrategy') ? value.retrievalStrategy : 'inherit'}
                onValueChange={(next) =>
                  next === 'inherit' ? clearField('retrievalStrategy') : setField('retrievalStrategy', next as RetrievalStrategy)
                }
              >
                <SelectTrigger id="agentRetrievalStrategy" className="w-full">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="inherit">{inheritedLabel(defaults.retrievalStrategy)}</SelectItem>
                  <SelectItem value="fixed">Fixed</SelectItem>
                  <SelectItem value="reasoning">Reasoning</SelectItem>
                  <SelectItem value="auto">Auto</SelectItem>
                </SelectContent>
              </Select>
            </div>
          </div>

          <div className="grid gap-4 md:grid-cols-2">
            <div className="space-y-3 rounded-lg border border-border p-3">
              <FieldHeader
                title="Semantic rewrite instructions"
                inherited={defaults.semanticRewriteInstructions}
                overridden={hasOverride(value, 'semanticRewriteInstructions')}
                onClear={() => clearField('semanticRewriteInstructions')}
              />
              {hasOverride(value, 'semanticRewriteInstructions') ? (
                <Textarea
                  id="semanticRewriteInstructions"
                  aria-label="Semantic rewrite instructions"
                  value={value.semanticRewriteInstructions ?? ''}
                  onChange={(event) => setField('semanticRewriteInstructions', event.target.value.slice(0, 2000))}
                  rows={3}
                />
              ) : (
                <Button type="button" size="sm" variant="outline" onClick={() => setField('semanticRewriteInstructions', defaults.semanticRewriteInstructions)}>
                  Override semantic instructions
                </Button>
              )}
            </div>

            <div className="space-y-3 rounded-lg border border-border p-3">
              <FieldHeader
                title="Lexical rewrite instructions"
                inherited={defaults.lexicalRewriteInstructions}
                overridden={hasOverride(value, 'lexicalRewriteInstructions')}
                onClear={() => clearField('lexicalRewriteInstructions')}
              />
              {hasOverride(value, 'lexicalRewriteInstructions') ? (
                <Textarea
                  id="lexicalRewriteInstructions"
                  aria-label="Lexical rewrite instructions"
                  value={value.lexicalRewriteInstructions ?? ''}
                  onChange={(event) => setField('lexicalRewriteInstructions', event.target.value.slice(0, 2000))}
                  rows={3}
                />
              ) : (
                <Button type="button" size="sm" variant="outline" onClick={() => setField('lexicalRewriteInstructions', defaults.lexicalRewriteInstructions)}>
                  Override lexical instructions
                </Button>
              )}
            </div>
          </div>

          <div className="grid gap-4 md:grid-cols-2">
            <div className="space-y-2 rounded-lg border border-border p-3">
              <FieldHeader
                title="Suggested questions"
                inherited={defaults.suggestedQuestionsEnabled}
                overridden={hasOverride(value, 'suggestedQuestionsEnabled')}
                onClear={() => clearField('suggestedQuestionsEnabled')}
              />
              <Select
                value={booleanSelectValue('suggestedQuestionsEnabled')}
                onValueChange={(next) =>
                  next === 'inherit' ? clearField('suggestedQuestionsEnabled') : setField('suggestedQuestionsEnabled', next === 'true')
                }
              >
                <SelectTrigger id="agentSuggestedQuestionsEnabled" className="w-full">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="inherit">{inheritedLabel(defaults.suggestedQuestionsEnabled)}</SelectItem>
                  <SelectItem value="true">On</SelectItem>
                  <SelectItem value="false">Off</SelectItem>
                </SelectContent>
              </Select>
            </div>

            <div className="space-y-2 rounded-lg border border-border p-3">
              <FieldHeader
                title="Suggested question count"
                inherited={defaults.suggestedQuestionsCount}
                overridden={hasOverride(value, 'suggestedQuestionsCount')}
                onClear={() => clearField('suggestedQuestionsCount')}
              />
              <Input
                id="suggestedQuestionsCount"
                aria-label="Suggested question count"
                type="number"
                min={1}
                max={4}
                value={numberValue('suggestedQuestionsCount', defaults.suggestedQuestionsCount)}
                disabled={!hasOverride(value, 'suggestedQuestionsCount')}
                onChange={(event) => setField('suggestedQuestionsCount', Number(event.target.value))}
              />
              {!hasOverride(value, 'suggestedQuestionsCount') ? (
                <Button type="button" size="sm" variant="outline" onClick={() => setField('suggestedQuestionsCount', defaults.suggestedQuestionsCount)}>
                  Override count
                </Button>
              ) : null}
            </div>
          </div>

          <Collapsible>
            <div className="rounded-lg border border-border p-3">
              <CollapsibleTrigger asChild>
                <Button type="button" variant="ghost" className="w-full justify-between px-0">
                  Advanced retrieval tuning
                  <ChevronDown className="h-4 w-4" />
                </Button>
              </CollapsibleTrigger>
              <CollapsibleContent className="space-y-4 pt-3">
                <div className="grid gap-4 md:grid-cols-3">
                  <div className="space-y-2">
                    <FieldHeader
                      title="Vector top K"
                      inherited={defaults.vectorTopK}
                      overridden={hasOverride(value, 'vectorTopK')}
                      onClear={() => clearField('vectorTopK')}
                    />
                    <Input
                      id="vectorTopK"
                      aria-label="Vector top K"
                      type="number"
                      min={1}
                      max={300}
                      value={numberValue('vectorTopK', defaults.vectorTopK)}
                      disabled={!hasOverride(value, 'vectorTopK')}
                      onChange={(event) => setField('vectorTopK', Number(event.target.value))}
                    />
                    {!hasOverride(value, 'vectorTopK') ? (
                      <Button type="button" size="sm" variant="outline" onClick={() => setField('vectorTopK', defaults.vectorTopK)}>
                        Override vector top K
                      </Button>
                    ) : null}
                  </div>
                  <div className="space-y-2">
                    <FieldHeader
                      title="Rerank"
                      inherited={defaults.rerankEnabled}
                      overridden={hasOverride(value, 'rerankEnabled')}
                      onClear={() => clearField('rerankEnabled')}
                    />
                    <Select
                      value={booleanSelectValue('rerankEnabled')}
                      onValueChange={(next) =>
                        next === 'inherit' ? clearField('rerankEnabled') : setField('rerankEnabled', next === 'true')
                      }
                    >
                      <SelectTrigger id="agentRerankEnabled" className="w-full">
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="inherit">{inheritedLabel(defaults.rerankEnabled)}</SelectItem>
                        <SelectItem value="true">On</SelectItem>
                        <SelectItem value="false">Off</SelectItem>
                      </SelectContent>
                    </Select>
                  </div>
                  <div className="space-y-2">
                    <FieldHeader
                      title="Rerank top K"
                      inherited={defaults.rerankTopK}
                      overridden={hasOverride(value, 'rerankTopK')}
                      onClear={() => clearField('rerankTopK')}
                    />
                    <Input
                      id="rerankTopK"
                      aria-label="Rerank top K"
                      type="number"
                      min={1}
                      max={50}
                      value={numberValue('rerankTopK', defaults.rerankTopK)}
                      disabled={!hasOverride(value, 'rerankTopK')}
                      onChange={(event) => setField('rerankTopK', Number(event.target.value))}
                    />
                    {!hasOverride(value, 'rerankTopK') ? (
                      <Button type="button" size="sm" variant="outline" onClick={() => setField('rerankTopK', defaults.rerankTopK)}>
                        Override rerank top K
                      </Button>
                    ) : null}
                  </div>
                </div>
              </CollapsibleContent>
            </div>
          </Collapsible>
        </div>
      ) : null}
    </div>
  )
}
