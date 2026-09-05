import type {
  CapabilitySubTrace,
  ConversationTrace,
  ConversationTraceStage,
} from "@radioso/conversation-contract";
import { getActiveTraceCorrelation } from "../../../shared/observability/tracing/operations.js";
import type { ModelCallTraceCollector } from "../../../shared/observability/tracing/modelCallTraceContext.js";
import { attachModelCallsToSpine } from "./turnTraceModelCalls.js";
import { buildTurnTraceSummary } from "./turnTraceSummary.js";
import type { PageReadCapability, PageReadIntent } from "./pageRead/pageReadDecision.js";
import type { PageReadOutcome } from "./pageRead/pageReadSessionOutcome.js";

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
  openTelemetry?: TurnTraceOpenTelemetryCorrelation;
  /**
   * Optional cross-cutting roll-up the presenter/quality layer can read without
   * walking the spine. Kept generic so this stays free of capability types.
   */
  summary?: Record<string, unknown>;
}

export interface TurnTraceOpenTelemetryCorrelation {
  traceId: string;
  spanId: string;
  sampled: boolean;
}

export interface TurnTraceOpenTelemetryCorrelationReader {
  getActiveOpenTelemetryCorrelation(): TurnTraceOpenTelemetryCorrelation | undefined;
}

export interface PageReadTraceDiagnostic {
  schemaVersion: 1;
  available: boolean;
  required: boolean;
  requested: false;
  resolved: boolean;
  operation: PageReadIntent | null;
  outcome: "not_required" | "context_ready" | "unavailable" | "unsupported_operation";
}

export const buildPageReadTraceDiagnostic = (input: {
  capability: PageReadCapability;
  outcome: PageReadOutcome;
  resolved: boolean;
}): PageReadTraceDiagnostic => ({
  schemaVersion: 1,
  available: input.capability.available,
  required: input.outcome.merged.decision.required,
  requested: false,
  resolved: input.outcome.gate.kind === "capture" && input.resolved,
  operation: input.outcome.merged.decision.operation,
  outcome: input.outcome.gate.kind === "capture"
    ? "context_ready"
    : input.outcome.gate.kind,
});

const defaultOpenTelemetryCorrelationReader: TurnTraceOpenTelemetryCorrelationReader = {
  getActiveOpenTelemetryCorrelation: getActiveTraceCorrelation,
};

let openTelemetryCorrelationReader: TurnTraceOpenTelemetryCorrelationReader | undefined =
  defaultOpenTelemetryCorrelationReader;

const TRACE_ID_PATTERN = /^[0-9a-f]{32}$/;
const SPAN_ID_PATTERN = /^[0-9a-f]{16}$/;

export const setTurnTraceOpenTelemetryCorrelationReader = (
  reader: TurnTraceOpenTelemetryCorrelationReader | undefined,
): void => {
  openTelemetryCorrelationReader = reader;
};

const normalizeOpenTelemetryCorrelation = (
  value: TurnTraceOpenTelemetryCorrelation | undefined,
): TurnTraceOpenTelemetryCorrelation | undefined => {
  if (
    !value ||
    typeof value.traceId !== "string" ||
    !TRACE_ID_PATTERN.test(value.traceId) ||
    typeof value.spanId !== "string" ||
    !SPAN_ID_PATTERN.test(value.spanId) ||
    typeof value.sampled !== "boolean"
  ) {
    return undefined;
  }

  return {
    traceId: value.traceId,
    spanId: value.spanId,
    sampled: value.sampled,
  };
};

const readOpenTelemetryCorrelation = (): TurnTraceOpenTelemetryCorrelation | undefined => {
  try {
    return normalizeOpenTelemetryCorrelation(
      openTelemetryCorrelationReader?.getActiveOpenTelemetryCorrelation(),
    );
  } catch {
    return undefined;
  }
};

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

export interface SessionPreparationTimings {
  totalMs: number;
  /** Per-step wall clock, keyed by preparation step. Absent steps did not run. */
  steps: Record<string, number>;
}

/**
 * Give the spine's `gather` stage the duration of session preparation.
 *
 * Preparation runs before the engine opens the spine, so `gather` is emitted
 * zero-width and every pre-planner database round trip is invisible in the trace —
 * the wait shows up only as the gap between the request and the first status frame,
 * which is indistinguishable from network. These metrics are the only place that
 * gap is attributable. Counts and durations only; no query, message, or variable
 * content. Returns a new spine; no-ops when nothing was measured.
 */
export const attachPreparationTimingsToGather = (
  spine: ConversationTrace,
  timings: SessionPreparationTimings | undefined,
): ConversationTrace => {
  if (!timings || Object.keys(timings.steps).length === 0) {
    return spine;
  }
  const stepMetrics = Object.fromEntries(
    Object.entries(timings.steps).map(([step, ms]) => [
      `preparation${step.charAt(0).toUpperCase()}${step.slice(1)}Ms`,
      ms,
    ]),
  );
  let attached = false;
  const stages = spine.stages.map((stage) => {
    if (!attached && stage.kind === "gather") {
      attached = true;
      return {
        ...stage,
        metrics: {
          ...(stage.metrics ?? {}),
          preparationMs: timings.totalMs,
          ...stepMetrics,
        },
      };
    }
    return stage;
  });
  return attached ? { ...spine, stages } : spine;
};

/**
 * Surface resolved host variables and the content-free page-read diagnostic on
 * the spine's `gather` stage. Raw `page_context` stays only in assistant message
 * metadata and is always removed here. Returns a new spine (input is not mutated);
 * no-ops when there is no gather stage or no attachable output. The snapshot MUST
 * already be redacted (sensitive values masked) — pass `resolvedContext.snapshot`,
 * never the raw staged context.
 */
export const attachContextVariablesToGather = (
  spine: ConversationTrace,
  contextVariables: Record<string, unknown>,
  pageRead?: PageReadTraceDiagnostic,
): ConversationTrace => {
  const hostContextVariables = Object.fromEntries(
    Object.entries(contextVariables).filter(([key]) => key !== "page_context"),
  );
  const hasHostContextVariables = Object.keys(hostContextVariables).length > 0;
  if (!hasHostContextVariables && !pageRead) {
    return spine;
  }
  let attached = false;
  const stages = spine.stages.map((stage) => {
    if (!attached && stage.kind === "gather") {
      attached = true;
      return {
        ...stage,
        outputs: {
          ...(stage.outputs ?? {}),
          ...(hasHostContextVariables ? { contextVariables: hostContextVariables } : {}),
          ...(pageRead ? { pageRead } : {}),
        },
      };
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
  modelCallTrace?: ModelCallTraceCollector;
  completedAtMs?: number;
}): TurnTraceEnvelope => {
  const version = input.version ?? TURN_TRACE_ENVELOPE_VERSION;
  const openTelemetry = version >= TURN_TRACE_ENVELOPE_VERSION
    ? readOpenTelemetryCorrelation()
    : undefined;
  const spine = version >= TURN_TRACE_ENVELOPE_VERSION && input.modelCallTrace
    ? attachModelCallsToSpine(input.spine, input.modelCallTrace.calls)
    : input.spine;
  const summary = version >= TURN_TRACE_ENVELOPE_VERSION
    ? {
        ...(input.summary ?? {}),
        ...buildTurnTraceSummary(spine, input.modelCallTrace
          ? {
              totalLlmCalls: input.modelCallTrace.totalCallCount,
              serialLlmDepth: input.modelCallTrace.serialLlmDepth,
              totalModelTimeMs: input.modelCallTrace.totalModelTimeMs,
              totalTurnWallClockMs: Math.max(
                0,
                (input.completedAtMs ?? Date.now()) - input.modelCallTrace.startedAtMs,
              ),
              droppedCallCount: input.modelCallTrace.droppedCallCount,
            }
          : undefined),
      }
    : undefined;

  return {
    version,
    spine,
    ...(openTelemetry ? { openTelemetry } : {}),
    ...(summary ? { summary } : {}),
  };
};
