'use client'

import type { ActivityTrace, ActivityStage } from '@/lib/api'
import { activityStageLabel, activityStageSummary } from '@/lib/activity-stage-presentation'
import { useCopilotEntity } from '@/lib/copilot-context'

const STATUS_DOT: Record<ActivityStage['status'], string> = {
  applied: 'bg-emerald-500',
  skipped: 'bg-slate-400',
  fallback: 'bg-amber-500',
  rejected: 'bg-rose-500',
  unavailable: 'bg-zinc-400',
  failed: 'bg-red-500',
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
  useCopilotEntity('conversation', stage.stageId, `Trace stage: ${activityStageLabel(stage)}`)
  const summary = activityStageSummary(stage)

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
        {activityStageLabel(stage)}
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
