'use client'

import type { ReactNode } from 'react'
import { ChevronDown, CircleCheck, CircleX } from 'lucide-react'

import type { ActivityTrace, ActivityStage } from '@/lib/api'

const formatJson = (value: unknown) => JSON.stringify(value, null, 2)

type ChunkRef = {
  chunkId: string
  documentId: string
  title: string
}

function Section({
  title,
  children,
}: {
  title: string
  children: ReactNode
}) {
  return (
    <section className="space-y-2">
      <p className="text-sm font-medium text-foreground">{title}</p>
      {children}
    </section>
  )
}

function CollapsibleSection({
  title,
  children,
}: {
  title: string
  children: ReactNode
}) {
  return (
    <details className="group rounded-lg border border-border/70 bg-background/60 p-3 text-sm text-muted-foreground">
      <summary className="flex cursor-pointer list-none items-center justify-between gap-3 font-medium text-foreground">
        <span>{title}</span>
        <ChevronDown className="h-4 w-4 text-muted-foreground transition-transform group-open:rotate-180" />
      </summary>
      <div className="mt-3 space-y-3">{children}</div>
    </details>
  )
}

function KeyValueList({
  rows,
}: {
  rows: Array<{ label: string; value: string | number | boolean | null | undefined }>
}) {
  const visibleRows = rows.filter((row) => row.value !== undefined && row.value !== null && row.value !== '')

  if (!visibleRows.length) {
    return null
  }

  return (
    <div className="grid gap-2">
      {visibleRows.map((row) => (
        <div key={row.label} className="rounded-lg border border-border/70 bg-background/70 p-3 select-text">
          <p className="text-[11px] uppercase tracking-wide text-muted-foreground">{row.label}</p>
          <p className="mt-1 text-sm text-foreground">{String(row.value)}</p>
        </div>
      ))}
    </div>
  )
}

function StringList({
  values,
}: {
  values: string[]
}) {
  if (!values.length) {
    return null
  }

  return (
    <div className="flex flex-wrap gap-2">
      {values.map((value) => (
        <span key={value} className="rounded-full bg-muted px-2.5 py-1 text-xs text-muted-foreground select-text">
          {value}
        </span>
      ))}
    </div>
  )
}

function AppliedIndicator({ applied }: { applied: boolean }) {
  return (
    <div className="flex items-center gap-2 rounded-lg border border-border/70 bg-background/60 p-3 select-text">
      <p className="text-sm text-foreground">{applied ? 'Context applied' : 'Context not applied'}</p>
      {applied ? (
        <CircleCheck className="h-4 w-4 text-emerald-500" />
      ) : (
        <CircleX className="h-4 w-4 text-rose-500" />
      )}
    </div>
  )
}

function ChunkList({
  label,
  chunks,
}: {
  label: string
  chunks?: ChunkRef[]
}) {
  if (!chunks?.length) {
    return null
  }

  return (
    <Section title={label}>
      <div className="space-y-2">
        {chunks.map((chunk) => (
          <div
            key={`${chunk.documentId}-${chunk.chunkId}`}
            className="rounded-lg border border-border/70 bg-background/70 p-3 select-text"
          >
            <p className="text-sm text-foreground">{chunk.title}</p>
            <p className="mt-1 font-mono text-[11px] text-muted-foreground">{chunk.chunkId}</p>
          </div>
        ))}
      </div>
    </Section>
  )
}

function RawBlock({
  label,
  value,
}: {
  label: string
  value: unknown
}) {
  if (!value || (typeof value === 'object' && Object.keys(value as Record<string, unknown>).length === 0)) {
    return null
  }

  return (
    <div className="space-y-2 select-text">
      <p className="font-medium text-foreground">{label}</p>
      <pre className="cursor-text select-text overflow-x-auto rounded-lg border border-border/70 bg-background/70 p-3 text-[11px] text-muted-foreground">
        {formatJson(value)}
      </pre>
    </div>
  )
}

const getSelectedStage = (trace: ActivityTrace, selectedStageId: string): ActivityStage | undefined =>
  trace.stages.find((stage) => stage.stageId === selectedStageId)

const asRecord = (value: unknown): Record<string, unknown> =>
  value && typeof value === 'object' ? (value as Record<string, unknown>) : {}

const asStringList = (value: unknown): string[] =>
  Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === 'string') : []

const asBoolean = (value: unknown): boolean | undefined => (typeof value === 'boolean' ? value : undefined)

const asString = (value: unknown): string | undefined => (typeof value === 'string' && value.trim() ? value : undefined)

const joinHumanList = (values: string[]): string => {
  if (values.length <= 1) return values[0] ?? ''
  if (values.length === 2) return `${values[0]} and ${values[1]}`
  return `${values.slice(0, -1).join(', ')}, and ${values[values.length - 1]}`
}

const formatLabel = (value: unknown) => (typeof value === 'string' ? value.replaceAll('_', ' ') : undefined)

const formatIntent = (value: unknown): string | undefined => {
  if (value === 'social_only') return 'Conversational message'
  if (value === 'assistant_identity') return 'Question about the assistant'
  if (value === 'retrieval') return 'Workspace knowledge question'
  return formatLabel(value)
}

const asChunkList = (value: unknown): ChunkRef[] =>
  Array.isArray(value)
    ? value.filter(
        (entry): entry is ChunkRef =>
          Boolean(entry) &&
          typeof entry === 'object' &&
          'chunkId' in entry &&
          'documentId' in entry &&
          'title' in entry,
      )
    : []

const truncateText = (text: string, max: number): string =>
  text.length > max ? `${text.slice(0, max)}…` : text

const deriveExplanation = (stage: ActivityStage): string | null => {
  const outputs = (stage.outputs ?? {}) as Record<string, unknown>
  const inputs = (stage.inputs ?? {}) as Record<string, unknown>
  const metrics = stage.metrics ?? {}

  switch (stage.kind) {
    case 'routing': {
      const intent = outputs.responseIntent as string | undefined
      if (intent === 'retrieval') return 'Classified as a knowledge question — routing to document search.'
      if (intent === 'social_only') return 'Classified as conversational — replying directly.'
      if (intent === 'assistant_identity') return 'Classified as a question about the assistant itself.'
      return outputs.retrievalInvoked ? 'Routed to the retrieval pipeline.' : 'Responding without retrieval.'
    }
    case 'context': {
      const count = metrics.selectedHistoryCount ?? (outputs.selectedHistoryCount as number | undefined)
      const truncated = outputs.historyTruncated as boolean | undefined
      if (typeof count === 'number') {
        return `Selected ${count} conversation message${count === 1 ? '' : 's'} as context${truncated ? ' (truncated to fit)' : ''}.`
      }
      return 'Gathered conversation history for context.'
    }
    case 'query_interpretation': {
      const effective = outputs.effectiveQuery as string | undefined
      const original = inputs.originalQuery as string | undefined
      const rewritten = outputs.rewriteRan as boolean | undefined
      if (rewritten && effective && original && effective !== original) {
        return `Rewrote the query for better search: "${truncateText(effective, 80)}"`
      }
      return effective ? `Searching for: "${truncateText(effective, 80)}"` : 'Analyzed the user query.'
    }
    case 'trigger_analysis': {
      const matchCount = metrics.matchCount
      const considered = metrics.consideredRuleCount
      if (typeof matchCount === 'number' && typeof considered === 'number') {
        return matchCount === 0
          ? `Checked ${considered} trigger rule${considered === 1 ? '' : 's'} — none matched.`
          : `${matchCount} of ${considered} trigger rule${considered === 1 ? '' : 's'} matched.`
      }
      if (stage.status === 'skipped') return 'Trigger matching was skipped.'
      return null
    }
    case 'shape_selection': {
      const shapeName = (outputs.shapeName as string | undefined)?.replaceAll('_', ' ')
      return shapeName ? `Using "${shapeName}" answer strategy.` : null
    }
    case 'semantic_original':
    case 'semantic_rewritten': {
      const query = inputs.query as string | undefined
      const count = metrics.candidateCount
      if (query && typeof count === 'number') {
        return `Searched by meaning for "${truncateText(query, 60)}" — found ${count} passage${count === 1 ? '' : 's'}.`
      }
      return typeof count === 'number' ? `Found ${count} passage${count === 1 ? '' : 's'} via semantic search.` : null
    }
    case 'lexical': {
      const query = (inputs.query as string | undefined) ?? ((stage.settings ?? {}) as Record<string, unknown>).query as string | undefined
      const count = metrics.candidateCount
      if (query && typeof count === 'number') {
        return `Searched by keywords for "${truncateText(query, 60)}" — found ${count} passage${count === 1 ? '' : 's'}.`
      }
      return typeof count === 'number' ? `Found ${count} passage${count === 1 ? '' : 's'} via keyword search.` : null
    }
    case 'candidate_preparation': {
      const merged = metrics.mergedCount
      const scored = metrics.scoredCount
      if (typeof merged === 'number' && typeof scored === 'number') {
        return `Merged results from all search paths into ${merged} passages, ${scored} after scoring.`
      }
      return typeof merged === 'number' ? `Combined into ${merged} candidate passages.` : null
    }
    case 'context_selection': {
      const final = metrics.finalContextCount
      const rerankEnabled = ((stage.settings ?? {}) as Record<string, unknown>).rerankEnabled as boolean | undefined
      if (typeof final === 'number') {
        return `${rerankEnabled ? 'Reranked and selected' : 'Selected'} the top ${final} passage${final === 1 ? '' : 's'} for the answer.`
      }
      return null
    }
    case 'prompt_assembly': {
      const citations = metrics.citationCount
      return typeof citations === 'number'
        ? `Built the prompt with ${citations} citation${citations === 1 ? '' : 's'}.`
        : 'Assembled the prompt for answer generation.'
    }
    case 'diagnostics':
      return outputs.fallbackApplied
        ? 'Quality check detected issues — fallback behavior was applied.'
        : 'Quality check passed — no fallback needed.'
    case 'answer_outcome': {
      const outcome = (outputs.outcome as string | undefined)?.replaceAll('_', ' ')
      return outcome ? `Outcome: ${outcome}.` : null
    }
    case 'generation': {
      const model = inputs.model as string | undefined
      const latency = metrics.latencyMs
      if (model) return `Generated using ${model}${typeof latency === 'number' ? ` in ${latency}ms` : ''}.`
      return typeof latency === 'number' ? `Generated in ${latency}ms.` : null
    }
    case 'availability_check': {
      if (outputs.configured === true) return 'The workspace is configured to create human follow-up requests.'
      if (outputs.configured === false) return 'The contact request workflow is not configured yet.'
      return 'Checked whether the contact request workflow can run.'
    }
    case 'intake_collect': {
      const missing = asStringList(outputs.missing)
      const invalid = asStringList(outputs.invalid)
      if (invalid.length) return `Some details need correction: ${joinHumanList(invalid)}.`
      if (missing.length) return `The assistant still needs ${joinHumanList(missing)} before it can queue the request.`
      return 'Collected the details needed for the contact request.'
    }
    case 'trigger_evaluation': {
      const reason = asString(outputs.triggerReason)
      if (reason) return reason
      return 'Detected that the user wants human follow-up.'
    }
    case 'draft_build':
      return 'Prepared the contact request before saving it.'
    case 'request_submit':
      return 'Saved the contact request and queued it for follow-up.'
    case 'delivery_dispatch': {
      const status = asString(outputs.status)?.replaceAll('_', ' ')
      if (stage.status === 'skipped') return stage.reason ?? 'Notification will be handled in the background.'
      return status ? `Notification status: ${status}.` : 'Updated the follow-up notification status.'
    }
    case 'audit_record':
      return 'Recorded this workflow in the audit log.'
    default:
      return stage.reason ?? null
  }
}

function SpecializedStageOverview({ stage }: { stage: ActivityStage }) {
  const inputs = asRecord(stage.inputs)
  const outputs = asRecord(stage.outputs)
  const metrics = asRecord(stage.metrics)
  const settings = asRecord(stage.settings)

  if (stage.kind === 'context') {
    return (
      <>
        <CollapsibleSection title="Context">
          <AppliedIndicator applied={stage.status === 'applied' || stage.status === 'fallback'} />
          <KeyValueList
            rows={[
              { label: 'History messages', value: inputs.historyMessageCount as number | undefined },
              { label: 'Selected history', value: outputs.selectedHistoryCount as number | undefined },
              { label: 'History truncated', value: outputs.historyTruncated as boolean | undefined },
              { label: 'Selection reason', value: outputs.selectionReason as string | undefined },
            ]}
          />
          <StringList values={asStringList(outputs.carryForwardLiterals)} />
        </CollapsibleSection>
        <CollapsibleSection title="Settings">
          <KeyValueList
            rows={[
              { label: 'Vector top K', value: settings.vectorTopK as number | undefined },
              { label: 'Similarity threshold', value: settings.similarityThreshold as number | undefined },
              { label: 'Rerank enabled', value: settings.rerankEnabled as boolean | undefined },
              { label: 'Rerank top K', value: settings.rerankTopK as number | undefined },
              { label: 'Rewrite enabled', value: settings.queryRewriteEnabled as boolean | undefined },
            ]}
          />
        </CollapsibleSection>
      </>
    )
  }

  if (stage.kind === 'query_interpretation') {
    return (
      <>
        <Section title="Interpretation">
          <KeyValueList
            rows={[
              { label: 'Original query', value: inputs.originalQuery as string | undefined },
              { label: 'Effective query', value: outputs.effectiveQuery as string | undefined },
              { label: 'Semantic query', value: outputs.semanticQuery as string | undefined },
              { label: 'Lexical query', value: outputs.lexicalQuery as string | undefined },
              { label: 'Response language policy', value: outputs.responseLanguagePolicy as string | undefined },
              { label: 'Fallback reason', value: stage.reason },
              { label: 'Rewrite eligible', value: outputs.rewriteEligible as boolean | undefined },
              { label: 'Rewrite ran', value: outputs.rewriteRan as boolean | undefined },
              { label: 'Continuity decision', value: outputs.continuityDecision as string | undefined },
              { label: 'Rewrite confidence', value: metrics.rewriteConfidence as number | undefined },
            ]}
          />
          <StringList values={asStringList(outputs.parsedConstraints)} />
        </Section>
        <RawBlock label="Retrieval subqueries" value={outputs.retrievalSubqueries} />
      </>
    )
  }

  if (stage.kind === 'trigger_analysis') {
    const consideredRules = Array.isArray(outputs.consideredRules) ? outputs.consideredRules : []
    const matchedRuleIds = asStringList(outputs.matchedRuleIds)
    const unmatchedRuleIds = asStringList(outputs.unmatchedRuleIds)
    const backoffDecision = asRecord(outputs.backoffDecision)

    return (
      <>
        <Section title="Trigger analysis">
          <KeyValueList
            rows={[
              { label: 'Query', value: inputs.query as string | undefined },
              { label: 'Considered rules', value: metrics.consideredRuleCount as number | undefined },
              { label: 'Matched rules', value: metrics.matchCount as number | undefined },
              { label: 'Failure reason', value: stage.reason },
            ]}
          />
        </Section>
        <Section title="Matched rule ids">
          <StringList values={matchedRuleIds} />
        </Section>
        <Section title="Unmatched rule ids">
          <StringList values={unmatchedRuleIds} />
        </Section>
        {consideredRules.length > 0 ? (
          <Section title="Considered rules">
            <div className="space-y-2">
              {consideredRules.map((rule, index) => {
                const item = asRecord(rule)
                const matchStrength = item.matchStrength
                return (
                  <div key={`${String(item.ruleId ?? index)}`} className="rounded-lg border border-border/70 bg-background/70 p-3">
                    <KeyValueList
                      rows={[
                        { label: 'Rule id', value: item.ruleId as string | undefined },
                        { label: 'Matched', value: item.matched as boolean | undefined },
                        {
                          label: 'Match strength',
                          value:
                            typeof matchStrength === 'number' ? `${(matchStrength * 100).toFixed(0)}%` : undefined,
                        },
                        { label: 'Instruction preview', value: item.triggerInstructionPreview as string | undefined },
                        { label: 'Reason', value: item.reason as string | undefined },
                      ]}
                    />
                  </div>
                )
              })}
            </div>
          </Section>
        ) : null}
        <RawBlock label="Backoff decision" value={backoffDecision} />
      </>
    )
  }

  if (stage.kind === 'shape_selection') {
    return (
      <Section title="Shape selection">
        <KeyValueList
          rows={[
            { label: 'Skill', value: outputs.skillName as string | undefined },
            { label: 'Shape', value: formatLabel(outputs.shapeName) },
            { label: 'Query shape', value: formatLabel(outputs.queryShape) },
            { label: 'Selection mode', value: formatLabel(outputs.selectionMode) },
            { label: 'Selection reason', value: stage.reason },
            {
              label: 'Selection confidence',
              value: typeof metrics.selectionConfidence === 'number' ? metrics.selectionConfidence : undefined,
            },
          ]}
        />
        <RawBlock label="Resolved steps" value={outputs.resolvedSteps} />
      </Section>
    )
  }

  if (stage.kind === 'semantic_original' || stage.kind === 'semantic_rewritten' || stage.kind === 'lexical') {
    return (
      <>
        <Section title="Retrieval">
          <KeyValueList
            rows={[
              { label: 'Query', value: (inputs.query as string | undefined) ?? (settings.query as string | undefined) },
              { label: 'Subquery', value: settings.subqueryLabel as string | undefined },
              { label: 'Response language policy', value: settings.responseLanguagePolicy as string | undefined },
              { label: 'Top K', value: settings.topK as number | undefined },
              { label: 'Threshold', value: settings.similarityThreshold as number | undefined },
              { label: 'Candidate count', value: outputs.candidateCount as number | undefined },
            ]}
          />
        </Section>
        <ChunkList label="Retrieved chunks" chunks={asChunkList(outputs.chunks)} />
      </>
    )
  }

  if (stage.kind === 'candidate_preparation') {
    return (
      <>
        <Section title="Candidate preparation">
          <KeyValueList
            rows={[
              { label: 'Normalized', value: metrics.normalizedCount as number | undefined },
              { label: 'Merged', value: metrics.mergedCount as number | undefined },
              { label: 'Scored', value: metrics.scoredCount as number | undefined },
            ]}
          />
          <StringList values={asStringList(outputs.appliedConstraintSummaries)} />
        </Section>
        <ChunkList label="Top prepared candidates" chunks={asChunkList(outputs.topCandidates)} />
      </>
    )
  }

  if (stage.kind === 'context_selection') {
    return (
      <>
        <Section title="Context selection">
          <KeyValueList
            rows={[
              { label: 'Rerank enabled', value: settings.rerankEnabled as boolean | undefined },
              { label: 'Rerank top K', value: settings.rerankTopK as number | undefined },
              { label: 'Reranked count', value: metrics.rerankedCount as number | undefined },
              { label: 'Final context count', value: metrics.finalContextCount as number | undefined },
            ]}
          />
        </Section>
        <ChunkList label="Final context" chunks={asChunkList(outputs.finalContexts)} />
      </>
    )
  }

  if (stage.kind === 'prompt_assembly') {
    return (
      <>
        <Section title="Prompt assembly">
          <KeyValueList
            rows={[
              { label: 'Citations enabled', value: settings.citationDisplayEnabled as boolean | undefined },
              { label: 'Prompt context count', value: metrics.promptContextCount as number | undefined },
              { label: 'Citation count', value: metrics.citationCount as number | undefined },
            ]}
          />
        </Section>
        <ChunkList label="Citations" chunks={asChunkList(outputs.citations)} />
      </>
    )
  }

  if (stage.kind === 'diagnostics') {
    return (
      <>
        {outputs.fallbackApplied ? (
          <div className="rounded-lg border border-amber-500/30 bg-amber-500/10 p-3">
            <p className="text-sm font-medium text-amber-700 dark:text-amber-300">Fallback was applied</p>
            {outputs.continuityDecision ? (
              <p className="mt-1 text-xs text-muted-foreground">
                Continuity: {String(outputs.continuityDecision).replaceAll('_', ' ')}
              </p>
            ) : null}
          </div>
        ) : null}
        <CollapsibleSection title="Candidate counts">
          <KeyValueList
            rows={[
              { label: 'Semantic', value: metrics.semanticCandidateCount as number | undefined },
              { label: 'Lexical', value: metrics.lexicalCandidateCount as number | undefined },
              { label: 'Merged', value: metrics.mergedCandidateCount as number | undefined },
              { label: 'Final', value: metrics.finalContextCount as number | undefined },
            ]}
          />
        </CollapsibleSection>
      </>
    )
  }

  if (stage.kind === 'answer_outcome') {
    return (
      <>
        <Section title="Answer outcome">
          <KeyValueList
            rows={[
              { label: 'Outcome', value: outputs.outcome as string | undefined },
              { label: 'Validation ran', value: outputs.validationRan as boolean | undefined },
              { label: 'Answer modified', value: outputs.answerModified as boolean | undefined },
              { label: 'Supported segments', value: outputs.supportedSegmentCount as number | undefined },
              { label: 'Unsupported segments', value: outputs.unsupportedSegmentCount as number | undefined },
              {
                label: 'Substantive unsupported segments',
                value: outputs.substantiveUnsupportedSegmentCount as number | undefined,
              },
              { label: 'Hidden support used', value: outputs.hiddenSupportUsed as boolean | undefined },
            ]}
          />
        </Section>
        <Section title="Hidden support kinds">
          <StringList values={asStringList(outputs.hiddenSupportKindsUsed)} />
        </Section>
        <RawBlock label="Outputs" value={stage.outputs} />
      </>
    )
  }

  return (
    <>
      <RawBlock label="Metrics" value={stage.metrics} />
      <RawBlock label="Settings" value={stage.settings} />
      <RawBlock label="Inputs" value={stage.inputs} />
      <RawBlock label="Outputs" value={stage.outputs} />
    </>
  )
}

function RoutingStageOverview({ stage }: { stage: ActivityStage }) {
  const inputs = asRecord(stage.inputs)
  const outputs = asRecord(stage.outputs)
  const metrics = asRecord(stage.metrics)
  const retrievalInvoked = asBoolean(outputs.retrievalInvoked)

  return (
    <>
      <Section title="Routing">
        <KeyValueList
          rows={[
            { label: 'Surface', value: formatLabel(inputs.surface) },
            { label: 'Intent', value: formatIntent(outputs.responseIntent) },
            { label: 'Activity route', value: retrievalInvoked === true ? 'Workspace document answer' : retrievalInvoked === false ? 'Direct assistant reply' : undefined },
            { label: 'Route reason', value: stage.reason },
            { label: 'Latency', value: metrics.latencyMs as number | undefined },
          ]}
        />
      </Section>
    </>
  )
}

function GenerationStageOverview({ stage }: { stage: ActivityStage }) {
  const inputs = asRecord(stage.inputs)
  const outputs = asRecord(stage.outputs)
  const metrics = asRecord(stage.metrics)

  return (
    <Section title="Generation">
      <KeyValueList
        rows={[
          { label: 'Provider', value: inputs.provider as string | undefined },
          { label: 'Model', value: inputs.model as string | undefined },
          { label: 'Latency', value: metrics.latencyMs as number | undefined },
          { label: 'Input tokens', value: metrics.inputTokens as number | undefined },
          { label: 'Output tokens', value: metrics.outputTokens as number | undefined },
          { label: 'Output format', value: outputs.outputFormat as string | undefined },
          { label: 'Output length', value: outputs.outputLength as number | undefined },
        ]}
      />
    </Section>
  )
}

function ContactStageOverview({ stage }: { stage: ActivityStage }) {
  const outputs = asRecord(stage.outputs)
  const inputs = asRecord(stage.inputs)
  const configured = asBoolean(outputs.configured)
  const missing = asStringList(outputs.missing)
  const invalid = asStringList(outputs.invalid)
  const collected = asStringList(outputs.collected)

  if (stage.kind === 'availability_check') {
    return (
      <Section title="Readiness">
        <KeyValueList
          rows={[
            { label: 'Contact workflow', value: configured === true ? 'Ready' : configured === false ? 'Not configured' : undefined },
            { label: 'Result', value: configured === true ? 'The assistant can queue a request.' : configured === false ? 'Complete contact settings before requests can be queued.' : undefined },
          ]}
        />
      </Section>
    )
  }

  if (stage.kind === 'intake_collect') {
    return (
      <Section title="Details">
        <KeyValueList
          rows={[
            { label: 'Collected details', value: collected.length ? joinHumanList(collected) : undefined },
            { label: 'Still needed', value: missing.length ? joinHumanList(missing) : 'Nothing else needed' },
            { label: 'Needs correction', value: invalid.length ? joinHumanList(invalid) : undefined },
          ]}
        />
      </Section>
    )
  }

  if (stage.kind === 'trigger_evaluation') {
    return (
      <Section title="Why this ran">
        <KeyValueList
          rows={[
            { label: 'Trigger source', value: formatLabel(outputs.triggerSource) },
            { label: 'Reason', value: asString(outputs.triggerReason) ?? stage.reason },
          ]}
        />
      </Section>
    )
  }

  if (stage.kind === 'request_submit') {
    return (
      <Section title="Queued request">
        <KeyValueList
          rows={[
            { label: 'Request', value: outputs.requestId ? 'Queued' : undefined },
            { label: 'Conversation', value: asString(outputs.conversationId) },
            { label: 'Assistant message', value: asString(outputs.assistantMessageId) },
            { label: 'Source channel', value: formatLabel(outputs.sourceChannel) },
          ]}
        />
      </Section>
    )
  }

  if (stage.kind === 'delivery_dispatch') {
    return (
      <Section title="Notification">
        <KeyValueList
          rows={[
            { label: 'State', value: formatLabel(outputs.status) ?? formatLabel(stage.status) },
            { label: 'Reason', value: stage.reason },
          ]}
        />
      </Section>
    )
  }

  if (stage.kind === 'audit_record') {
    return (
      <Section title="Audit">
        <KeyValueList
          rows={[
            { label: 'Recorded event', value: formatLabel(outputs.eventType) },
            { label: 'Reason', value: stage.reason },
          ]}
        />
      </Section>
    )
  }

  return (
    <Section title={stage.label}>
      <KeyValueList
        rows={[
          { label: 'Status', value: formatLabel(stage.status) },
          { label: 'Reason', value: stage.reason },
          { label: 'Input', value: asString(inputs.query) },
        ]}
      />
    </Section>
  )
}

function GenericStageOverview({ stage }: { stage: ActivityStage }) {
  return (
    <>
      <RawBlock label="Metrics" value={stage.metrics} />
      <RawBlock label="Settings" value={stage.settings} />
      <RawBlock label="Inputs" value={stage.inputs} />
      <RawBlock label="Outputs" value={stage.outputs} />
    </>
  )
}

type StageRenderer = (props: { stage: ActivityStage }) => ReactNode

const STAGE_RENDERERS: Record<string, StageRenderer> = {
  context: SpecializedStageOverview,
  query_interpretation: SpecializedStageOverview,
  trigger_analysis: SpecializedStageOverview,
  shape_selection: SpecializedStageOverview,
  semantic_original: SpecializedStageOverview,
  semantic_rewritten: SpecializedStageOverview,
  lexical: SpecializedStageOverview,
  candidate_preparation: SpecializedStageOverview,
  context_selection: SpecializedStageOverview,
  prompt_assembly: SpecializedStageOverview,
  diagnostics: SpecializedStageOverview,
  answer_outcome: SpecializedStageOverview,
  routing: RoutingStageOverview,
  generation: GenerationStageOverview,
  availability_check: ContactStageOverview,
  trigger_evaluation: ContactStageOverview,
  draft_build: ContactStageOverview,
  request_submit: ContactStageOverview,
  delivery_dispatch: ContactStageOverview,
  audit_record: ContactStageOverview,
}

function extractFinalPassages(stage: ActivityStage, trace?: ActivityTrace): ChunkRef[] {
  if (stage.kind !== 'diagnostics' && stage.kind !== 'answer_outcome') return []
  if (!trace) return []

  const stageOutputs = (s: ActivityStage) => (s.outputs ?? {}) as Record<string, unknown>

  const ownChunks = asChunkList(stageOutputs(stage).finalContexts)
  if (ownChunks.length) return ownChunks

  const selectionStage = trace.stages.find((s) => s.kind === 'context_selection')
  if (selectionStage) {
    const chunks = asChunkList(stageOutputs(selectionStage).finalContexts)
    if (chunks.length) return chunks
  }

  const promptStage = trace.stages.find((s) => s.kind === 'prompt_assembly')
  if (promptStage) {
    const chunks = asChunkList(stageOutputs(promptStage).citations)
    if (chunks.length) return chunks
  }

  const prepStage = trace.stages.find((s) => s.kind === 'candidate_preparation')
  if (prepStage) {
    const chunks = asChunkList(stageOutputs(prepStage).topCandidates)
    if (chunks.length) return chunks
  }

  const searchChunks: ChunkRef[] = []
  for (const s of trace.stages) {
    if (s.kind === 'semantic_original' || s.kind === 'semantic_rewritten' || s.kind === 'lexical') {
      searchChunks.push(...asChunkList(stageOutputs(s).chunks))
    }
  }
  return searchChunks
}

function StageOverview({ stage, trace }: { stage: ActivityStage; trace?: ActivityTrace }) {
  const Renderer = STAGE_RENDERERS[stage.kind] ?? GenericStageOverview
  const explanation = deriveExplanation(stage)
  const passages = extractFinalPassages(stage, trace)

  return (
    <>
      <section className="rounded-lg border border-border/50 bg-muted/20 p-3">
        <p className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">Selected step</p>
        <div className="mt-1 flex flex-wrap items-center gap-2">
          <p className="text-base font-medium text-foreground">{stage.label}</p>
          <span className="rounded-full bg-background/70 px-2 py-0.5 text-xs text-muted-foreground">
            {formatLabel(stage.status) ?? stage.status}
          </span>
        </div>
        {explanation ? (
          <p className="mt-2 text-sm leading-6 text-muted-foreground">{explanation}</p>
        ) : null}
          {typeof stage.durationMs === 'number' ? (
            <p className="mt-1 text-xs text-muted-foreground">{stage.durationMs}ms</p>
          ) : null}
      </section>
      {passages.length > 0 ? (
        <ChunkList label={`Selected passages (${passages.length})`} chunks={passages} />
      ) : null}
      <Renderer stage={stage} />
    </>
  )
}

export function ActivityTraceDetail({
  activityTrace,
  selectedStageId,
}: {
  activityTrace?: ActivityTrace
  selectedStageId?: string
}) {
  if (!activityTrace) {
    return (
      <div className="rounded-lg border border-dashed border-border p-3 text-xs text-muted-foreground">
        Detailed activity trace unavailable for this answer.
      </div>
    )
  }

  const selectedStage =
    (selectedStageId ? getSelectedStage(activityTrace, selectedStageId) : undefined) ?? activityTrace.stages[0]

  if (!selectedStage) {
    return (
      <div className="rounded-lg border border-dashed border-border p-3 text-xs text-muted-foreground">
        This trace did not record any stages.
      </div>
    )
  }

  return (
    <div className="space-y-4 select-text">
      <StageOverview stage={selectedStage} trace={activityTrace} />

      <details className="group rounded-lg border border-border/70 bg-background/60 p-3 text-xs text-muted-foreground">
        <summary className="flex cursor-pointer list-none items-center justify-between gap-3 font-medium text-foreground">
          <span>Raw stage data</span>
          <ChevronDown className="h-4 w-4 text-muted-foreground transition-transform group-open:rotate-180" />
        </summary>
        <div className="mt-3 space-y-3">
          <RawBlock label="Metrics" value={selectedStage.metrics} />
          <RawBlock label="Settings" value={selectedStage.settings} />
          <RawBlock label="Inputs" value={selectedStage.inputs} />
          <RawBlock label="Outputs" value={selectedStage.outputs} />
        </div>
      </details>

      <details className="group rounded-lg border border-border/70 bg-background/60 p-3 text-xs text-muted-foreground">
        <summary className="flex cursor-pointer list-none items-center justify-between gap-3 font-medium text-foreground">
          <span>Raw trace</span>
          <ChevronDown className="h-4 w-4 text-muted-foreground transition-transform group-open:rotate-180" />
        </summary>
        <pre className="mt-3 overflow-x-auto rounded-lg border border-border/70 bg-background/70 p-3 text-[11px]">
          {formatJson(activityTrace)}
        </pre>
      </details>
    </div>
  )
}
