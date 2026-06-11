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
  skill_selection: 'Select skill',
  skill_dispatch: 'Dispatch',
  compose: 'Compose',
  routine_resume: 'Routine',
  routine_activate: 'Routine',
  clarification: 'Clarification',
}

export const spineStageLabel = (stage: ConversationTraceStage): string =>
  SPINE_STAGE_LABELS[stage.kind] ?? stage.kind.replaceAll('_', ' ')

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
