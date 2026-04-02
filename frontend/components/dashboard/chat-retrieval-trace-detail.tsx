'use client'

import type { ReactNode } from 'react'
import { ChevronDown, CircleCheck, CircleX } from 'lucide-react'

import type { RetrievalTrace, RetrievalTraceStage } from '@/lib/api'

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

const getSelectedStage = (trace: RetrievalTrace, selectedStageId: string): RetrievalTraceStage | undefined =>
  trace.stages.find((stage) => stage.stageId === selectedStageId)

const asRecord = (value: unknown): Record<string, unknown> =>
  value && typeof value === 'object' ? (value as Record<string, unknown>) : {}

const asStringList = (value: unknown): string[] =>
  Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === 'string') : []

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

function StageOverview({ stage }: { stage: RetrievalTraceStage }) {
  const inputs = asRecord(stage.inputs)
  const outputs = asRecord(stage.outputs)
  const metrics = asRecord(stage.metrics)
  const settings = asRecord(stage.settings)

  if (stage.stageId === 'context') {
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

  if (stage.stageId === 'interpretation') {
    return (
      <>
        <Section title="Interpretation">
          <KeyValueList
            rows={[
              { label: 'Original query', value: inputs.originalQuery as string | undefined },
              { label: 'Effective query', value: outputs.effectiveQuery as string | undefined },
              { label: 'Semantic query', value: outputs.semanticQuery as string | undefined },
              { label: 'Lexical query', value: outputs.lexicalQuery as string | undefined },
              { label: 'Fallback reason', value: stage.reason },
              { label: 'Rewrite eligible', value: outputs.rewriteEligible as boolean | undefined },
              { label: 'Rewrite ran', value: outputs.rewriteRan as boolean | undefined },
              { label: 'Continuity decision', value: outputs.continuityDecision as string | undefined },
              { label: 'Rewrite confidence', value: metrics.rewriteConfidence as number | undefined },
            ]}
          />
          <StringList values={asStringList(outputs.parsedConstraints)} />
        </Section>
      </>
    )
  }

  if (stage.stageId === 'semantic_original' || stage.stageId === 'semantic_rewritten' || stage.stageId === 'lexical') {
    return (
      <>
        <Section title="Retrieval">
          <KeyValueList
            rows={[
              { label: 'Query', value: (inputs.query as string | undefined) ?? (settings.query as string | undefined) },
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

  if (stage.stageId === 'preparation') {
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

  if (stage.stageId === 'selection') {
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

  if (stage.stageId === 'prompt') {
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

  if (stage.stageId === 'diagnostics') {
    return (
      <Section title="Diagnostics">
        <KeyValueList
          rows={[
            { label: 'Fallback applied', value: outputs.fallbackApplied as boolean | undefined },
            { label: 'Continuity decision', value: outputs.continuityDecision as string | undefined },
            { label: 'Semantic candidates', value: metrics.semanticCandidateCount as number | undefined },
            { label: 'Lexical candidates', value: metrics.lexicalCandidateCount as number | undefined },
            { label: 'Merged candidates', value: metrics.mergedCandidateCount as number | undefined },
            { label: 'Final contexts', value: metrics.finalContextCount as number | undefined },
          ]}
        />
      </Section>
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

export function ChatRetrievalTraceDetail({
  retrievalTrace,
  selectedStageId,
}: {
  retrievalTrace?: RetrievalTrace
  selectedStageId?: string
}) {
  if (!retrievalTrace) {
    return (
      <div className="rounded-lg border border-dashed border-border p-3 text-xs text-muted-foreground">
        Detailed retrieval trace unavailable for this answer.
      </div>
    )
  }

  const selectedStage =
    (selectedStageId ? getSelectedStage(retrievalTrace, selectedStageId) : undefined) ?? retrievalTrace.stages[0]

  if (!selectedStage) {
    return (
      <div className="rounded-lg border border-dashed border-border p-3 text-xs text-muted-foreground">
        This trace did not record any stages.
      </div>
    )
  }

  return (
    <div className="space-y-4 select-text">
      <StageOverview stage={selectedStage} />

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
          {formatJson(retrievalTrace)}
        </pre>
      </details>
    </div>
  )
}
