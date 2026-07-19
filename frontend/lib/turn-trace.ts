import type {
  ActivityTrace,
  CapabilitySubTrace,
  ConversationTrace,
  ConversationTraceStage,
  TurnTraceEnvelope,
} from '@/lib/api'

/**
 * The conversation spine is the root span of a turn; each capability hangs its
 * own domain trace off its dispatch stage as a namespaced {@link CapabilitySubTrace}.
 * This module resolves those leaves into a renderable view, keyed by namespace —
 * the one place the namespace→renderer mapping lives. Adding a capability means
 * adding a resolver here and a renderer in the registry, not editing the spine.
 */

const SPINE_STAGE_LABELS: Record<string, string> = {
  message: 'Message',
  gather: 'Gather',
  directive_match: 'Directives',
  // Routine turns co-compose directives at render time under this kind.
  directive_steering: 'Directives',
  skill_selection: 'Select skill',
  skill_dispatch: 'Dispatch',
  compose: 'Compose',
  routine_resume: 'Routine',
  routine_activate: 'Routine',
  clarification: 'Clarification',
  model_calls: 'Model calls',
}

export const spineStageLabel = (stage: ConversationTraceStage): string =>
  SPINE_STAGE_LABELS[stage.kind] ?? stage.kind.replaceAll('_', ' ')

export interface SpineStageTelemetry {
  durationMs?: number
  models: string[]
  operations: string[]
  llmCallCount?: number
  modelTimeMs?: number
  inputTokens?: number
  outputTokens?: number
  totalTokens?: number
  calls: Array<{
    stageId?: string
    operation: string
    model: string
    durationMs?: number
    inputTokens?: number
    outputTokens?: number
    totalTokens?: number
    status?: string
  }>
}

const finiteNumber = (value: unknown): number | undefined =>
  typeof value === 'number' && Number.isFinite(value) ? value : undefined

const elapsedMs = (
  startedAt: string | undefined,
  completedAt: string | undefined,
): number | undefined => {
  if (!startedAt || !completedAt) return undefined
  const startedAtMs = Date.parse(startedAt)
  const completedAtMs = Date.parse(completedAt)
  return Number.isFinite(startedAtMs) && Number.isFinite(completedAtMs)
    ? Math.max(0, completedAtMs - startedAtMs)
    : undefined
}

const record = (value: unknown): Record<string, unknown> | undefined =>
  value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined

export const spineStageTelemetry = (stage: ConversationTraceStage): SpineStageTelemetry => {
  const inputs = stage.inputs ?? {}
  const outputs = stage.outputs ?? {}
  const metrics = stage.metrics ?? {}
  const calls = Array.isArray(outputs.modelCalls)
    ? outputs.modelCalls.map(record).filter((call): call is Record<string, unknown> => Boolean(call))
    : []
  const models = new Set<string>()
  const operations = new Set<string>()
  if (typeof inputs.model === 'string') models.add(inputs.model)
  if (typeof inputs.operation === 'string') operations.add(inputs.operation)
  for (const call of calls) {
    if (typeof call.model === 'string') models.add(call.model)
    if (typeof call.operation === 'string') operations.add(call.operation)
  }
  const durationMs = elapsedMs(stage.startedAt, stage.completedAt)
  const llmCallCount = finiteNumber(metrics.llmCallCount)
  const modelTimeMs = finiteNumber(metrics.latencyMs)
  const inputTokens = finiteNumber(metrics.inputTokens)
  const outputTokens = finiteNumber(metrics.outputTokens)
  const totalTokens = finiteNumber(metrics.totalTokens)
  const normalizedCalls = calls.flatMap((call) => {
    if (typeof call.operation !== 'string' || typeof call.model !== 'string') return []
    const durationMs = finiteNumber(call.durationMs)
    const inputTokens = finiteNumber(call.inputTokens)
    const outputTokens = finiteNumber(call.outputTokens)
    const totalTokens = finiteNumber(call.totalTokens)
    return [
      {
        ...(typeof call.stageId === 'string' ? { stageId: call.stageId } : {}),
        operation: call.operation,
        model: call.model,
        ...(durationMs !== undefined ? { durationMs } : {}),
        ...(inputTokens !== undefined ? { inputTokens } : {}),
        ...(outputTokens !== undefined ? { outputTokens } : {}),
        ...(totalTokens !== undefined ? { totalTokens } : {}),
        ...(typeof call.status === 'string' ? { status: call.status } : {}),
      },
    ]
  })
  return {
    ...(durationMs !== undefined ? { durationMs } : {}),
    models: [...models],
    operations: [...operations],
    ...(llmCallCount !== undefined ? { llmCallCount } : {}),
    ...(modelTimeMs !== undefined ? { modelTimeMs } : {}),
    ...(inputTokens !== undefined ? { inputTokens } : {}),
    ...(outputTokens !== undefined ? { outputTokens } : {}),
    ...(totalTokens !== undefined ? { totalTokens } : {}),
    calls: normalizedCalls,
  }
}

export interface TurnTraceRollup {
  totalLlmCalls: number
  serialLlmDepth: number
  longestStage: { name: string; durationMs: number }
  totalModelTimeMs: number
  totalTurnWallClockMs: number
  droppedCallCount: number
}

export const turnTraceRollup = (
  envelope: TurnTraceEnvelope | undefined,
): TurnTraceRollup | undefined => {
  const summary = record(envelope?.summary)
  const longestStage = record(summary?.longestStage)
  const totalLlmCalls = finiteNumber(summary?.totalLlmCalls)
  const serialLlmDepth = finiteNumber(summary?.serialLlmDepth)
  const totalModelTimeMs = finiteNumber(summary?.totalModelTimeMs)
  const totalTurnWallClockMs = finiteNumber(summary?.totalTurnWallClockMs)
  const droppedCallCount = finiteNumber(summary?.droppedCallCount) ?? 0
  const longestStageDurationMs = finiteNumber(longestStage?.durationMs)
  if (
    totalLlmCalls === undefined
    || serialLlmDepth === undefined
    || totalModelTimeMs === undefined
    || totalTurnWallClockMs === undefined
    || typeof longestStage?.name !== 'string'
    || longestStageDurationMs === undefined
  ) {
    return undefined
  }
  return {
    totalLlmCalls,
    serialLlmDepth,
    longestStage: { name: longestStage.name, durationMs: longestStageDurationMs },
    totalModelTimeMs,
    totalTurnWallClockMs,
    droppedCallCount,
  }
}

/**
 * Namespaces whose sub-trace payload is an {@link ActivityTrace} (the rich
 * retrieval explorer). Both retrieval and pre-engine skill intake produce one,
 * so both render through the shared activity-trace leaf renderer.
 */
const ACTIVITY_TRACE_NAMESPACES = new Set(['retrieval', 'skill-intake'])

export type CapabilityLeafView =
  | { kind: 'activity-trace'; namespace: string; trace: ActivityTrace }
  | { kind: 'raw'; namespace: string; payload: unknown }

export const getCapabilitySubTrace = (
  stage: ConversationTraceStage,
): CapabilitySubTrace | undefined => stage.subTrace ?? undefined

/**
 * Resolve a sub-trace to a renderable leaf. Known activity-trace namespaces map
 * to the retrieval explorer; anything else falls back to a raw payload view so a
 * new capability is still inspectable before it gets a dedicated renderer.
 */
export const resolveCapabilityLeaf = (
  subTrace: CapabilitySubTrace,
): CapabilityLeafView => {
  if (ACTIVITY_TRACE_NAMESPACES.has(subTrace.namespace) && subTrace.payload) {
    return {
      kind: 'activity-trace',
      namespace: subTrace.namespace,
      trace: subTrace.payload as ActivityTrace,
    }
  }
  return { kind: 'raw', namespace: subTrace.namespace, payload: subTrace.payload }
}

export const stageLeafView = (
  stage: ConversationTraceStage,
): CapabilityLeafView | undefined => {
  const subTrace = getCapabilitySubTrace(stage)
  return subTrace ? resolveCapabilityLeaf(subTrace) : undefined
}

/**
 * The turn's primary activity-trace leaf — the first dispatch stage whose
 * sub-trace resolves to an ActivityTrace. Used to default the selection to the
 * rich retrieval view and to keep the legacy outcome/run-parameter presenters
 * (which read an ActivityTrace) working off the spine.
 */
export const getPrimaryLeaf = (
  spine: ConversationTrace,
): { stageId: string; trace: ActivityTrace } | undefined => {
  for (const stage of spine.stages) {
    const leaf = stageLeafView(stage)
    if (leaf?.kind === 'activity-trace') {
      return { stageId: stage.id, trace: leaf.trace }
    }
  }
  return undefined
}

export const getPrimaryLeafTrace = (
  envelope: TurnTraceEnvelope | undefined,
): ActivityTrace | undefined =>
  envelope ? getPrimaryLeaf(envelope.spine)?.trace : undefined

/**
 * A turn driven by a routine carries a `routine_activate` (first turn) or
 * `routine_resume` (a later turn of the same routine) spine stage. The stage
 * outputs say which routine ran and whether it finished on this turn. We surface
 * just enough to mark the routine's span in the conversation thread — the rich
 * routine detail still lives in the spine stage view.
 */
export interface RoutineTurnSignal {
  routineId: string
  /** `false` for the activating turn, `true` for a resumed/continued turn. */
  resumed: boolean
  /** The routine reached a terminal step on this turn (state was cleared). */
  completed: boolean
}

/**
 * The clarification decision recorded on the turn, if any. The engine names the
 * decision: `asked` (it asked the user to choose), `offered`, `auto_picked`,
 * `suppressed`, or `none`. Used to call out "asked a clarifying question" as a
 * distinct turn outcome rather than a generic direct reply.
 */
export const clarificationDecisionFromSpine = (
  spine: ConversationTrace | undefined,
): string | undefined => {
  const stage = spine?.stages.find((candidate) => candidate.kind === 'clarification')
  if (!stage) {
    return undefined
  }
  const outputs = (stage.outputs ?? {}) as Record<string, unknown>
  return typeof outputs.decision === 'string' ? outputs.decision : undefined
}

export const routineTurnSignalFromSpine = (
  spine: ConversationTrace | undefined,
): RoutineTurnSignal | undefined => {
  if (!spine) {
    return undefined
  }
  const stage = spine.stages.find(
    (candidate) => candidate.kind === 'routine_activate' || candidate.kind === 'routine_resume',
  )
  if (!stage) {
    return undefined
  }
  const outputs = (stage.outputs ?? {}) as Record<string, unknown>
  const routineId = typeof outputs.routineId === 'string' ? outputs.routineId : undefined
  if (!routineId) {
    return undefined
  }
  return {
    routineId,
    resumed: stage.kind === 'routine_resume',
    completed: outputs.completed === true,
  }
}
