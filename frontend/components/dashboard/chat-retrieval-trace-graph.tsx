'use client'

import { PipelineConnector } from '@/components/dashboard/settings/settings-flow'
import type { RetrievalTrace, RetrievalTraceStage } from '@/lib/api'

const STATUS_STYLES: Record<RetrievalTraceStage['status'], string> = {
  applied: 'border-emerald-500/30 bg-emerald-500/10',
  skipped: 'border-slate-500/30 bg-slate-500/10',
  fallback: 'border-amber-500/30 bg-amber-500/10',
  rejected: 'border-rose-500/30 bg-rose-500/10',
  unavailable: 'border-zinc-500/30 bg-zinc-500/10',
  failed: 'border-red-500/30 bg-red-500/10',
}

const getStage = (trace: RetrievalTrace, stageId: string) =>
  trace.stages.find((stage) => stage.stageId === stageId)

const getSequentialStages = (trace: RetrievalTrace) =>
  [
    'context',
    'interpretation',
    'trigger_analysis',
    'shape_selection',
    'preparation',
    'selection',
    'prompt',
    'diagnostics',
    'answer',
  ]
    .map((stageId) => getStage(trace, stageId))
    .filter((stage): stage is RetrievalTraceStage => Boolean(stage))

const getBranchStages = (trace: RetrievalTrace) =>
  trace.stages.filter((stage) =>
    stage.kind === 'semantic_original' || stage.kind === 'semantic_rewritten' || stage.kind === 'lexical',
  )

const chunkCount = (stage: RetrievalTraceStage) => {
  if (typeof stage.metrics?.candidateCount === 'number') {
    return stage.metrics.candidateCount
  }
  if (typeof stage.metrics?.finalContextCount === 'number') {
    return stage.metrics.finalContextCount
  }
  if (typeof stage.metrics?.mergedCount === 'number') {
    return stage.metrics.mergedCount
  }
  if (typeof stage.metrics?.promptContextCount === 'number') {
    return stage.metrics.promptContextCount
  }
  return null
}

const summaryLine = (stage: RetrievalTraceStage) => {
  if (stage.stageId === 'context') {
    const count = stage.metrics?.selectedHistoryCount
    return typeof count === 'number' ? `${count} history messages` : 'Conversation context'
  }

  if (stage.stageId === 'interpretation') {
    const constraintCount = stage.metrics?.parsedConstraintCount
    const subqueries = Array.isArray((stage.outputs as { retrievalSubqueries?: unknown[] } | undefined)?.retrievalSubqueries)
      ? ((stage.outputs as { retrievalSubqueries?: unknown[] }).retrievalSubqueries?.length ?? 0)
      : 0
    if (subqueries > 1) {
      return `${subqueries} retrieval branches`
    }
    return typeof constraintCount === 'number' ? `${constraintCount} parsed constraints` : 'Query analysis'
  }

  if (stage.stageId === 'trigger_analysis') {
    const matchCount = stage.metrics?.matchCount
    const consideredRuleCount = stage.metrics?.consideredRuleCount
    if (typeof matchCount === 'number') {
      return `${matchCount} matched rule${matchCount === 1 ? '' : 's'}`
    }
    return typeof consideredRuleCount === 'number'
      ? `${consideredRuleCount} considered rule${consideredRuleCount === 1 ? '' : 's'}`
      : 'Trigger matching'
  }

  if (stage.stageId === 'shape_selection') {
    const outputs = stage.outputs as { shapeName?: string; queryShape?: string } | undefined
    const shapeName = outputs?.shapeName?.replaceAll('_', ' ')
    const queryShape = outputs?.queryShape?.replaceAll('_', ' ')
    if (shapeName && queryShape && shapeName !== queryShape) {
      return `${shapeName} • ${queryShape}`
    }
    return shapeName ?? queryShape ?? 'Retrieval shape'
  }

  if (stage.stageId === 'prompt') {
    const citationCount = stage.metrics?.citationCount
    return typeof citationCount === 'number' ? `${citationCount} citations` : 'Prompt built'
  }

  if (stage.stageId === 'diagnostics') {
    return stage.outputs?.fallbackApplied ? 'Fallback applied' : 'Fallback not applied'
  }

  if (stage.stageId === 'answer') {
    const outputs = stage.outputs as { outcome?: string; hiddenSupportUsed?: boolean } | undefined
    const outcome = String(outputs?.outcome ?? 'Answer outcome').replaceAll('_', ' ')
    return outputs?.hiddenSupportUsed ? `${outcome} • hidden support` : outcome
  }

  const count = chunkCount(stage)
  if (typeof count === 'number') {
    return `${count} chunk${count === 1 ? '' : 's'}`
  }

  return stage.reason ?? stage.kind
}

function StageNode({
  stage,
  isSelected,
  onSelect,
}: {
  stage: RetrievalTraceStage
  isSelected: boolean
  onSelect: (stageId: string) => void
}) {
  return (
    <button
      type="button"
      onClick={() => onSelect(stage.stageId)}
      className={`w-full rounded-xl border p-3 text-left transition hover:border-primary/60 ${
        isSelected ? 'border-primary bg-primary/10' : STATUS_STYLES[stage.status]
      }`}
    >
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="text-sm font-medium text-foreground">{stage.label}</p>
          <p className="mt-1 text-xs text-muted-foreground">{summaryLine(stage)}</p>
        </div>
        <span className="rounded-full border border-current/20 px-2 py-0.5 text-[10px] uppercase tracking-wide text-muted-foreground">
          {stage.status}
        </span>
      </div>
      <div className="mt-3 flex items-center justify-between text-[11px] text-muted-foreground">
        <span>{stage.kind}</span>
        {typeof stage.durationMs === 'number' ? <span>{stage.durationMs}ms</span> : null}
      </div>
    </button>
  )
}

export function ChatRetrievalTraceGraph({
  retrievalTrace,
  selectedStageId,
  onSelectStage,
}: {
  retrievalTrace: RetrievalTrace
  selectedStageId: string
  onSelectStage: (stageId: string) => void
}) {
  const sequentialStages = getSequentialStages(retrievalTrace)
  const branchStages = getBranchStages(retrievalTrace)
  const preparationIndex = sequentialStages.findIndex((stage) => stage.stageId === 'preparation')
  const beforePreparation = preparationIndex >= 0 ? sequentialStages.slice(0, preparationIndex) : sequentialStages
  const afterPreparation = preparationIndex >= 0 ? sequentialStages.slice(preparationIndex) : []

  return (
    <div className="space-y-2">
      {beforePreparation.map((stage, index) => (
        <div key={stage.stageId} className="space-y-2">
          <StageNode stage={stage} isSelected={stage.stageId === selectedStageId} onSelect={onSelectStage} />
          {index < beforePreparation.length - 1 || branchStages.length > 0 ? <PipelineConnector /> : null}
        </div>
      ))}

      {branchStages.length > 0 ? (
        <div className="space-y-2">
          <div className="rounded-2xl border border-border/70 bg-background/40 p-3">
            <p className="mb-3 text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
              Retrieval branches
            </p>
            <div className="space-y-3">
              {branchStages.map((stage) => (
                <StageNode
                  key={stage.stageId}
                  stage={stage}
                  isSelected={stage.stageId === selectedStageId}
                  onSelect={onSelectStage}
                />
              ))}
            </div>
          </div>
          <PipelineConnector />
        </div>
      ) : null}

      {afterPreparation.map((stage, index) => (
        <div key={stage.stageId} className="space-y-2">
          <StageNode stage={stage} isSelected={stage.stageId === selectedStageId} onSelect={onSelectStage} />
          {index < afterPreparation.length - 1 ? <PipelineConnector /> : null}
        </div>
      ))}
    </div>
  )
}
