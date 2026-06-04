'use client'

import { ChevronDown } from 'lucide-react'

import { AssistantSourceScopeSelector } from '@/components/dashboard/settings/assistant-source-scope-selector'
import { MetadataRulesEditor } from '@/components/dashboard/settings/metadata-rules-editor'
import { getRulePreviewLabel } from '@/components/dashboard/settings/retrieval-rule-helpers'
import { retrievalSettingDocs, type SettingDoc } from '@/components/dashboard/settings/settings-docs'
import { SettingFieldHeader } from '@/components/dashboard/settings/settings-flow'
import { Button } from '@/components/ui/button'
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible'
import { Input } from '@/components/ui/input'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { Textarea } from '@/components/ui/textarea'
import type { AgentSourceScope, DocumentSourceListItem, RetrievalMetadataRule, RetrievalSettings } from '@/lib/api'
import type { RetrievalSkillSettingsOverride, RetrievalStrategy } from '@/lib/retrieval-skill-settings'

const hasOverride = <K extends keyof RetrievalSkillSettingsOverride>(
  value: RetrievalSkillSettingsOverride,
  field: K,
) => Object.prototype.hasOwnProperty.call(value, field)

const formatValue = (value: string | number | boolean) => {
  if (typeof value === 'boolean') {
    return value ? 'on' : 'off'
  }
  if (typeof value === 'string') {
    return value.trim().length > 0 ? value : 'None'
  }
  return String(value)
}

const inheritedStatus = (value: string | number | boolean) =>
  typeof value === 'string' && value.trim().length > 24
    ? 'Default'
    : `Default: ${formatValue(value)}`

const cloneMetadataRules = (rules: RetrievalMetadataRule[]): RetrievalMetadataRule[] =>
  rules.map((rule) => ({
    ...rule,
    conditions: rule.conditions?.map((condition) => ({ ...condition })),
  }))

function FieldHeader({
  doc,
  htmlFor,
  inherited,
  overridden,
  onClear,
}: {
  doc: SettingDoc
  htmlFor?: string
  inherited: string | number | boolean
  overridden: boolean
  onClear: () => void
}) {
  return (
    <div className="flex flex-wrap items-start justify-between gap-2">
      <div className="space-y-1">
        <SettingFieldHeader
          htmlFor={htmlFor}
          label={doc.label}
          description={doc.summary}
          tooltip={doc.details}
        />
        <p className="text-xs text-muted-foreground">
          {overridden ? 'Overridden for this agent' : inheritedStatus(inherited)}
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

function InheritedValuePreview({ value }: { value: string | number | boolean }) {
  return (
    <div className="rounded-md border border-border bg-muted/20 px-3 py-2 text-sm text-muted-foreground">
      {formatValue(value)}
    </div>
  )
}

function MetadataRulesSummary({ rules }: { rules: RetrievalMetadataRule[] }) {
  if (rules.length === 0) {
    return (
      <div className="rounded-md border border-dashed border-border p-3 text-sm text-muted-foreground">
        No workspace metadata rules are configured.
      </div>
    )
  }

  const visibleRules = rules.slice(0, 3)
  const remainingCount = rules.length - visibleRules.length

  return (
    <div className="space-y-2 rounded-md border border-border bg-muted/20 p-3">
      <p className="text-sm font-medium text-foreground">
        {rules.length} inherited rule{rules.length === 1 ? '' : 's'}
      </p>
      <div className="space-y-1">
        {visibleRules.map((rule) => (
          <p key={rule.id} className="truncate text-sm text-muted-foreground">
            {getRulePreviewLabel(rule)}
          </p>
        ))}
      </div>
      {remainingCount > 0 ? (
        <p className="text-xs text-muted-foreground">
          +{remainingCount} more rule{remainingCount === 1 ? '' : 's'}
        </p>
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
  const metadataRulesOverridden = hasOverride(value, 'metadataRules')
  const overrideMetadataRules = () => {
    setField('metadataRules', cloneMetadataRules(defaults.metadataRules))
  }

  return (
    <div id="retrieval-skill-settings" className="space-y-4">
      <div className="space-y-4">
        <div id="agent-knowledge-scope-settings" className="space-y-4">
          <AssistantSourceScopeSelector
            sourceScope={sourceScope}
            sourceList={sourceList}
            isSourceListLoading={isSourceListLoading}
            sourceListError={sourceListError}
            onChange={onSourceScopeChange}
          />
        </div>

        <div className="grid gap-4 md:grid-cols-2">
          <div className="space-y-2 rounded-lg border border-border p-3">
            <FieldHeader
              doc={retrievalSettingDocs.suggestedQuestionsEnabled}
              htmlFor="agentSuggestedQuestionsEnabled"
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
                <SelectItem value="inherit">Use workspace default</SelectItem>
                <SelectItem value="true">On</SelectItem>
                <SelectItem value="false">Off</SelectItem>
              </SelectContent>
            </Select>
          </div>

          <div className="space-y-2 rounded-lg border border-border p-3">
            <FieldHeader
              doc={retrievalSettingDocs.suggestedQuestionsCount}
              htmlFor="suggestedQuestionsCount"
              inherited={defaults.suggestedQuestionsCount}
              overridden={hasOverride(value, 'suggestedQuestionsCount')}
              onClear={() => clearField('suggestedQuestionsCount')}
            />
            {hasOverride(value, 'suggestedQuestionsCount') ? (
              <Input
                id="suggestedQuestionsCount"
                aria-label="Suggested Question Count"
                type="number"
                min={1}
                max={4}
                value={numberValue('suggestedQuestionsCount', defaults.suggestedQuestionsCount)}
                onChange={(event) => setField('suggestedQuestionsCount', Number(event.target.value))}
              />
            ) : (
              <InheritedValuePreview value={defaults.suggestedQuestionsCount} />
            )}
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
                Advanced
                <ChevronDown className="h-4 w-4" />
              </Button>
            </CollapsibleTrigger>
            <CollapsibleContent className="space-y-5 pt-3">
              <section
                aria-labelledby="agent-retrieval-answering-heading"
                className="space-y-3 border-t border-border/60 pt-4"
              >
                <h4
                  id="agent-retrieval-answering-heading"
                  className="text-xs font-semibold uppercase tracking-wide text-muted-foreground"
                >
                  Answering
                </h4>
                <div className="grid gap-4 md:grid-cols-2">
                  <div className="space-y-2 rounded-lg border border-border p-3">
                    <FieldHeader
                      doc={retrievalSettingDocs.queryRewriteEnabled}
                      htmlFor="retrievalQueryRewrite"
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
                        <SelectItem value="inherit">Use workspace default</SelectItem>
                        <SelectItem value="true">On</SelectItem>
                        <SelectItem value="false">Off</SelectItem>
                      </SelectContent>
                    </Select>
                  </div>

                  <div className="space-y-2 rounded-lg border border-border p-3">
                    <FieldHeader
                      doc={retrievalSettingDocs.retrievalStrategy}
                      htmlFor="agentRetrievalStrategy"
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
                        <SelectItem value="inherit">Use workspace default</SelectItem>
                        <SelectItem value="fixed">Fixed</SelectItem>
                        <SelectItem value="reasoning">Reasoning</SelectItem>
                        <SelectItem value="auto">Auto</SelectItem>
                      </SelectContent>
                    </Select>
                  </div>
                </div>
              </section>

              <section
                aria-labelledby="agent-retrieval-tuning-heading"
                className="space-y-3 border-t border-border/60 pt-4"
              >
                <h4
                  id="agent-retrieval-tuning-heading"
                  className="text-xs font-semibold uppercase tracking-wide text-muted-foreground"
                >
                  Retrieval tuning
                </h4>
                <div className="grid gap-4 md:grid-cols-3">
                  <div className="space-y-2">
                    <FieldHeader
                      doc={retrievalSettingDocs.vectorTopK}
                      htmlFor="vectorTopK"
                      inherited={defaults.vectorTopK}
                      overridden={hasOverride(value, 'vectorTopK')}
                      onClear={() => clearField('vectorTopK')}
                    />
                    {hasOverride(value, 'vectorTopK') ? (
                      <Input
                        id="vectorTopK"
                        aria-label="Vector Top K"
                        type="number"
                        min={1}
                        max={300}
                        value={numberValue('vectorTopK', defaults.vectorTopK)}
                        onChange={(event) => setField('vectorTopK', Number(event.target.value))}
                      />
                    ) : (
                      <InheritedValuePreview value={defaults.vectorTopK} />
                    )}
                    {!hasOverride(value, 'vectorTopK') ? (
                      <Button type="button" size="sm" variant="outline" onClick={() => setField('vectorTopK', defaults.vectorTopK)}>
                        Override vector top K
                      </Button>
                    ) : null}
                  </div>
                  <div className="space-y-2">
                    <FieldHeader
                      doc={retrievalSettingDocs.rerankEnabled}
                      htmlFor="agentRerankEnabled"
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
                        <SelectItem value="inherit">Use workspace default</SelectItem>
                        <SelectItem value="true">On</SelectItem>
                        <SelectItem value="false">Off</SelectItem>
                      </SelectContent>
                    </Select>
                  </div>
                  <div className="space-y-2">
                    <FieldHeader
                      doc={retrievalSettingDocs.rerankTopK}
                      htmlFor="rerankTopK"
                      inherited={defaults.rerankTopK}
                      overridden={hasOverride(value, 'rerankTopK')}
                      onClear={() => clearField('rerankTopK')}
                    />
                    {hasOverride(value, 'rerankTopK') ? (
                      <Input
                        id="rerankTopK"
                        aria-label="Rerank Top K"
                        type="number"
                        min={1}
                        max={50}
                        value={numberValue('rerankTopK', defaults.rerankTopK)}
                        onChange={(event) => setField('rerankTopK', Number(event.target.value))}
                      />
                    ) : (
                      <InheritedValuePreview value={defaults.rerankTopK} />
                    )}
                    {!hasOverride(value, 'rerankTopK') ? (
                      <Button type="button" size="sm" variant="outline" onClick={() => setField('rerankTopK', defaults.rerankTopK)}>
                        Override rerank top K
                      </Button>
                    ) : null}
                  </div>
                </div>

                <div className="grid gap-4 md:grid-cols-2">
                  <div className="space-y-3">
                    <FieldHeader
                      doc={retrievalSettingDocs.semanticRewriteInstructions}
                      htmlFor="semanticRewriteInstructions"
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
                      <>
                        <InheritedValuePreview value="Workspace default instructions" />
                        <Button type="button" size="sm" variant="outline" onClick={() => setField('semanticRewriteInstructions', defaults.semanticRewriteInstructions)}>
                          Override semantic instructions
                        </Button>
                      </>
                    )}
                  </div>

                  <div className="space-y-3">
                    <FieldHeader
                      doc={retrievalSettingDocs.lexicalRewriteInstructions}
                      htmlFor="lexicalRewriteInstructions"
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
                      <>
                        <InheritedValuePreview value="Workspace default instructions" />
                        <Button type="button" size="sm" variant="outline" onClick={() => setField('lexicalRewriteInstructions', defaults.lexicalRewriteInstructions)}>
                          Override lexical instructions
                        </Button>
                      </>
                    )}
                  </div>
                </div>
              </section>

              <section
                aria-labelledby="agent-metadata-rules-heading"
                className="space-y-3 border-t border-border/60 pt-4"
              >
                <h4
                  id="agent-metadata-rules-heading"
                  className="text-xs font-semibold uppercase tracking-wide text-muted-foreground"
                >
                  Metadata rules
                </h4>
                <div id="agent-metadata-rules-settings" className="space-y-3 rounded-lg border border-border p-3">
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <div className="space-y-1">
                      <SettingFieldHeader
                        label={retrievalSettingDocs.metadataRules.label}
                        description={retrievalSettingDocs.metadataRules.summary}
                        tooltip={retrievalSettingDocs.metadataRules.details}
                      />
                      <p className="text-xs text-muted-foreground">
                        {metadataRulesOverridden ? 'Overridden for this agent' : 'Using workspace default'}
                      </p>
                    </div>
                    {metadataRulesOverridden ? (
                      <Button type="button" size="sm" variant="ghost" onClick={() => clearField('metadataRules')}>
                        Clear override
                      </Button>
                    ) : (
                      <Button
                        type="button"
                        size="sm"
                        variant="outline"
                        onClick={overrideMetadataRules}
                      >
                        Override metadata rules
                      </Button>
                    )}
                  </div>
                  {metadataRulesOverridden ? (
                    <MetadataRulesEditor
                      metadataRules={effectiveMetadataRules}
                      metadataFieldSuggestions={defaults.metadataFieldSuggestions}
                      showHeader={false}
                      onChange={(metadataRules) => setField('metadataRules', metadataRules)}
                    />
                  ) : (
                    <MetadataRulesSummary rules={defaults.metadataRules} />
                  )}
                </div>
              </section>
            </CollapsibleContent>
          </div>
        </Collapsible>
      </div>
    </div>
  )
}
