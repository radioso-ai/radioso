import type {
  ActivityTrace,
  ConversationTrace,
  ConversationTraceStage,
  TurnTraceEnvelope,
} from '@/lib/api'
import { getCapabilitySubTrace, resolveCapabilityLeaf, spineStageLabel } from '@/lib/turn-trace'

/**
 * Flattens a {@link TurnTraceEnvelope} into a single connected flow graph:
 * inputs (message, history, directives) fan into the engine, the engine selects
 * a skill, the skill's capability sub-trace streams out as its own path, leading
 * to the outcome. Pure and renderer-agnostic — React Flow consumes the result,
 * but the layout/draw layer owns no knowledge of the trace shape.
 *
 * Each capability contributes its own sub-flow by namespace (the same registry
 * boundary as the detail renderers), so the engine spine stays generic.
 */

export type FlowNodeKind = 'input' | 'engine' | 'skill' | 'stage' | 'outcome'
export type FlowStatus = ConversationTraceStage['status']
export type FlowEdgeKind = 'fan-in' | 'sequence' | 'branch' | 'converge'

/** How to resolve the detail pane when a node is selected. */
export type TurnFlowNodeDetail =
  | { kind: 'spine'; spineStageId: string }
  | { kind: 'leaf'; leafStageId: string }
  | { kind: 'none' }

export interface TurnFlowNode {
  id: string
  nodeKind: FlowNodeKind
  label: string
  sublabel?: string
  status?: FlowStatus
  /** Set on the skill node and every node belonging to its capability path. */
  capabilityNamespace?: string
  detail: TurnFlowNodeDetail
}

export interface TurnFlowEdge {
  id: string
  source: string
  target: string
  kind: FlowEdgeKind
}

export interface TurnFlowGraph {
  nodes: TurnFlowNode[]
  edges: TurnFlowEdge[]
}

const asString = (value: unknown): string | undefined =>
  typeof value === 'string' ? value : undefined

const prettySkill = (skillName: string): string =>
  skillName.split(/[._]/).slice(-1)[0]?.replace(/^\w/, (c) => c.toUpperCase()) ?? skillName

const titleCase = (value: string): string =>
  value
    .split(/[-_]/)
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join(' ')

const findStage = (spine: ConversationTrace, kind: string): ConversationTraceStage | undefined =>
  spine.stages.find((stage) => stage.kind === kind)

const selectionSummary = (stage: ConversationTraceStage): string | undefined => {
  const selected = (stage.outputs ?? {}).selectedSkills
  if (Array.isArray(selected) && selected.length) return selected.map(prettySkill).join(', ')
  return asString((stage.outputs ?? {}).reason)
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

const messageSummary = (stage: ConversationTraceStage): string | undefined => {
  // The trace carries only structural references (event id, length); the
  // actual message text lives on the conversation message record and is shown
  // when the user opens the Message node. A simple "N chars" sublabel keeps
  // the node informative without duplicating user input here.
  const length = (stage.outputs ?? {}).contentLength
  return typeof length === 'number' && length > 0 ? `${length} chars` : undefined
}

const clarificationSummary = (stage: ConversationTraceStage): string | undefined => {
  const outputs = stage.outputs ?? {}
  const decision = asString(outputs.decision)
  const reason = asString(outputs.reason)
  if (!decision) return undefined
  const summary = decision.replaceAll('_', ' ')
  if (decision === 'auto_picked' && reason === 'label_fallback') {
    return `${summary}: label fallback`
  }
  return summary
}

const clarificationStatus = (stage: ConversationTraceStage): FlowStatus => {
  const decision = asString((stage.outputs ?? {}).decision)
  return decision === 'offered' ? 'applied' : stage.status
}

const deriveOutcome = (
  spine: ConversationTrace,
  dispatch: ConversationTraceStage | undefined,
): { label?: string; status: FlowStatus } => {
  const dispatchStatus = asString(dispatch?.outputs?.outcomeStatus)
  if (dispatch?.status === 'failed') {
    return { label: dispatchStatus ?? 'failed', status: 'failed' }
  }
  return { label: dispatchStatus?.replaceAll('_', ' '), status: dispatch?.status ?? 'applied' }
}

const activityTraceSubFlow = (
  trace: ActivityTrace,
  namespace: string,
): { nodes: TurnFlowNode[]; edges: TurnFlowEdge[]; entryId?: string; terminalId?: string } => {
  const nodeId = (stageId: string) => `stage:${stageId}`
  const nodes: TurnFlowNode[] = trace.stages.map((stage) => ({
    id: nodeId(stage.stageId),
    nodeKind: 'stage',
    label: stage.label || stage.kind,
    status: stage.status,
    capabilityNamespace: namespace,
    detail: { kind: 'leaf', leafStageId: stage.stageId },
  }))

  const links = trace.links ?? []
  const edges: TurnFlowEdge[] = links.map((link, index) => ({
    id: `le:${link.fromStageId}->${link.toStageId}:${index}`,
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

export const activityTraceToFlowGraph = (
  trace: ActivityTrace,
  namespace = 'activity',
): TurnFlowGraph => {
  const nodes: TurnFlowNode[] = []
  const edges: TurnFlowEdge[] = []
  const sub = activityTraceSubFlow(trace, namespace)
  const firstStage = trace.stages[0]
  const terminalStage = sub.terminalId
    ? trace.stages.find((stage) => `stage:${stage.stageId}` === sub.terminalId)
    : trace.stages.at(-1)

  const skillId = 'skill'
  nodes.push({
    id: skillId,
    nodeKind: 'skill',
    label: titleCase(namespace),
    sublabel: 'activity trace',
    status: firstStage?.status,
    capabilityNamespace: namespace,
    detail: { kind: 'none' },
  })

  nodes.push(...sub.nodes)
  edges.push(...sub.edges)

  let tailId = skillId
  if (sub.entryId) {
    edges.push({ id: `e:${skillId}->${sub.entryId}`, source: skillId, target: sub.entryId, kind: 'sequence' })
  }
  if (sub.terminalId) tailId = sub.terminalId

  const outcomeId = 'outcome'
  nodes.push({
    id: outcomeId,
    nodeKind: 'outcome',
    label: 'Outcome',
    sublabel: terminalStage?.status,
    status: terminalStage?.status ?? firstStage?.status ?? 'unavailable',
    detail: terminalStage ? { kind: 'leaf', leafStageId: terminalStage.stageId } : { kind: 'none' },
  })
  edges.push({ id: `e:${tailId}->${outcomeId}`, source: tailId, target: outcomeId, kind: 'sequence' })

  return { nodes, edges }
}

export const envelopeToFlowGraph = (envelope: TurnTraceEnvelope): TurnFlowGraph => {
  const spine = envelope.spine
  const nodes: TurnFlowNode[] = []
  const edges: TurnFlowEdge[] = []

  const message = findStage(spine, 'message')
  const gather = findStage(spine, 'gather')
  // Normal turns trace directives as `directive_match` (before selection);
  // routine turns co-compose them at render time as `directive_steering`. Both
  // fan into the engine as the same Directives input.
  const directives = findStage(spine, 'directive_match') ?? findStage(spine, 'directive_steering')
  const selection = findStage(spine, 'skill_selection')
  const clarification = findStage(spine, 'clarification')
  const dispatch = spine.stages.find((stage) => stage.kind === 'skill_dispatch')
  const compose = findStage(spine, 'compose')
  const modelCalls = findStage(spine, 'model_calls')
  // Routine turns never run compose; their assistant reply is carried on the
  // routine stage itself, so fall back to it for the Outcome detail.
  const routine = spine.stages.find(
    (stage) => stage.kind === 'routine_resume' || stage.kind === 'routine_activate',
  )
  const outcomeDetailStage = compose ?? routine

  // Engine hub — the selection decision everything converges on.
  const engineId = 'engine'
  nodes.push({
    id: engineId,
    nodeKind: 'engine',
    label: 'Engine',
    sublabel: selection ? selectionSummary(selection) : undefined,
    status: selection?.status,
    detail: selection ? { kind: 'spine', spineStageId: selection.id } : { kind: 'none' },
  })

  // Inputs fan in.
  const addInput = (id: string, label: string, sublabel: string | undefined, detail: TurnFlowNodeDetail) => {
    nodes.push({ id, nodeKind: 'input', label, sublabel, detail })
    edges.push({ id: `fan:${id}`, source: id, target: engineId, kind: 'fan-in' })
  }
  addInput(
    'input:message',
    'Message',
    message ? messageSummary(message) : undefined,
    message ? { kind: 'spine', spineStageId: message.id } : { kind: 'none' },
  )
  const historyCount = gather && typeof gather.outputs?.historyCount === 'number' ? gather.outputs.historyCount : 0
  if (historyCount > 0 && gather) {
    addInput('input:history', 'History', `${historyCount} prior`, { kind: 'spine', spineStageId: gather.id })
  }
  if (directives) {
    addInput('input:directives', 'Directives', directiveSummary(directives), {
      kind: 'spine',
      spineStageId: directives.id,
    })
  }

  // Skill dispatch and its capability path.
  let tailId = engineId
  if (clarification) {
    const clarificationId = `spine:${clarification.id}`
    nodes.push({
      id: clarificationId,
      nodeKind: 'stage',
      label: spineStageLabel(clarification),
      sublabel: clarificationSummary(clarification),
      status: clarificationStatus(clarification),
      detail: { kind: 'spine', spineStageId: clarification.id },
    })
    edges.push({ id: `e:${tailId}->${clarificationId}`, source: tailId, target: clarificationId, kind: 'sequence' })
    tailId = clarificationId
  }
  if (dispatch) {
    const skillId = 'skill'
    const subTrace = getCapabilitySubTrace(dispatch)
    const leaf = subTrace ? resolveCapabilityLeaf(subTrace) : undefined
    const skillName = asString(dispatch.outputs?.skillName) ?? 'Skill'
    nodes.push({
      id: skillId,
      nodeKind: 'skill',
      label: leaf ? titleCase(leaf.namespace) : prettySkill(skillName),
      sublabel: skillName,
      status: dispatch.status,
      capabilityNamespace: leaf?.namespace,
      detail: { kind: 'spine', spineStageId: dispatch.id },
    })
    edges.push({ id: `e:${tailId}->skill`, source: tailId, target: skillId, kind: 'sequence' })
    tailId = skillId

    if (leaf?.kind === 'activity-trace') {
      const sub = activityTraceSubFlow(leaf.trace, leaf.namespace)
      nodes.push(...sub.nodes)
      edges.push(...sub.edges)
      if (sub.entryId) {
        edges.push({ id: `e:skill->${sub.entryId}`, source: skillId, target: sub.entryId, kind: 'sequence' })
      }
      if (sub.terminalId) tailId = sub.terminalId
    } else if (leaf?.kind === 'raw') {
      const rawId = `leaf:${leaf.namespace}`
      nodes.push({
        id: rawId,
        nodeKind: 'stage',
        label: leaf.namespace,
        capabilityNamespace: leaf.namespace,
        detail: { kind: 'none' },
      })
      edges.push({ id: `e:skill->${rawId}`, source: skillId, target: rawId, kind: 'sequence' })
      tailId = rawId
    }
  }

  if (modelCalls) {
    const modelCallsId = `spine:${modelCalls.id}`
    const callCount = typeof modelCalls.metrics?.llmCallCount === 'number'
      ? modelCalls.metrics.llmCallCount
      : undefined
    nodes.push({
      id: modelCallsId,
      nodeKind: 'stage',
      label: spineStageLabel(modelCalls),
      sublabel: callCount === undefined ? undefined : `${callCount} call${callCount === 1 ? '' : 's'}`,
      status: modelCalls.status,
      detail: { kind: 'spine', spineStageId: modelCalls.id },
    })
    edges.push({ id: `e:${tailId}->${modelCallsId}`, source: tailId, target: modelCallsId, kind: 'sequence' })
    tailId = modelCallsId
  }

  // Outcome.
  const outcomeId = 'outcome'
  const outcome = deriveOutcome(spine, dispatch)
  nodes.push({
    id: outcomeId,
    nodeKind: 'outcome',
    label: 'Outcome',
    sublabel: outcome.label,
    status: outcome.status,
    detail: outcomeDetailStage
      ? { kind: 'spine', spineStageId: outcomeDetailStage.id }
      : { kind: 'none' },
  })
  edges.push({ id: `e:${tailId}->outcome`, source: tailId, target: outcomeId, kind: 'sequence' })

  return { nodes, edges }
}
