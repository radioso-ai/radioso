'use client'

import { ChevronDown } from 'lucide-react'

import { AssistantSourceScopeSelector } from '@/components/dashboard/settings/assistant-source-scope-selector'
import { MetadataRulesEditor } from '@/components/dashboard/settings/metadata-rules-editor'
import { createDefaultMetadataRule } from '@/components/dashboard/settings/retrieval-rule-helpers'
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
import { Textarea } from '@/components/ui/textarea'
import type { AgentSourceScope, DocumentSourceListItem, RetrievalSettings } from '@/lib/api'
import type { RetrievalSkillSettingsOverride, RetrievalStrategy } from '@/lib/retrieval-skill-settings'

const hasOverride = <K extends keyof RetrievalSkillSettingsOverride>(
  value: RetrievalSkillSettingsOverride,
  field: K,
) => Object.prototype.hasOwnProperty.call(value, field)

const defaultLabel = (value: string | number | boolean) => `Default: ${formatValue(value)}`

const formatValue = (value: string | number | boolean) => {
  if (typeof value === 'boolean') {
    return value ? 'on' : 'off'
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
          {overridden ? 'Overridden for this agent' : defaultLabel(inherited)}
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
  onChange,
  sourceScope,
  sourceList = [],
  isSourceListLoading = false,
  sourceListError = null,
  onSourceScopeChange,
}: {
  defaults: RetrievalSettings
  value: RetrievalSkillSettingsOverride
  onChange: (next: RetrievalSkillSettingsOverride) => void
  sourceScope: AgentSourceScope
  sourceList?: DocumentSourceListItem[]
  isSourceListLoading?: boolean
  sourceListError?: string | null
  onSourceScopeChange: (next: AgentSourceScope) => void
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

  const effectiveMetadataRules = hasOverride(value, 'metadataRules')
    ? value.metadataRules ?? []
    : defaults.metadataRules
  const hasMetadataRules = effectiveMetadataRules.length > 0
  const addMetadataRule = () => {
    setField('metadataRules', [
      ...(hasOverride(value, 'metadataRules') ? value.metadataRules ?? [] : defaults.metadataRules),
      createDefaultMetadataRule(defaults.metadataFieldSuggestions),
    ])
  }

  return (
    <div id="retrieval-skill-settings" className="space-y-4">
      <div className="space-y-4">
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
                  <SelectItem value="inherit">{defaultLabel(defaults.queryRewriteEnabled)}</SelectItem>
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
                  <SelectItem value="inherit">{defaultLabel(defaults.retrievalStrategy)}</SelectItem>
                  <SelectItem value="fixed">Fixed</SelectItem>
                  <SelectItem value="reasoning">Reasoning</SelectItem>
                  <SelectItem value="auto">Auto</SelectItem>
                </SelectContent>
              </Select>
            </div>
          </div>

          <div id="agent-knowledge-scope-settings" className="space-y-4">
            <div className="space-y-0.5">
              <h4 className="text-sm font-semibold text-foreground">Knowledge scope</h4>
              <p className="text-xs text-muted-foreground">
                Configure which documents this agent can retrieve.
              </p>
            </div>
            <AssistantSourceScopeSelector
              sourceScope={sourceScope}
              sourceList={sourceList}
              isSourceListLoading={isSourceListLoading}
              sourceListError={sourceListError}
              onChange={onSourceScopeChange}
            />
            <div id="agent-metadata-rules-settings" className="space-y-3 rounded-lg border border-border p-3">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <div>
                  <Label className="text-foreground">Metadata rules</Label>
                  <p className="text-xs text-muted-foreground">
                    {hasOverride(value, 'metadataRules') ? 'Overridden for this agent' : 'Default rules'}
                  </p>
                </div>
                {hasOverride(value, 'metadataRules') ? (
                  <Button type="button" size="sm" variant="ghost" onClick={() => clearField('metadataRules')}>
                    Clear override
                  </Button>
                ) : (
                  <Button
                    type="button"
                    size="sm"
                    variant="outline"
                    onClick={() => setField('metadataRules', defaults.metadataRules)}
                  >
                    Override metadata rules
                  </Button>
                )}
              </div>
              {hasMetadataRules ? (
                <MetadataRulesEditor
                  metadataRules={effectiveMetadataRules}
                  metadataFieldSuggestions={defaults.metadataFieldSuggestions}
                  readOnly={!hasOverride(value, 'metadataRules')}
                  onChange={(metadataRules) => setField('metadataRules', metadataRules)}
                />
              ) : (
                <div className="rounded-md border border-dashed border-border p-4">
                  <Button type="button" size="sm" variant="outline" onClick={addMetadataRule}>
                    Add rule
                  </Button>
                </div>
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
                  <SelectItem value="inherit">{defaultLabel(defaults.suggestedQuestionsEnabled)}</SelectItem>
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
                <div className="grid gap-4 md:grid-cols-2">
                  <div className="space-y-3">
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

                  <div className="space-y-3">
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
                        <SelectItem value="inherit">{defaultLabel(defaults.rerankEnabled)}</SelectItem>
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
    </div>
  )
}
