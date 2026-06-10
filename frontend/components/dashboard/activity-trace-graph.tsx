'use client'

import type { ActivityTrace, ActivityStage } from '@/lib/api'

const STATUS_DOT: Record<ActivityStage['status'], string> = {
  applied: 'bg-emerald-500',
  skipped: 'bg-slate-400',
  fallback: 'bg-amber-500',
  rejected: 'bg-rose-500',
  unavailable: 'bg-zinc-400',
  failed: 'bg-red-500',
}

const DISPLAY_LABELS: Record<string, string> = {
  routing: 'Route',
  context: 'Context',
  query_interpretation: 'Interpret query',
  trigger_analysis: 'Triggers',
  shape_selection: 'Strategy',
  semantic_original: 'Semantic search',
  semantic_rewritten: 'Semantic search',
  lexical: 'Keyword search',
  candidate_preparation: 'Merge',
  context_selection: 'Rank',
  prompt_assembly: 'Prompt',
  diagnostics: 'Check',
  answer_outcome: 'Answer',
  generation: 'Generate',
  availability_check: 'Contact settings',
  intake_collect: 'Collect details',
  trigger_evaluation: 'Follow-up intent',
  draft_build: 'Prepare request',
  request_submit: 'Queue request',
  delivery_dispatch: 'Notify team',
  audit_record: 'Audit log',
  skill_execute: 'Run workflow',
}

type LayoutSection =
  | { kind: 'stage'; stage: ActivityStage }
  | { kind: 'parallel'; label: string; stages: ActivityStage[] }
type ActivityLink = ActivityTrace['links'][number]

type RenderItem =
  | { type: 'stage'; stage: ActivityStage; phaseBreak: boolean }
  | { type: 'parallel'; label: string; stages: ActivityStage[] }

const getPhase = (kind: string): string | null => {
  switch (kind) {
    case 'routing':
    case 'context':
    case 'query_interpretation':
    case 'trigger_analysis':
    case 'shape_selection':
    case 'availability_check':
    case 'trigger_evaluation':
      return 'understand'
    case 'candidate_preparation':
    case 'context_selection':
    case 'prompt_assembly':
    case 'intake_collect':
    case 'draft_build':
    case 'request_submit':
    case 'skill_execute':
      return 'prepare'
    case 'diagnostics':
    case 'answer_outcome':
    case 'generation':
    case 'delivery_dispatch':
    case 'audit_record':
      return 'result'
    default:
      return null
  }
}

const deriveLayout = (trace: ActivityTrace): LayoutSection[] => {
  const stagesById = new Map(trace.stages.map((stage) => [stage.stageId, stage]))
  const incoming = new Set(trace.links.map((link) => link.toStageId))
  const outgoing = new Map<string, ActivityLink[]>()
  for (const link of trace.links) {
    outgoing.set(link.fromStageId, [...(outgoing.get(link.fromStageId) ?? []), link])
  }

  const sections: LayoutSection[] = []
  const visited = new Set<string>()
  let current: ActivityStage | undefined = trace.stages.find((stage) => !incoming.has(stage.stageId)) ?? trace.stages[0]

  while (current && !visited.has(current.stageId)) {
    sections.push({ kind: 'stage', stage: current })
    visited.add(current.stageId)

    const links: ActivityLink[] = outgoing.get(current.stageId) ?? []
    const branchLinks: ActivityLink[] = links.filter((link: ActivityLink) => link.kind === 'branch')
    if (branchLinks.length > 0) {
      const branchStages: ActivityStage[] = branchLinks
        .map((link: ActivityLink) => stagesById.get(link.toStageId))
        .filter((stage): stage is ActivityStage => Boolean(stage))
      branchStages.forEach((stage: ActivityStage) => visited.add(stage.stageId))
      sections.push({ kind: 'parallel', label: 'Parallel', stages: branchStages })

      const convergeTarget: ActivityLink | undefined = branchStages
        .flatMap((stage: ActivityStage) => outgoing.get(stage.stageId) ?? [])
        .find((link: ActivityLink) => link.kind === 'converge')
      current = convergeTarget ? stagesById.get(convergeTarget.toStageId) : undefined
      continue
    }

    const sequenceLink = links.find((link: ActivityLink) => link.kind === 'sequence')
    current = sequenceLink ? stagesById.get(sequenceLink.toStageId) : undefined
  }

  for (const stage of trace.stages) {
    if (!visited.has(stage.stageId)) {
      sections.push({ kind: 'stage', stage })
    }
  }

  return sections
}

const buildRenderItems = (sections: LayoutSection[]): RenderItem[] => {
  const items: RenderItem[] = []
  let lastPhase: string | null = null

  for (const section of sections) {
    if (section.kind === 'parallel') {
      const allSearch = section.stages.every(
        (s) => s.kind === 'semantic_original' || s.kind === 'semantic_rewritten' || s.kind === 'lexical',
      )
      items.push({
        type: 'parallel',
        label: allSearch ? 'Search paths' : section.label,
        stages: section.stages,
      })
      lastPhase = null
      continue
    }

    const phase = getPhase(section.stage.kind)
    const phaseBreak = phase !== null && phase !== lastPhase && items.length > 0
    if (phase) lastPhase = phase

    items.push({ type: 'stage', stage: section.stage, phaseBreak })
  }

  return items
}

const displayLabel = (stage: ActivityStage): string => DISPLAY_LABELS[stage.kind] ?? stage.label

const chunkCount = (stage: ActivityStage) => {
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

const summaryLine = (stage: ActivityStage): string => {
  const outputs = (stage.outputs ?? {}) as Record<string, unknown>
  const inputs = (stage.inputs ?? {}) as Record<string, unknown>
  const metrics = stage.metrics ?? {}

  switch (stage.kind) {
    case 'routing': {
      const retrievalInvoked = outputs.retrievalInvoked as boolean | undefined
      if (retrievalInvoked === true) return 'evidence needed'
      if (stage.reason === 'assistant_identity') return 'identity'
      if (retrievalInvoked === false) return 'direct'
      return stage.reason ?? ''
    }
    case 'context': {
      const count = metrics.selectedHistoryCount
      return typeof count === 'number' ? `${count} messages` : ''
    }
    case 'query_interpretation': {
      const query = outputs.effectiveQuery as string | undefined
      if (query) return query.length > 20 ? `"${query.slice(0, 20)}…"` : `"${query}"`
      return stage.status === 'skipped' ? 'skipped' : ''
    }
    case 'trigger_analysis': {
      const matchCount = metrics.matchCount
      if (typeof matchCount === 'number') return matchCount === 0 ? 'none' : `${matchCount} matched`
      return stage.status === 'skipped' ? 'skipped' : ''
    }
    case 'shape_selection': {
      const shapeName = outputs.shapeName as string | undefined
      return shapeName?.replaceAll('_', ' ') ?? ''
    }
    case 'semantic_original':
    case 'semantic_rewritten':
    case 'lexical': {
      const count = metrics.candidateCount
      return typeof count === 'number' ? `${count} passages` : ''
    }
    case 'candidate_preparation': {
      const merged = metrics.mergedCount
      const scored = metrics.scoredCount
      if (typeof merged === 'number' && typeof scored === 'number' && merged !== scored)
        return `${merged} → ${scored}`
      return typeof merged === 'number' ? `${merged} merged` : ''
    }
    case 'context_selection': {
      const final = metrics.finalContextCount
      return typeof final === 'number' ? `top ${final}` : ''
    }
    case 'prompt_assembly': {
      const citations = metrics.citationCount
      return typeof citations === 'number' ? `${citations} citations` : ''
    }
    case 'diagnostics':
      return outputs.fallbackApplied ? 'fallback' : 'ok'
    case 'answer_outcome': {
      const skillOutcome = outputs.skillOutcome as string | undefined
      if (skillOutcome) return skillOutcome.replaceAll('_', ' ')
      const outcome = outputs.outcome as string | undefined
      if (outcome === 'non_retrieval_response' || outcome === 'non_retrieval_answer') return 'direct reply'
      return outcome?.replaceAll('_', ' ') ?? ''
    }
    case 'generation': {
      const model = inputs.model as string | undefined
      return model ?? ''
    }
    default: {
      const count = chunkCount(stage)
      if (typeof count === 'number') return `${count}`
      return stage.reason ?? ''
    }
  }
}

function CompactStageNode({
  stage,
  isSelected,
  onSelect,
  className,
}: {
  stage: ActivityStage
  isSelected: boolean
  onSelect: (stageId: string) => void
  className?: string
}) {
  const summary = summaryLine(stage)

  return (
    <button
      type="button"
      onClick={() => onSelect(stage.stageId)}
      className={`flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left transition ${
        isSelected ? 'bg-primary/10' : 'hover:bg-muted/50'
      } ${className ?? ''}`}
    >
      <span className={`h-1.5 w-1.5 shrink-0 rounded-full ${STATUS_DOT[stage.status]}`} />
      <span
        className={`min-w-0 flex-1 truncate text-xs ${
          isSelected ? 'font-medium text-primary' : 'text-foreground'
        }`}
      >
        {displayLabel(stage)}
      </span>
      {summary ? (
        <span className="shrink-0 text-[11px] text-muted-foreground">{summary}</span>
      ) : null}
    </button>
  )
}

export function ActivityTraceGraph({
  activityTrace,
  selectedStageId,
  onSelectStage,
}: {
  activityTrace: ActivityTrace
  selectedStageId: string
  onSelectStage: (stageId: string) => void
}) {
  const sections = deriveLayout(activityTrace)
  const items = buildRenderItems(sections)

  return (
    <nav>
      {items.map((item, index) =>
        item.type === 'parallel' ? (
          <div key={`${index}-parallel`} className="my-2 rounded-lg border border-border/50 bg-background/50 p-1">
            <p className="px-2 py-0.5 text-[10px] font-medium uppercase tracking-wider text-muted-foreground/60">
              {item.label}
            </p>
            <div className="space-y-px">
              {item.stages.map((stage) => (
                <CompactStageNode
                  key={stage.stageId}
                  stage={stage}
                  isSelected={stage.stageId === selectedStageId}
                  onSelect={onSelectStage}
                />
              ))}
            </div>
          </div>
        ) : (
          <CompactStageNode
            key={item.stage.stageId}
            stage={item.stage}
            isSelected={item.stage.stageId === selectedStageId}
            onSelect={onSelectStage}
            className={item.phaseBreak ? 'mt-3' : ''}
          />
        ),
      )}
    </nav>
  )
}
