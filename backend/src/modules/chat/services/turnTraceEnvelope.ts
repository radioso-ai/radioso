import type {
  CapabilitySubTrace,
  ConversationTrace,
  ConversationTraceStage,
} from "@radioso/conversation-contract";

/**
 * Versioned envelope persisted per chat turn. The conversation spine is the root
 * span; each capability's domain trace hangs off its dispatch stage as an opaque
 * {@link CapabilitySubTrace}. Old turns persisted before this envelope are read
 * back as a synthesized legacy envelope (version 0) by the history read path.
 *
 * When to bump this number:
 *   This is a BREAKING-change generation marker, not a "changed the trace" counter.
 *   The spine is additive and readers are forward-compatible (unknown stage kinds,
 *   new `outputs` keys, and new capability leaf namespaces are tolerated), so those
 *   changes need NO bump. Bump ONLY when a persisted-shape change would make an
 *   existing reader misread old or new data (renamed/removed field, changed
 *   semantics) — and pair every bump with a matching branch in the history read
 *   path. A version no reader branches on is dead weight.
 *
 *   You should not have to remember this: the shape is pinned by a snapshot test,
 *   which fails on any change and forces the additive-vs-breaking decision.
 *
 *   Capability leaf payloads evolve independently via {@link CapabilitySubTrace.version},
 *   owned by each capability (e.g. retrieval bumps its own leaf, not this envelope).
 */
export const TURN_TRACE_ENVELOPE_VERSION = 1;

/**
 * Version stamped on envelopes synthesized while reading back turns persisted
 * before the envelope existed (legacy rows with only `activityTrace`). Marks the
 * spine as reconstructed, not engine-emitted, so renderers can treat it leniently.
 */
export const LEGACY_TURN_TRACE_ENVELOPE_VERSION = 0;

export interface TurnTraceEnvelope {
  version: number;
  spine: ConversationTrace;
  /**
   * Optional cross-cutting roll-up the presenter/quality layer can read without
   * walking the spine. Kept generic so this stays free of capability types.
   */
  summary?: Record<string, unknown>;
}

/**
 * Hang a capability's sub-trace on the spine's `dispatch:<skillName>` stage.
 * Returns a new spine (input is not mutated); no-ops when no stage matches.
 */
export const attachCapabilitySubTrace = (
  spine: ConversationTrace,
  attachment: { skillName: string; subTrace: CapabilitySubTrace },
): ConversationTrace => {
  const stageId = `dispatch:${attachment.skillName}`;
  let attached = false;
  const stages = spine.stages.map((stage) => {
    if (!attached && stage.id === stageId) {
      attached = true;
      return { ...stage, subTrace: attachment.subTrace };
    }
    return stage;
  });
  return attached ? { ...spine, stages } : spine;
};

/**
 * Build a minimal spine for a turn that did not run through the engine's
 * select/dispatch loop (e.g. a pre-engine intake turn, or an old persisted turn
 * read back without a spine). The single `dispatch:<skillName>` stage carries the
 * capability's sub-trace so the renderer treats it identically to an engine turn.
 */
export const synthesizeDispatchSpine = (input: {
  skillName: string;
  status?: ConversationTraceStage["status"];
  startedAt: string;
  completedAt?: string;
  subTrace?: CapabilitySubTrace;
}): ConversationTrace => ({
  traceId: `synthesized-turn-${input.startedAt}`,
  startedAt: input.startedAt,
  completedAt: input.completedAt ?? input.startedAt,
  stages: [
    {
      id: `dispatch:${input.skillName}`,
      kind: "skill_dispatch",
      status: input.status ?? "applied",
      ...(input.subTrace ? { subTrace: input.subTrace } : {}),
    },
  ],
});

export const buildTurnTraceEnvelope = (input: {
  spine: ConversationTrace;
  summary?: Record<string, unknown>;
  version?: number;
}): TurnTraceEnvelope => ({
  version: input.version ?? TURN_TRACE_ENVELOPE_VERSION,
  spine: input.spine,
  ...(input.summary ? { summary: input.summary } : {}),
});
