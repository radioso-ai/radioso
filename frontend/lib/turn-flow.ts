import type {
  ActivityTrace,
  ConversationTraceStage,
  TurnTraceEnvelope,
} from '@/lib/api'
import {
  activityStageAttention,
  activityStageDurationMs,
  activityStageLabel,
  activityStageQualifier,
  activityStageSummary,
  activityTraceSummary,
  statusTone,
  type StageTone,
} from '@/lib/activity-stage-presentation'
import { answerCoverageOutcomePresentation, answerCoverageReasonLabel } from '@/lib/answer-coverage'
import {
  answerCoverageFromTurnTrace,
  getCapabilitySubTrace,
  resolveCapabilityLeaf,
  spineStageLabel,
  stageLeafView,
  turnTraceRollup,
} from '@/lib/turn-trace'

/**
 * Flattens a {@link TurnTraceEnvelope} into the turn's progression: the message
 * is understood, a skill or routine acts, the answer is composed, and the verdict
 * closes the turn. Spine stages become steps in execution order, grouped into
 * those three phases; history and directives feed in as inputs where they are
 * used. Each step says what it decided, how long it measurably took, and whether
 * it needs a look.
 *
 * A capability's own sub-trace becomes a path of steps grouped under its skill
 * node, so the renderer can fold it away ({@link foldTurnFlowGroups}). Pure and
 * renderer-agnostic — the draw layer owns no knowledge of the trace shape.
 */

export type FlowNodeKind = 'input' | 'skill' | 'stage' | 'outcome'
export type FlowStatus = ConversationTraceStage['status']
export type FlowTone = StageTone
export type FlowPhase = 'understand' | 'act' | 'answer'
type FlowEdgeKind = 'input' | 'sequence' | 'branch' | 'converge'

/** How to resolve the detail pane when a node is selected. */
export type TurnFlowNodeDetail =
  | { kind: 'spine'; spineStageId: string }
  | {
      kind: 'leaf'
      leafStageId: string
      /** The dispatch whose sub-trace holds the stage; absent for a bare activity trace. */
      dispatchStageId?: string
    }
  | { kind: 'none' }

export interface TurnFlowNode {
  id: string
  nodeKind: FlowNodeKind
  label: string
  sublabel?: string
  /** One short line on what needs a look. */
  note?: string
  status?: FlowStatus
  tone: FlowTone
  phase?: FlowPhase
  /** Measured wall time; absent when the trace recorded no real span. */
  durationMs?: number
  /** The skill node a capability step folds into. */
  groupId?: string
  /** On a skill node: how many capability steps fold into it. */
  stepCount?: number
  detail: TurnFlowNodeDetail
}

export interface TurnFlowEdge {
  id: string
  source: string
  target: string
  kind: FlowEdgeKind
}

export interface TurnFlowPhaseBand {
  id: FlowPhase
  label: string
  durationMs?: number
}

export interface TurnFlowTotals {
  totalMs?: number
  /** Calls on the turn's critical path. */
  modelCallCount?: number
  /** Every call the turn recorded, including ones off the critical path. */
  recordedModelCallCount?: number
  modelTimeMs?: number
  modelCallsStageId?: string
}

export interface TurnFlowGraph {
  nodes: TurnFlowNode[]
  edges: TurnFlowEdge[]
  phases: TurnFlowPhaseBand[]
  totals?: TurnFlowTotals
}

interface FlowMessageRecord {
  id?: string
  content: string
}

interface Span {
  startMs: number
  endMs: number
}

const PHASE_ORDER: readonly FlowPhase[] = ['understand', 'act', 'answer']

// Spine stages whose content another node already carries.
const FOLDED_STAGE_KINDS = new Set([
  // Its work is the retrieval dispatch's sub-trace; the skill node carries its span.
  'retrieval_fanout',
  // The turn's model-call collection is a total, not a step.
  'model_calls',
])

const DIRECTIVE_STAGE_KINDS = new Set(['directive_match', 'directive_steering', 'coverage_directive_match'])
const ROUTINE_STAGE_KINDS = new Set(['routine_activate', 'routine_resume'])

const STAGE_PHASES: Record<string, FlowPhase> = {
  message: 'understand',
  turn_interpretation: 'understand',
  skill_selection: 'understand',
  clarification: 'understand',
  skill_input_resolution: 'act',
  skill_dispatch: 'act',
  routine_activate: 'act',
  routine_resume: 'act',
  routine_slot_correction: 'act',
  answer_coverage_head: 'answer',
  answer_coverage_routine_activation: 'answer',
  answer_coverage_reaction_recording: 'answer',
  answer_coverage_yield_without_routine: 'answer',
  compose: 'answer',
}

const TONE_RANK: Record<FlowTone, number> = { bad: 4, warn: 3, good: 2, neutral: 1, muted: 0 }

const asString = (value: unknown): string | undefined =>
  typeof value === 'string' ? value : undefined

const asRecord = (value: unknown): Record<string, unknown> | undefined =>
  value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined

const spaced = (value: string): string => value.replaceAll('_', ' ')

const titleCase = (value: string): string =>
  value
    .split(/[-_]/)
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join(' ')

const joined = (parts: ReadonlyArray<string | undefined>, separator = ' · '): string | undefined => {
  const present = parts.filter((part): part is string => Boolean(part))
  return present.length ? present.join(separator) : undefined
}

const timeMs = (value: string | undefined): number | undefined => {
  if (!value) return undefined
  const parsed = Date.parse(value)
  return Number.isFinite(parsed) ? parsed : undefined
}

/** A span the trace actually measured; placeholders open and close on one instant. */
const measuredSpan = (startedAt: string | undefined, completedAt: string | undefined): Span | undefined => {
  const startMs = timeMs(startedAt)
  const endMs = timeMs(completedAt)
  return startMs !== undefined && endMs !== undefined && endMs > startMs ? { startMs, endMs } : undefined
}

const spanMs = (span: Span | undefined): number | undefined => (span ? span.endMs - span.startMs : undefined)

/** Wall time covered by a set of spans, with overlaps counted once. */
const coveredMs = (spans: readonly Span[]): number | undefined => {
  if (spans.length === 0) return undefined
  const ordered = [...spans].sort((left, right) => left.startMs - right.startMs)
  let total = 0
  let current = { ...ordered[0] }
  for (const span of ordered.slice(1)) {
    if (span.startMs <= current.endMs) {
      current.endMs = Math.max(current.endMs, span.endMs)
    } else {
      total += current.endMs - current.startMs
      current = { ...span }
    }
  }
  return total + current.endMs - current.startMs
}

const worstTone = (tones: readonly FlowTone[]): FlowTone =>
  tones.reduce<FlowTone>((worst, tone) => (TONE_RANK[tone] > TONE_RANK[worst] ? tone : worst), 'neutral')

// ---------------------------------------------------------------------------
// Per-stage summaries: what each step decided.

const interpretationSummary = (stage: ConversationTraceStage): string | undefined => {
  const outputs = stage.outputs ?? {}
  const proposal = asRecord(asRecord(outputs.metadata)?.rewriteProposal)
  const turnKind = asString(proposal?.turnKind)
  const subqueries = typeof proposal?.retrievalSubqueryCount === 'number' ? proposal.retrievalSubqueryCount : undefined
  return joined([
    asString(outputs.route),
    turnKind ? spaced(turnKind) : undefined,
    subqueries !== undefined && subqueries > 1 ? `${subqueries} sub-questions` : undefined,
  ])
}

const selectionSummary = (stage: ConversationTraceStage): string | undefined => {
  const outputs = stage.outputs ?? {}
  const selected = Array.isArray(outputs.selectedSkills)
    ? outputs.selectedSkills.filter((name): name is string => typeof name === 'string')
    : []
  if (selected.length === 0) {
    const reason = asString(outputs.reason)
    return reason ? spaced(reason) : undefined
  }
  const considered = Array.isArray(outputs.candidates) ? outputs.candidates.length : 0
  return joined([selected.join(', '), considered > 1 ? `${considered} considered` : undefined])
}

const directiveSummary = (stage: ConversationTraceStage): string | undefined => {
  const outputs = (stage.outputs ?? {}) as { matchCount?: unknown; candidateCount?: unknown }
  const matched = typeof outputs.matchCount === 'number' ? outputs.matchCount : undefined
  const considered = typeof outputs.candidateCount === 'number' ? outputs.candidateCount : undefined
  if (matched === 0) return 'none matched'
  if (typeof matched === 'number' && typeof considered === 'number')
    return `${matched} of ${considered} matched`
  if (typeof matched === 'number') return `${matched} matched`
  return stage.status === 'skipped' ? 'none matched' : undefined
}

const adherenceSummary = (stage: ConversationTraceStage): { label?: string; unmet: boolean } => {
  const adherence = stage.outputs?.adherence
  if (!Array.isArray(adherence) || adherence.length === 0) return { unmet: false }
  const entries = adherence.filter(
    (entry): entry is { satisfied: boolean } =>
      typeof asRecord(entry)?.satisfied === 'boolean',
  )
  if (entries.length === 0) return { unmet: false }
  const honored = entries.filter((entry) => entry.satisfied).length
  return { label: `${honored}/${entries.length} directives honored`, unmet: honored < entries.length }
}

const composeView = (stage: ConversationTraceStage): { sublabel?: string; tone: FlowTone } => {
  const adherence = adherenceSummary(stage)
  const citations = stage.outputs?.citationCount
  const tone = statusTone(stage.status)
  return {
    sublabel: joined([
      adherence.label,
      typeof citations === 'number' && citations > 0 ? `${citations} cited` : undefined,
    ]),
    tone: adherence.unmet ? worstTone([tone, 'warn']) : tone,
  }
}

const messageSummary = (
  stage: ConversationTraceStage,
  messages: readonly FlowMessageRecord[] | undefined,
): string | undefined => {
  // The trace carries only structural references; the text lives on the
  // conversation record the host already loaded.
  const eventId = asString(stage.outputs?.eventId)
  const text = eventId ? messages?.find((message) => message.id === eventId)?.content.trim() : undefined
  if (text) return text
  const length = stage.outputs?.contentLength
  return typeof length === 'number' && length > 0 ? `${length} chars` : undefined
}

const clarificationSummary = (stage: ConversationTraceStage): string | undefined => {
  const outputs = stage.outputs ?? {}
  const decision = asString(outputs.decision)
  const reason = asString(outputs.reason)
  if (!decision) return undefined
  const summary = spaced(decision)
  if (decision === 'auto_picked' && reason === 'label_fallback') {
    return `${summary}: label fallback`
  }
  return summary
}

const clarificationTone = (stage: ConversationTraceStage): FlowTone =>
  // An offered clarification passes the turn through; it is not a skipped step.
  asString(stage.outputs?.decision) === 'offered' ? 'neutral' : statusTone(stage.status)

const COVERAGE_TONES: Record<string, FlowTone> = {
  answered: 'good',
  partial: 'warn',
  unanswered: 'bad',
  unclear: 'neutral',
}

const coverageView = (stage: ConversationTraceStage): { sublabel?: string; tone: FlowTone } => {
  const outputs = stage.outputs ?? {}
  const availability = asString(outputs.availability)
  if (availability !== 'assessed') {
    return {
      sublabel: availability ? titleCase(availability) : undefined,
      tone: availability === 'not_recorded' ? 'muted' : 'warn',
    }
  }
  const coverage = asString(outputs.coverage)
  const reason = asString(outputs.reason)
  return {
    sublabel: joined([coverage ? titleCase(coverage) : undefined, reason ? answerCoverageReasonLabel(reason) : undefined]),
    tone: (coverage && COVERAGE_TONES[coverage]) || 'neutral',
  }
}

const routineSummary = (stage: ConversationTraceStage): string | undefined => {
  const outputs = stage.outputs ?? {}
  if (outputs.handoff) return 'handed off'
  if (outputs.completed === true) return 'completed'
  return outputs.completed === false ? 'in progress' : undefined
}

const deriveOutcome = (
  envelope: TurnTraceEnvelope,
  steps: { dispatch?: ConversationTraceStage; clarification?: ConversationTraceStage; routine?: ConversationTraceStage },
): { sublabel?: string; tone: FlowTone } => {
  if (steps.dispatch?.status === 'failed') {
    return { sublabel: 'Skill failed', tone: 'bad' }
  }
  // A blocking question ends the turn before any answer could be judged.
  if (asString(steps.clarification?.outputs?.decision) === 'asked') {
    return { sublabel: 'Asked the visitor to choose', tone: 'neutral' }
  }
  const coverage = answerCoverageFromTurnTrace(envelope)
  if (coverage?.availability === 'assessed' && coverage.coverage) {
    return {
      sublabel: answerCoverageOutcomePresentation(coverage.coverage).title,
      tone: COVERAGE_TONES[coverage.coverage] ?? 'neutral',
    }
  }
  if (steps.routine) {
    const summary = routineSummary(steps.routine)
    return { sublabel: summary ? `Routine ${summary}` : 'Routine replied', tone: statusTone(steps.routine.status) }
  }
  const dispatchStatus = asString(steps.dispatch?.outputs?.outcomeStatus)
  return { sublabel: dispatchStatus ? spaced(dispatchStatus) : undefined, tone: 'neutral' }
}

const deriveTotals = (envelope: TurnTraceEnvelope): TurnFlowTotals | undefined => {
  const rollup = turnTraceRollup(envelope)
  const modelCallsStage = envelope.spine.stages.find((stage) => stage.kind === 'model_calls')
  const recordedCalls = Array.isArray(modelCallsStage?.outputs?.modelCalls) ? modelCallsStage.outputs.modelCalls.length : 0
  // The summary records 0 when it could not measure the turn.
  const totalMs = rollup?.totalTurnWallClockMs || spanMs(measuredSpan(envelope.spine.startedAt, envelope.spine.completedAt))
  const modelCallCount = rollup?.totalLlmCalls ?? modelCallsStage?.metrics?.llmCallCount
  if (totalMs === undefined && modelCallCount === undefined) return undefined
  return {
    totalMs,
    modelCallCount,
    recordedModelCallCount: recordedCalls > 0 ? recordedCalls : undefined,
    modelTimeMs: rollup?.totalModelTimeMs ?? modelCallsStage?.metrics?.latencyMs,
    modelCallsStageId: modelCallsStage?.id,
  }
}

// ---------------------------------------------------------------------------
// Graph assembly.

class FlowBuilder {
  readonly nodes: TurnFlowNode[] = []
  readonly edges: TurnFlowEdge[] = []
  readonly spans = new Map<string, Span>()

  add(node: TurnFlowNode, span?: Span): TurnFlowNode {
    this.nodes.push(node)
    if (span) this.spans.set(node.id, span)
    return node
  }

  link(source: string, target: string, kind: FlowEdgeKind): void {
    this.edges.push({ id: `e:${source}->${target}`, source, target, kind })
  }

  /**
   * Phase bands in progression order. A band is timed by the time its own steps
   * measurably ran, so work that happened between them (retrieval runs before
   * the skill choice is recorded) is counted once, in its own band.
   */
  phases(labels: Partial<Record<FlowPhase, string>>): TurnFlowPhaseBand[] {
    const feeders = new Set(this.edges.filter((edge) => edge.kind === 'input').map((edge) => edge.source))
    return PHASE_ORDER.flatMap((phase) => {
      const members = this.nodes.filter((node) => node.phase === phase && !feeders.has(node.id))
      if (members.length === 0) return []
      const durationMs = coveredMs(members.flatMap((node) => {
        const span = this.spans.get(node.id)
        return span ? [span] : []
      }))
      return [{ id: phase, label: labels[phase] ?? titleCase(phase), ...(durationMs === undefined ? {} : { durationMs }) }]
    })
  }
}

interface CapabilityPath {
  nodes: TurnFlowNode[]
  edges: TurnFlowEdge[]
  entryId?: string
  terminalId?: string
}

const activityTracePath = (
  trace: ActivityTrace,
  options: { groupId?: string; idPrefix: string; dispatchStageId?: string },
): CapabilityPath => {
  const nodeId = (stageId: string) => `${options.idPrefix}${stageId}`
  const nodes: TurnFlowNode[] = trace.stages.map((stage) => {
    const attention = activityStageAttention(stage)
    const durationMs = activityStageDurationMs(stage)
    return {
      id: nodeId(stage.stageId),
      nodeKind: 'stage',
      label: activityStageLabel(stage),
      sublabel: joined([activityStageQualifier(stage), activityStageSummary(stage) || undefined]),
      ...(attention.reason ? { note: attention.reason } : {}),
      status: stage.status,
      tone: attention.tone,
      phase: 'act',
      ...(durationMs === undefined ? {} : { durationMs }),
      ...(options.groupId ? { groupId: options.groupId } : {}),
      detail: {
        kind: 'leaf',
        leafStageId: stage.stageId,
        ...(options.dispatchStageId ? { dispatchStageId: options.dispatchStageId } : {}),
      },
    }
  })

  const links = trace.links ?? []
  const edges: TurnFlowEdge[] = links.map((link, index) => ({
    // Two links can join the same pair of stages; the index keeps edge ids unique.
    id: `e:${nodeId(link.fromStageId)}->${nodeId(link.toStageId)}:${index}`,
    source: nodeId(link.fromStageId),
    target: nodeId(link.toStageId),
    kind: link.kind === 'branch' ? 'branch' : link.kind === 'converge' ? 'converge' : 'sequence',
  }))

  const incoming = new Set(links.map((link) => link.toStageId))
  const outgoing = new Set(links.map((link) => link.fromStageId))
  const entry = trace.stages.find((stage) => !incoming.has(stage.stageId)) ?? trace.stages[0]
  const terminal =
    [...trace.stages].reverse().find((stage) => !outgoing.has(stage.stageId)) ?? trace.stages.at(-1)

  return {
    nodes,
    edges,
    entryId: entry ? nodeId(entry.stageId) : undefined,
    terminalId: terminal ? nodeId(terminal.stageId) : undefined,
  }
}

/** The capability's own span, or the dispatch's when the sub-trace kept no clock. */
const capabilitySpan = (trace: ActivityTrace | undefined, dispatch: ConversationTraceStage): Span | undefined => {
  if (trace) {
    const fromClock = measuredSpan(trace.startedAt, trace.completedAt)
    if (fromClock) return fromClock
    const startMs = timeMs(trace.startedAt)
    if (startMs !== undefined && typeof trace.totalDurationMs === 'number' && trace.totalDurationMs > 0) {
      return { startMs, endMs: startMs + trace.totalDurationMs }
    }
  }
  return measuredSpan(dispatch.startedAt, dispatch.completedAt)
}

/** A capability with no renderer yet: one step naming it, always in view. */
const rawLeafPath = (id: string, namespace: string): CapabilityPath => ({
  nodes: [{ id, nodeKind: 'stage', label: namespace, tone: 'neutral', phase: 'act', detail: { kind: 'none' } }],
  edges: [],
  entryId: id,
  terminalId: id,
})

const flaggedStep = (steps: readonly TurnFlowNode[]): { tone: FlowTone; note?: string } => {
  const tone = worstTone(steps.map((step) => step.tone))
  const first = steps.find((step) => step.tone === tone && step.note)
  return { tone, ...(first && TONE_RANK[tone] >= TONE_RANK.warn ? { note: `${first.label}: ${first.note}` } : {}) }
}

export const envelopeToFlowGraph = (
  envelope: TurnTraceEnvelope,
  options: { messages?: readonly FlowMessageRecord[] } = {},
): TurnFlowGraph => {
  const spine = envelope.spine
  const flow = new FlowBuilder()
  const phaseLabels: Partial<Record<FlowPhase, string>> = { understand: 'Understand', answer: 'Answer' }
  const inputs: Array<{
    role: 'history' | 'directives'
    stage: ConversationTraceStage
    id: string
    label: string
    sublabel?: string
  }> = []

  let phase: FlowPhase = 'understand'
  let tailId: string | undefined
  let dispatchCount = 0
  let directiveCount = 0
  let historyTargetId: string | undefined
  let answerProducerId: string | undefined
  const steps: { dispatch?: ConversationTraceStage; clarification?: ConversationTraceStage; routine?: ConversationTraceStage; compose?: ConversationTraceStage } = {}

  // Phases only move forward: a stage appended late joins the phase it lands in.
  const phaseFor = (kind: string): FlowPhase => {
    const declared = STAGE_PHASES[kind]
    if (declared && PHASE_ORDER.indexOf(declared) > PHASE_ORDER.indexOf(phase)) phase = declared
    return phase
  }

  /** Appends a step to the progression; the closing outcome belongs to no phase. */
  const step = (node: Omit<TurnFlowNode, 'phase'>, kind?: string, span?: Span): TurnFlowNode => {
    const added = flow.add(kind ? { ...node, phase: phaseFor(kind) } : node, span)
    if (tailId) flow.link(tailId, added.id, 'sequence')
    if (added.id !== 'input:message') historyTargetId ??= added.id
    tailId = added.id
    return added
  }

  const spineStep = (
    stage: ConversationTraceStage,
    view: { label?: string; sublabel?: string; tone?: FlowTone } = {},
  ): TurnFlowNode => {
    const span = measuredSpan(stage.startedAt, stage.completedAt)
    const durationMs = spanMs(span)
    return step(
      {
        id: `spine:${stage.id}`,
        nodeKind: 'stage',
        label: view.label ?? spineStageLabel(stage),
        ...(view.sublabel ? { sublabel: view.sublabel } : {}),
        status: stage.status,
        tone: view.tone ?? statusTone(stage.status),
        ...(durationMs === undefined ? {} : { durationMs }),
        detail: { kind: 'spine', spineStageId: stage.id },
      },
      stage.kind,
      span,
    )
  }

  for (const stage of spine.stages) {
    if (FOLDED_STAGE_KINDS.has(stage.kind)) continue

    if (DIRECTIVE_STAGE_KINDS.has(stage.kind)) {
      inputs.push({
        role: 'directives',
        stage,
        id: directiveCount === 0 ? 'input:directives' : `input:directives:${directiveCount}`,
        label: 'Directives',
        sublabel: directiveSummary(stage),
      })
      directiveCount += 1
      continue
    }

    switch (stage.kind) {
      case 'message':
        if (!flow.nodes.some((node) => node.id === 'input:message')) {
          step(
            {
              id: 'input:message',
              nodeKind: 'input',
              label: 'Message',
              sublabel: messageSummary(stage, options.messages),
              status: stage.status,
              tone: 'neutral',
              detail: { kind: 'spine', spineStageId: stage.id },
            },
            stage.kind,
          )
        }
        break
      case 'gather': {
        const historyCount = typeof stage.outputs?.historyCount === 'number' ? stage.outputs.historyCount : 0
        if (historyCount > 0) {
          inputs.push({ role: 'history', stage, id: 'input:history', label: 'History', sublabel: `${historyCount} prior` })
        }
        break
      }
      case 'turn_interpretation':
        spineStep(stage, { sublabel: interpretationSummary(stage) })
        break
      case 'skill_selection':
        spineStep(stage, { sublabel: selectionSummary(stage) })
        break
      case 'clarification':
        steps.clarification ??= stage
        spineStep(stage, { sublabel: clarificationSummary(stage), tone: clarificationTone(stage) })
        break
      case 'answer_coverage_head':
        // A sink that reports twice pushes a second, minimal stage with no verdict.
        if (typeof stage.outputs?.availability !== 'string') break
        spineStep(stage, coverageView(stage))
        break
      case 'compose': {
        steps.compose ??= stage
        const composed = spineStep(stage, composeView(stage))
        answerProducerId ??= composed.id
        break
      }
      case 'skill_dispatch': {
        steps.dispatch ??= stage
        const scope = dispatchCount === 0 ? '' : `${dispatchCount}:`
        const skillId = dispatchCount === 0 ? 'skill' : `skill:${dispatchCount}`
        dispatchCount += 1
        const subTrace = getCapabilitySubTrace(stage)
        const leaf = subTrace ? resolveCapabilityLeaf(subTrace) : undefined
        const skillName = asString(stage.outputs?.skillName) ?? 'Skill'
        const path: CapabilityPath | undefined =
          leaf?.kind === 'activity-trace'
            ? activityTracePath(leaf.trace, { groupId: skillId, idPrefix: `stage:${scope}`, dispatchStageId: stage.id })
            : leaf?.kind === 'raw'
              ? rawLeafPath(`leaf:${scope}${leaf.namespace}`, leaf.namespace)
              : undefined
        const span = capabilitySpan(leaf?.kind === 'activity-trace' ? leaf.trace : undefined, stage)
        const durationMs = spanMs(span)
        const flagged = flaggedStep(path?.nodes ?? [])
        const outcomeStatus = asString(stage.outputs?.outcomeStatus)
        const skill = step(
          {
            id: skillId,
            nodeKind: 'skill',
            label: leaf ? titleCase(leaf.namespace) : skillName,
            sublabel:
              (leaf?.kind === 'activity-trace' ? activityTraceSummary(leaf.trace) : undefined)
              ?? (leaf ? skillName : outcomeStatus ? spaced(outcomeStatus) : undefined),
            ...(flagged.note ? { note: flagged.note } : {}),
            status: stage.status,
            tone: worstTone([statusTone(stage.status), flagged.tone]),
            ...(durationMs === undefined ? {} : { durationMs }),
            ...(leaf?.kind === 'activity-trace' && path?.nodes.length ? { stepCount: path.nodes.length } : {}),
            detail: { kind: 'spine', spineStageId: stage.id },
          },
          stage.kind,
          span,
        )
        phaseLabels.act ??= skill.label
        if (path?.nodes.length) {
          for (const pathNode of path.nodes) flow.add(pathNode)
          flow.edges.push(...path.edges)
          if (path.entryId) flow.link(skill.id, path.entryId, 'sequence')
          if (path.terminalId) tailId = path.terminalId
        }
        break
      }
      default:
        if (ROUTINE_STAGE_KINDS.has(stage.kind)) {
          steps.routine ??= stage
          const routine = spineStep(stage, { label: 'Routine', sublabel: routineSummary(stage) })
          phaseLabels.act ??= routine.label
          break
        }
        spineStep(stage)
    }
  }

  const outcome = deriveOutcome(envelope, steps)
  const outcomeDetailStage = steps.compose ?? steps.routine
  const outcomeNode = step(
    {
      id: 'outcome',
      nodeKind: 'outcome',
      label: 'Outcome',
      ...(outcome.sublabel ? { sublabel: outcome.sublabel } : {}),
      tone: outcome.tone,
      detail: outcomeDetailStage ? { kind: 'spine', spineStageId: outcomeDetailStage.id } : { kind: 'none' },
    },
  )

  // Inputs feed the step that uses them: history the first step after the
  // message, directives the step that writes the reply.
  const directiveTargetId =
    answerProducerId
    ?? (steps.routine ? `spine:${steps.routine.id}` : undefined)
    ?? (steps.dispatch ? 'skill' : undefined)
    ?? outcomeNode.id
  for (const input of inputs) {
    const targetId = input.role === 'history' ? historyTargetId ?? outcomeNode.id : directiveTargetId
    const target = flow.nodes.find((candidate) => candidate.id === targetId)
    flow.add({
      id: input.id,
      nodeKind: 'input',
      label: input.label,
      ...(input.sublabel ? { sublabel: input.sublabel } : {}),
      status: input.stage.status,
      tone: statusTone(input.stage.status),
      ...(target?.phase ? { phase: target.phase } : {}),
      detail: { kind: 'spine', spineStageId: input.stage.id },
    })
    flow.link(input.id, targetId, 'input')
  }

  const totals = deriveTotals(envelope)
  return {
    nodes: flow.nodes,
    edges: flow.edges,
    phases: flow.phases(phaseLabels),
    ...(totals ? { totals } : {}),
  }
}

/**
 * A bare activity trace (a legacy eval run without a turn envelope) as a flow:
 * the capability's steps, always unfolded, leading to its outcome.
 */
export const activityTraceToFlowGraph = (
  trace: ActivityTrace,
  namespace = 'activity',
): TurnFlowGraph => {
  const flow = new FlowBuilder()
  const path = activityTracePath(trace, { idPrefix: 'stage:' })
  const terminalStage = path.terminalId
    ? trace.stages.find((stage) => `stage:${stage.stageId}` === path.terminalId)
    : trace.stages.at(-1)

  const skill = flow.add({
    id: 'skill',
    nodeKind: 'skill',
    label: titleCase(namespace),
    sublabel: activityTraceSummary(trace) ?? 'activity trace',
    status: trace.stages[0]?.status,
    tone: flaggedStep(path.nodes).tone,
    phase: 'act',
    detail: { kind: 'none' },
  })
  for (const pathNode of path.nodes) flow.add(pathNode)
  flow.edges.push(...path.edges)
  if (path.entryId) flow.link(skill.id, path.entryId, 'sequence')

  flow.add({
    id: 'outcome',
    nodeKind: 'outcome',
    label: 'Outcome',
    sublabel: terminalStage ? activityStageSummary(terminalStage) || terminalStage.status : undefined,
    status: terminalStage?.status ?? 'unavailable',
    tone: terminalStage ? activityStageAttention(terminalStage).tone : 'muted',
    detail: terminalStage ? { kind: 'leaf', leafStageId: terminalStage.stageId } : { kind: 'none' },
  })
  flow.link(path.terminalId ?? skill.id, 'outcome', 'sequence')

  return { nodes: flow.nodes, edges: flow.edges, phases: flow.phases({ act: skill.label }) }
}

/** The activity trace a leaf step belongs to: its own dispatch's, else the host's single trace. */
export const leafTraceFor = (
  detail: Extract<TurnFlowNodeDetail, { kind: 'leaf' }>,
  spineStages: readonly ConversationTraceStage[],
  fallback?: ActivityTrace,
): ActivityTrace | undefined => {
  const dispatch = detail.dispatchStageId
    ? spineStages.find((stage) => stage.id === detail.dispatchStageId)
    : undefined
  const leaf = dispatch ? stageLeafView(dispatch) : undefined
  return leaf?.kind === 'activity-trace' ? leaf.trace : fallback
}

/**
 * Folds every capability path whose skill node is not in `expanded` into that
 * skill node: its steps disappear and the path's exit leaves from the skill.
 */
export const foldTurnFlowGroups = (graph: TurnFlowGraph, expanded: ReadonlySet<string>): TurnFlowGraph => {
  const hidden = new Map(
    graph.nodes
      .filter((node) => node.groupId !== undefined && !expanded.has(node.groupId))
      .map((node) => [node.id, node.groupId as string]),
  )
  if (hidden.size === 0) return graph

  const edges: TurnFlowEdge[] = []
  const seen = new Set<string>()
  for (const edge of graph.edges) {
    if (hidden.has(edge.target)) continue
    const source = hidden.get(edge.source) ?? edge.source
    const id = `e:${source}->${edge.target}`
    if (seen.has(id)) continue
    seen.add(id)
    edges.push(source === edge.source ? edge : { id, source, target: edge.target, kind: 'sequence' })
  }
  return { ...graph, nodes: graph.nodes.filter((node) => !hidden.has(node.id)), edges }
}
