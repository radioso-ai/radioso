import type {
  ConversationRoutineActivator,
  ConversationRoutineReentryGate,
  ConversationRoutineSlotCorrection,
  ConversationTurnInterpretation,
  ConversationTurnInterpreter,
  Directive,
  DirectiveClassification,
  TurnContext,
} from "@radioso/conversation-contract";
import type {
  PreparedRoutineCandidates,
  RankableRoutineCandidates,
  RankedRoutineMatch,
  RoutineActivationResult,
} from "@radioso/conversation-defaults";

import { CHAT_BEHAVIOR } from "../../../shared/domain/behaviorConfig.js";
import type { ModelCallUsageContext } from "../../../shared/domain/modelCallUsageContext.js";
import type { LlmCapabilityResolveInput } from "../../../shared/infra/llm/workspaceContext.js";
import type { MessageRecord } from "../../../db/repositories/messageRepository.js";
import type { AppLogger } from "../../../shared/observability/logger.js";
import type { MetricsRegistry } from "../../../shared/observability/metrics/metricsRegistry.js";
import { setTraceAttributes } from "../../../shared/observability/tracing/operations.js";
import type { PageReadCapability } from "./pageRead/pageReadDecision.js";
import {
  estimateTurnPlanningPromptTokens,
  TurnPlanService,
  turnPlanDirectiveClassifications,
  type TurnPlan,
  type TurnPlanDirectiveCandidate,
} from "./turnPlanService.js";

/** Why a turn never ran the fused planner (recorded for observability). */
export type TurnPlanBypassReason =
  | "active_routine"
  | "pending_clarification"
  | "suspended_routine"
  | "routine_claim"
  | "routine_candidates_over_bound"
  | "directive_candidates_over_bound"
  | "prompt_tokens_over_budget";

/** Why a planner call produced no usable plan (adapters fall back). */
export type TurnPlanFailureReason = "invalid_or_error";

/**
 * The per-turn plan outcome, memoized on the session. `planned` carries the plan
 * plus the SAME rankable routine candidates sent to the planner, so the routine
 * activator applies the precomputed rankings to the identical prepared set.
 * `bypassed`/`failed` mean every adapter takes its staged fallback — the staged
 * path is all-or-nothing per turn (never a planner/staged mix).
 */
export type TurnPlanOutcome =
  | { status: "planned"; plan: TurnPlan; prepared: RankableRoutineCandidates | null }
  | { status: "bypassed"; reason: TurnPlanBypassReason }
  | { status: "failed"; reason: TurnPlanFailureReason };

/**
 * The lazy, memoized per-turn plan handle that rides on the session. Computation
 * starts on the FIRST `resolve` call and every later consumer awaits the same
 * promise. The routine activator adapter is the earliest consumer in the engine
 * schedule; it supplies the prepared routine candidates the planner ranks. Later
 * consumers (interpreter, response language, directive matcher) pass `null` —
 * by then the computation has already started, so their argument is ignored.
 * `bypass` pins a bypassed outcome if nothing has started yet (used by the
 * routine-claim short-circuit, where the routine owns the turn and planning the
 * route/language/directives for a normal answer would be wasted work).
 */
export interface ChatTurnPlanHandle {
  resolve(routinePreparation: RankableRoutineCandidates | null): Promise<TurnPlanOutcome>;
  bypass(reason: TurnPlanBypassReason): void;
}

export const createTurnPlanHandle = (
  compute: (routinePreparation: RankableRoutineCandidates | null) => Promise<TurnPlanOutcome>,
  onPinnedBypass?: (reason: TurnPlanBypassReason) => void,
): ChatTurnPlanHandle => {
  let memo: Promise<TurnPlanOutcome> | undefined;
  return {
    resolve(routinePreparation) {
      memo ??= compute(routinePreparation);
      return memo;
    },
    bypass(reason) {
      if (!memo) {
        onPinnedBypass?.(reason);
        memo = Promise.resolve({ status: "bypassed", reason });
      }
    },
  };
};

/**
 * A Promise-shaped thenable whose computation starts on first consumption. Used
 * for the response-language promise on planned turns: creating it must not start
 * the plan (the routine activator, which supplies the routine candidates, has to
 * be the first resolver), but any consumer that awaits it still triggers exactly
 * one computation.
 */
export const lazyPromise = <T>(compute: () => Promise<T>): Promise<T> => {
  let inner: Promise<T> | undefined;
  const ensure = (): Promise<T> => {
    inner ??= compute();
    return inner;
  };
  const thenable = {
    then: <TResult1 = T, TResult2 = never>(
      onfulfilled?: ((value: T) => TResult1 | PromiseLike<TResult1>) | null,
      onrejected?: ((reason: unknown) => TResult2 | PromiseLike<TResult2>) | null,
    ) => ensure().then(onfulfilled, onrejected),
    catch: <TResult = never>(onrejected?: ((reason: unknown) => TResult | PromiseLike<TResult>) | null) =>
      ensure().catch(onrejected),
    finally: (onfinally?: (() => void) | null) => ensure().finally(onfinally),
    [Symbol.toStringTag]: "Promise",
  };
  return thenable as Promise<T>;
};

export interface TurnPlanInputs {
  query: string;
  history: MessageRecord[];
  semanticRewriteInstructions?: string;
  lexicalRewriteInstructions?: string;
  conversationSummary?: string;
  pageReadCapability?: PageReadCapability | null;
  /**
   * The owning module's prepared routine candidates for this turn (already
   * suppression/prefilter-bounded), or `null` when no routines are registered or
   * none survived preparation.
   */
  routinePreparation: PreparedRoutineCandidates | null;
  /** Union-of-routes contextual directive candidates (name + condition). */
  directiveCandidates: readonly TurnPlanDirectiveCandidate[];
  workspaceContext: LlmCapabilityResolveInput;
  usageContext: ModelCallUsageContext;
  signal?: AbortSignal;
}

/**
 * Builds and resolves the fused turn plan. Owns the fast-path eligibility bounds
 * (candidate counts, prompt-token budget) and the claim short-circuit; it does
 * NOT own the pre-engine bypass signals (active routine, pending clarification,
 * suspended routine) — {@link startTurnPlan} checks those from state the host
 * already has and simply never creates a handle. No new DB or model work exists
 * for bypass detection.
 */
export class TurnPlanCoordinator {
  private readonly bounds = CHAT_BEHAVIOR.turnPlanning;

  constructor(
    private readonly service: TurnPlanService,
    private readonly logger?: AppLogger,
    private readonly metrics?: Pick<MetricsRegistry, "incrementCounter" | "observeHistogram"> | null,
  ) {}

  async plan(input: TurnPlanInputs): Promise<TurnPlanOutcome> {
    const startedAt = Date.now();
    const outcome = await this.computePlan(input);
    this.recordOutcome(input, outcome, Date.now() - startedAt);
    return outcome;
  }

  /** Records a host-known bypass without forcing lazy plan-input assembly. */
  recordBypass(reason: TurnPlanBypassReason): void {
    this.recordOutcome(undefined, { status: "bypassed", reason }, 0);
  }

  private async computePlan(input: TurnPlanInputs): Promise<TurnPlanOutcome> {
    // A routine explicitly claims the turn — activate directly, no planner (the
    // turn is owned by the routine, so route/language/directive planning is moot).
    if (input.routinePreparation && input.routinePreparation.kind === "claim") {
      return { status: "bypassed", reason: "routine_claim" };
    }
    const prepared: RankableRoutineCandidates | null =
      input.routinePreparation && input.routinePreparation.kind === "rank"
        ? input.routinePreparation
        : null;

    if (prepared && prepared.candidates.length > this.bounds.maxRoutineCandidates) {
      return { status: "bypassed", reason: "routine_candidates_over_bound" };
    }
    if (input.directiveCandidates.length > this.bounds.maxDirectiveCandidates) {
      return { status: "bypassed", reason: "directive_candidates_over_bound" };
    }
    const request = {
      query: input.query,
      history: input.history.slice(-this.bounds.historyTailMessages),
      semanticRewriteInstructions: input.semanticRewriteInstructions,
      lexicalRewriteInstructions: input.lexicalRewriteInstructions,
      conversationSummary: input.conversationSummary,
      pageReadCapability: input.pageReadCapability,
      routineCandidates: prepared ? prepared.candidates : [],
      directiveCandidates: input.directiveCandidates,
      workspaceContext: input.workspaceContext,
      usageContext: input.usageContext,
      signal: input.signal,
    };
    if (estimateTurnPlanningPromptTokens(request) > this.bounds.maxEstimatedPromptTokens) {
      return { status: "bypassed", reason: "prompt_tokens_over_budget" };
    }

    if (input.signal?.aborted) {
      throw input.signal.reason ?? new Error("chat_turn_aborted");
    }

    const plan = await this.service.plan(request);
    // An external turn cancellation is not a planner failure. Propagate it so the
    // host stops the turn instead of starting the four staged fallback calls after
    // the planner request was aborted.
    if (input.signal?.aborted) {
      throw input.signal.reason ?? new Error("chat_turn_aborted");
    }
    if (!plan) {
      return { status: "failed", reason: "invalid_or_error" };
    }
    return { status: "planned", plan, prepared };
  }

  private recordOutcome(input: TurnPlanInputs | undefined, outcome: TurnPlanOutcome, latencyMs: number): void {
    const metricOutcome = outcome.status === "planned"
      ? "fastpath"
      : outcome.status === "bypassed"
        ? "bypass"
        : "fallback";
    const metricLabels = {
      outcome: metricOutcome,
      ...(outcome.status === "planned" ? {} : { reason: outcome.reason }),
    };
    this.metrics?.incrementCounter("chat_turn_planning_outcomes_total", {
      help: "Fused turn-planning outcomes by fast path, fallback, or bypass reason.",
      labels: metricLabels,
    });
    if (outcome.status !== "bypassed") {
      this.metrics?.observeHistogram("chat_turn_planning_latency_ms", {
        help: "Latency of fused turn-planning attempts in milliseconds.",
        labels: { outcome: metricOutcome },
        value: latencyMs,
      });
    }

    const routineCandidateCount =
      input?.routinePreparation && input.routinePreparation.kind === "rank"
        ? input.routinePreparation.candidates.length
        : 0;
    this.logger?.info(
      {
        outcome: metricOutcome,
        reason: outcome.status === "planned" ? undefined : outcome.reason,
        latencyMs,
        routineCandidateCount,
        directiveCandidateCount: input?.directiveCandidates.length ?? 0,
      },
      "chat.turn_planning.outcome",
    );
  }
}

/**
 * Shared host entry point (live chat + workbench replay run the identical
 * schedule through it): create the lazy plan handle for a turn, or return
 * `undefined` (all consumers staged) when the coordinator is absent or a
 * pre-engine bypass signal holds — an active routine, a
 * pending clarification/decision being resolved this turn, or a parked
 * (suspended) routine. Those states are read from what the host already loaded;
 * bypass detection never adds model or DB work. Slot-correction turns cannot be
 * distinguished pre-engine (detection is a model call inside the routine
 * machinery), but they only occur when a completed routine exists for the
 * session, which the activator path resolves against the same handle — a
 * correction turn simply falls out as a claim/normal decision there.
 */
export const startTurnPlan = (input: {
  coordinator: TurnPlanCoordinator | undefined;
  bypass: { activeRoutine?: boolean; pendingClarification?: boolean; suspendedRoutine?: boolean };
  /**
   * Thunk so plan-input assembly (directive candidate collection, scope-reference
   * rendering) runs only when a consumer actually resolves the handle — never on
   * gated-off or bypassed turns, where this function returns before planning.
   */
  plan: () => Omit<TurnPlanInputs, "routinePreparation">;
}): ChatTurnPlanHandle | undefined => {
  const { coordinator } = input;
  if (!coordinator) {
    return undefined;
  }
  const stateBypassReason = input.bypass.activeRoutine
    ? "active_routine"
    : input.bypass.pendingClarification
      ? "pending_clarification"
      : input.bypass.suspendedRoutine
        ? "suspended_routine"
        : undefined;
  if (stateBypassReason) {
    coordinator.recordBypass(stateBypassReason);
    return undefined;
  }
  return createTurnPlanHandle(
    (routinePreparation) => coordinator.plan({ ...input.plan(), routinePreparation }),
    (reason) => coordinator.recordBypass(reason),
  );
};

const ROUTE_SCOPED_DIRECTIVE_PREFIX = "route:";

const routeScopedDirectiveCandidateName = (route: string, name: string): string =>
  `${ROUTE_SCOPED_DIRECTIVE_PREFIX}${JSON.stringify([route, name])}`;

const parseRouteScopedDirectiveCandidateName = (
  candidateName: string,
): { route: string; name: string } | null => {
  if (!candidateName.startsWith(ROUTE_SCOPED_DIRECTIVE_PREFIX)) {
    return null;
  }
  try {
    const parsed = JSON.parse(candidateName.slice(ROUTE_SCOPED_DIRECTIVE_PREFIX.length));
    return Array.isArray(parsed)
      && parsed.length === 2
      && typeof parsed[0] === "string"
      && typeof parsed[1] === "string"
      ? { route: parsed[0], name: parsed[1] }
      : null;
  } catch {
    return null;
  }
};

/**
 * The union-of-routes contextual directive candidate set for the planner. The
 * planner-facing name is an opaque route-scoped identity, so unrelated
 * directives may safely reuse a display name on different routes. Lifecycle
 * narrowing and steering policy remain owned by the directive runtime.
 */
export const contextualDirectiveCandidates = (input: {
  routes: Iterable<string>;
  directivesForRoute: (route: string) => Directive[];
}): TurnPlanDirectiveCandidate[] => {
  const entriesByName = new Map<string, Array<{ route: string; condition: string }>>();
  for (const route of new Set(input.routes)) {
    for (const directive of input.directivesForRoute(route)) {
      if (directive.condition.kind === "contextual") {
        const entries = entriesByName.get(directive.name) ?? [];
        entries.push({ route, condition: directive.condition.description });
        entriesByName.set(directive.name, entries);
      }
    }
  }
  const candidates: TurnPlanDirectiveCandidate[] = [];
  for (const [name, entries] of entriesByName) {
    if (new Set(entries.map((entry) => entry.condition)).size === 1) {
      candidates.push({ name, condition: entries[0]!.condition });
      continue;
    }
    const byIdentity = new Map<string, TurnPlanDirectiveCandidate>();
    for (const entry of entries) {
      const identity = routeScopedDirectiveCandidateName(entry.route, name);
      byIdentity.set(identity, { name: identity, condition: entry.condition });
    }
    candidates.push(...byIdentity.values());
  }
  return candidates;
};

const rankedMatchesFromPlan = (plan: TurnPlan): RankedRoutineMatch[] =>
  plan.routineRankings.map((ranking) => ({
    routineId: ranking.routineId,
    confidence: ranking.confidence,
    ...(ranking.variables ? { variables: ranking.variables } : {}),
  }));

type PlanHandle = () => Promise<TurnPlanOutcome> | undefined;

/** The RoutineRegistry seams the plan-aware activator consumes (no policy leaks). */
export interface PlanAwareRoutineRegistrySeams {
  prepareCandidates(
    turn: TurnContext,
    options?: { suppressedRoutineIds?: readonly string[] },
  ): Promise<PreparedRoutineCandidates>;
  applyRankedDecision(
    prepared: RankableRoutineCandidates,
    rankings: readonly RankedRoutineMatch[],
    options: { turn: TurnContext; loopGuardCandidateIds?: string[]; suppressClarificationAsk?: boolean },
  ): Promise<RoutineActivationResult | null>;
}

/**
 * A routine activator that prepares candidates once through the owning module's
 * seam, feeds them to the shared plan (it is the earliest consumer, so its
 * preparation is what the planner ranks), and applies the plan's precomputed
 * rankings via `applyRankedDecision`. Claims short-circuit exactly as staged and
 * pin the plan bypassed. On a bypassed/failed plan it falls back to the staged
 * ranked-activation activator — which re-runs `prepareCandidates` internally (an
 * accepted, once-per-failed-plan duplication of the embedding prefilter; the
 * decision itself is identical because both paths run the same seams).
 */
export const planAwareRoutineActivator = (deps: {
  handle: ChatTurnPlanHandle | undefined;
  registry: PlanAwareRoutineRegistrySeams;
  fallback: ConversationRoutineActivator;
}): ConversationRoutineActivator => ({
  async activate(activateInput) {
    const { handle } = deps;
    if (!handle) {
      return deps.fallback.activate(activateInput);
    }
    const prepared = await deps.registry.prepareCandidates(activateInput.turn, {
      suppressedRoutineIds: activateInput.suppressedRoutineIds,
    });
    if (prepared.kind === "claim") {
      handle.bypass("routine_claim");
      return prepared.activation;
    }
    if (prepared.kind === "none") {
      // No rankable routine candidates: no routine activates (as staged). The
      // planner may still run for route/language/directives when the next
      // consumer resolves the handle with a null preparation.
      return null;
    }
    const outcome = await handle.resolve(prepared);
    if (outcome.status === "planned" && outcome.prepared) {
      return deps.registry.applyRankedDecision(outcome.prepared, rankedMatchesFromPlan(outcome.plan), {
        turn: activateInput.turn,
        ...(activateInput.loopGuardCandidateIds
          ? { loopGuardCandidateIds: activateInput.loopGuardCandidateIds }
          : {}),
        ...(activateInput.suppressClarificationAsk
          ? { suppressClarificationAsk: activateInput.suppressClarificationAsk }
          : {}),
      });
    }
    return deps.fallback.activate(activateInput);
  },
});

/**
 * Completed-routine correction is an engine interceptor that runs before fresh
 * activation. Pin the shared plan as bypassed only once the interceptor has
 * accepted a correction and is about to render its terminal reply; a detection
 * that falls through can still use normal fused planning.
 */
export const planAwareRoutineSlotCorrection = (deps: {
  handle: ChatTurnPlanHandle | undefined;
  fallback: ConversationRoutineSlotCorrection;
}): ConversationRoutineSlotCorrection => ({
  detect: (input) => deps.fallback.detect(input),
  confirm: (input) => {
    deps.handle?.bypass("routine_claim");
    return deps.fallback.confirm(input);
  },
  rejectInvalid: (input) => {
    deps.handle?.bypass("routine_claim");
    return deps.fallback.rejectInvalid(input);
  },
});

/**
 * Semantic reentry also intercepts before fresh activation. A suppress decision
 * falls through and leaves planning eligible; either claiming decision pins the
 * plan before the routine runner can consume language or directive adapters.
 */
export const planAwareRoutineReentryGate = (deps: {
  handle: ChatTurnPlanHandle | undefined;
  fallback: ConversationRoutineReentryGate;
}): ConversationRoutineReentryGate => ({
  async decide(input) {
    const decision = await deps.fallback.decide(input);
    if (decision.kind !== "suppress") {
      deps.handle?.bypass("routine_claim");
    }
    return decision;
  },
});

/**
 * A turn interpreter that sources route + rewrite framing from the plan, marking
 * the interpretation `source: "planned"` so traces distinguish the fast path.
 * Falls back to the staged structured interpretation when the plan is absent.
 */
export const planAwareTurnInterpreter = (deps: {
  handle: PlanHandle;
  fallback: ConversationTurnInterpreter;
}): ConversationTurnInterpreter => ({
  async interpret(interpretInput) {
    const outcome = await deps.handle();
    if (!outcome || outcome.status !== "planned") {
      return deps.fallback.interpret(interpretInput);
    }
    const interpretation: ConversationTurnInterpretation = {
      route: outcome.plan.route,
      interactionRole: outcome.plan.interactionRole,
      framing: outcome.plan.framing,
      metadata: {
        source: "planned",
        ...(outcome.plan.rewriteProposal ? { rewriteProposal: outcome.plan.rewriteProposal } : {}),
      },
    };
    return interpretation;
  },
});

/**
 * Resolve the turn's response language from the plan when planned, keeping the
 * `chat.response.language` trace attribute the detector would have set; otherwise
 * await the staged detector promise.
 */
export const planAwareResponseLanguage = async (deps: {
  handle: PlanHandle;
  fallback: () => Promise<string | undefined>;
}): Promise<string | undefined> => {
  const outcome = await deps.handle();
  if (!outcome || outcome.status !== "planned") {
    return deps.fallback();
  }
  setTraceAttributes({ "chat.response.language": outcome.plan.responseLanguage });
  return outcome.plan.responseLanguage;
};

/**
 * The plan's contextual directive classifications when planned, else `null` so
 * the directive matcher runs its staged gateway call. Route-scoped planner
 * identities are narrowed to the resolved route and translated back to the
 * directive names consumed by the runtime.
 */
export const planAwareDirectiveClassifications = async (
  handle: PlanHandle,
  route?: string,
): Promise<DirectiveClassification[] | null> => {
  const outcome = await handle();
  if (!outcome || outcome.status !== "planned") {
    return null;
  }
  const classifications = turnPlanDirectiveClassifications(outcome.plan);
  if (route === undefined) {
    return classifications;
  }
  return classifications.flatMap((classification) => {
    const identity = parseRouteScopedDirectiveCandidateName(classification.name);
    if (!identity) {
      return [classification];
    }
    return identity.route === route
      ? [{ name: identity.name, confidence: classification.confidence }]
      : [];
  });
};
