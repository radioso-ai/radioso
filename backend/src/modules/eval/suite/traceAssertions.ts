import type { RoutineRunTrace } from "@radioso/conversation-contract";

import type { AssertionVerdictStatus, EvalRunObservedOutput } from "../domain/types.js";
import type { ConversationQualityObservedOutput } from "./observedOutput.js";

/**
 * Trace assertions read structured signal out of a turn's {@link EvalRunObservedOutput}
 * (its `turnTrace` spine and grounding summary) rather than the prose answer. They are
 * the deterministic, LLM-free half of the conversation-quality suite: which route was
 * classified, which skill produced the answer, whether a routine claimed the turn and
 * how far it advanced, whether the turn asked a clarifying question, the grounding
 * verdict, whether the answer came from the composer or the turn planner's own reply,
 * and whether it committed to a directive before writing. A review turn carries no
 * trace, so its coverage verdict and the replies it persisted are read from its review
 * observation instead. Because they never call a model
 * they are cheap and stable enough to gate on every run.
 *
 * They live in the suite's own union — NOT the shipped product `EvalAssertion` union —
 * so the dashboard/API contract for operator-authored eval cases stays unchanged.
 */
export type SuiteTraceAssertion =
  | { type: "turn_route"; route: "retrieval" | "direct" }
  | { type: "turn_uses_skill"; skillName: string }
  /** No turn skill and no routine step dispatched the skill: the negation of `turn_uses_skill`. */
  | { type: "turn_skips_skill"; skillName: string }
  | { type: "turn_activates_routine"; routineId: string }
  | { type: "routine_step_reached"; routineId: string; stepId: string }
  /** Every named slot is filled after the turn, whichever step the routine landed on. */
  | { type: "routine_slots_filled"; routineId: string; slotKeys: string[] }
  /** None of the named slots holds a value after the turn: the negation of `routine_slots_filled`. */
  | { type: "routine_slots_unfilled"; routineId: string; slotKeys: string[] }
  /**
   * The next-step selector returned a value for every named slot this turn, on any step. Unlike
   * `routine_slots_filled`, it tells a replaced value from one the slot already held.
   */
  | { type: "routine_slots_returned"; routineId: string; slotKeys: string[] }
  /** The selector returned a value for none of the named slots this turn: the negation of `routine_slots_returned`. */
  | { type: "routine_slots_not_returned"; routineId: string; slotKeys: string[] }
  /** The active routine yielded the turn to a normal answer and stays parked on `stepId`. */
  | { type: "routine_yielded"; routineId: string; stepId: string }
  | { type: "turn_asks_clarification" }
  | { type: "turn_grounding_verdict"; verdict: "grounded" | "degraded" | "no_support" }
  | { type: "turn_answer_coverage"; coverage: "answered" | "partial" | "unanswered" | "unclear" }
  /** A review turn wrote no assistant message: its reply stayed a draft. */
  | { type: "turn_persists_no_reply" }
  /**
   * Who wrote the turn's answer: `turn_planning` when the planner's quick reply was sent
   * (the compose stage records that source and ran no model call), `composer` when an
   * answer composer wrote it.
   */
  | { type: "turn_reply_source"; source: "turn_planning" | "composer" }
  /**
   * The answer committed to what `directive` requires before it wrote the answer, and
   * graded itself against it after: the compose stage's adherence entry for it carries a
   * commitment. It says the directive was weighed, not that it was followed; pair it with
   * an assertion on the answer itself.
   */
  | { type: "turn_directive_committed"; directive: string }
  /**
   * Whether the voice turn policy spoke a bridge line before the turn's own speech. A voice
   * assertion's `deterministicOnly` keeps it out of a live run's gate: see
   * {@link withDefinedVoiceScope} for the ones that carry it by definition.
   */
  | { type: "voice_bridge_emitted"; expected: boolean; deterministicOnly?: boolean }
  /** Whether the voice turn policy's limit ended the turn with the fallback line. Always deterministic-only. */
  | { type: "voice_turn_limit_reached"; expected: boolean; deterministicOnly?: boolean }
  /**
   * The outcome the voice turn closed with, the kind the runtime received. It gates a live run
   * unless the case marks it `deterministicOnly`, as one does whose outcome only means something
   * beside an expectation a live run cannot check.
   */
  | { type: "voice_turn_outcome"; kind: "continue" | "callback_requested"; deterministicOnly?: boolean };

/**
 * Marks the voice expectations only the brain's speed decides as deterministic-only. "No bridge"
 * holds live only while the planner answers inside the stall bridge (`VOICE_BEHAVIOR.bridgeAfterMs`,
 * 2.5 s) and the composer inside the composing-idle bridge (400 ms). The turn limit
 * (`turnLimitMs`, 10 s) fires live on any slow but healthy turn and on no question on demand, so
 * neither "it fired" nor "it did not" is a behaviour fact there. The deterministic half scripts the
 * brain, so it asserts both for real.
 */
export const withDefinedVoiceScope = <Assertion extends { type: string }>(assertion: Assertion): Assertion =>
  isDeterministicOnlyByDefinition(assertion) ? { ...assertion, deterministicOnly: true } : assertion;

/** Whether an assertion is deterministic-only by its definition, whatever the case says (see {@link withDefinedVoiceScope}). */
export const isDeterministicOnlyByDefinition = (assertion: { type: string }): boolean => {
  const voice = assertion as { type: string; expected?: boolean };
  return voice.type === "voice_turn_limit_reached" || (voice.type === "voice_bridge_emitted" && voice.expected === false);
};

/** Whether an assertion stays out of a live run's gate, by its definition or its case's marking. */
export const isDeterministicOnlyAssertion = (assertion: { type: string }): boolean =>
  "deterministicOnly" in assertion && assertion.deterministicOnly === true;

const TRACE_ASSERTION_TYPES = new Set<string>([
  "turn_route",
  "turn_uses_skill",
  "turn_skips_skill",
  "turn_activates_routine",
  "routine_step_reached",
  "routine_slots_filled",
  "routine_slots_unfilled",
  "routine_slots_returned",
  "routine_slots_not_returned",
  "routine_yielded",
  "turn_asks_clarification",
  "turn_grounding_verdict",
  "turn_answer_coverage",
  "turn_persists_no_reply",
  "turn_reply_source",
  "turn_directive_committed",
  "voice_bridge_emitted",
  "voice_turn_limit_reached",
  "voice_turn_outcome",
]);

export const isTraceAssertion = (assertion: { type: string }): assertion is SuiteTraceAssertion =>
  TRACE_ASSERTION_TYPES.has(assertion.type);

interface SuiteTraceAssertionVerdict {
  assertion: SuiteTraceAssertion;
  status: AssertionVerdictStatus;
  reason: string | null;
}

type TraceStage = NonNullable<
  NonNullable<EvalRunObservedOutput["turnTrace"]>["spine"]
>["stages"][number];

const stages = (output: EvalRunObservedOutput): TraceStage[] =>
  output.turnTrace?.spine?.stages ?? [];

const readString = (record: Record<string, unknown> | undefined, key: string): string | undefined => {
  const value = record?.[key];
  return typeof value === "string" ? value : undefined;
};

const pass = (assertion: SuiteTraceAssertion, reason: string): SuiteTraceAssertionVerdict => ({
  assertion,
  status: "pass",
  reason,
});

const fail = (assertion: SuiteTraceAssertion, reason: string): SuiteTraceAssertionVerdict => ({
  assertion,
  status: "fail",
  reason,
});

const missingTrace = (assertion: SuiteTraceAssertion): SuiteTraceAssertionVerdict => ({
  assertion,
  status: "error",
  reason: "No turnTrace was captured for this run, so trace assertions cannot be evaluated.",
});

const missingVoiceObservation = (assertion: SuiteTraceAssertion): SuiteTraceAssertionVerdict => ({
  assertion,
  status: "error",
  reason: "No voice turn was observed for this run; run the case through a voice runner port.",
});

const observedRoutes = (output: EvalRunObservedOutput): string[] =>
  stages(output)
    .map((stage) => readString(stage.outputs, "route"))
    .filter((route): route is string => typeof route === "string");

const routineStages = (output: EvalRunObservedOutput, routineId: string): TraceStage[] =>
  stages(output).filter(
    (stage) =>
      (stage.kind === "routine_activate" || stage.kind === "routine_resume") &&
      (readString(stage.outputs, "routineId") === routineId || stage.id === `routine:${routineId}`),
  );

/**
 * The sink stashes a second, minimal stage (`{ reason: "already_reported" }`,
 * no `availability`) when a skill reports twice in one turn — skip it, the
 * same way the debug-view reader (`answerCoverageFromTurnTrace`) does.
 */
const answerCoverageHeadStage = (output: EvalRunObservedOutput): TraceStage | undefined =>
  stages(output).find(
    (stage) => stage.kind === "answer_coverage_head" && typeof readString(stage.outputs, "availability") === "string",
  );

/**
 * The coverage verdict the turn recorded, and where it was read: a review turn's own facts,
 * or a live turn's `answer_coverage_head` stage. `undefined` when a live turn captured no trace.
 */
const observedCoverage = (
  output: ConversationQualityObservedOutput,
): { source: string; availability?: string; coverage?: string } | undefined => {
  if (output.reviewTurn) {
    return {
      source: "Review turn facts",
      availability: output.reviewTurn.answerCoverage?.availability,
      coverage: output.reviewTurn.answerCoverage?.coverage,
    };
  }
  if (!output.turnTrace) {
    return undefined;
  }
  const stage = answerCoverageHeadStage(output);
  return {
    source: "Turn trace",
    availability: stage ? readString(stage.outputs, "availability") : undefined,
    coverage: stage ? readString(stage.outputs, "coverage") : undefined,
  };
};

/** Who wrote the answer, read from the compose stage; `undefined` when nothing was composed. */
const observedReplySource = (output: EvalRunObservedOutput): "turn_planning" | "composer" | undefined => {
  const compose = stages(output).find((stage) => stage.kind === "compose");
  if (!compose) {
    return undefined;
  }
  return readString(compose.outputs, "source") === "turn_planning" ? "turn_planning" : "composer";
};

/** The compose stage's record of one directive: its graded entry, or whether it was left ungraded. */
const observedDirectiveAdherence = (
  output: EvalRunObservedOutput,
  directive: string,
): { composed: boolean; commitment?: string; graded: boolean; ungraded: boolean } => {
  const compose = stages(output).find((stage) => stage.kind === "compose");
  const adherence = compose?.outputs?.adherence;
  const entry = (Array.isArray(adherence) ? adherence : []).find(
    (candidate): candidate is Record<string, unknown> =>
      typeof candidate === "object" && candidate !== null && (candidate as Record<string, unknown>).directive === directive,
  );
  const ungraded = compose?.outputs?.ungradedDirectives;
  return {
    composed: compose !== undefined,
    ...(typeof entry?.commitment === "string" && entry.commitment ? { commitment: entry.commitment } : {}),
    graded: entry !== undefined,
    ungraded: Array.isArray(ungraded) && ungraded.includes(directive),
  };
};

const routineTrace = (stage: TraceStage): RoutineRunTrace | undefined => {
  const sub = stage.subTrace;
  if (!sub || sub.namespace !== "routine") {
    return undefined;
  }
  return sub.payload as RoutineRunTrace;
};

type RoutineSlotKeysAssertion = Extract<
  SuiteTraceAssertion,
  { type: "routine_slots_filled" | "routine_slots_unfilled" | "routine_slots_returned" | "routine_slots_not_returned" }
>;

/**
 * The routine's slot keys this turn, from every matching stage's routine subtrace: the keys
 * it holds after the turn, and the keys the selector returned a value for on any step.
 * `undefined` when no matching stage carries a subtrace, so a check that a slot is empty or
 * was not returned cannot pass on a turn that recorded nothing to read.
 */
const routineSlotKeys = (matches: TraceStage[]): { filled: Set<string>; returned: Set<string> } | undefined => {
  const traces = matches.map(routineTrace).filter((trace): trace is RoutineRunTrace => trace !== undefined);
  if (traces.length === 0) {
    return undefined;
  }
  return {
    filled: new Set(traces.flatMap((trace) => trace.filledSlotKeys)),
    returned: new Set(traces.flatMap((trace) => trace.steps.flatMap((step) => step.selection?.returnedSlotKeys ?? []))),
  };
};

const listOrNone = (keys: Iterable<string>): string => [...keys].join(", ") || "none";

/** Which slot keys each assertion reads, whether the named slots must be among them, and how a verdict reads. */
const SLOT_KEY_CHECKS: Record<
  RoutineSlotKeysAssertion["type"],
  {
    keys: "filled" | "returned";
    present: boolean;
    passes: (routineId: string, expected: string) => string;
    fails: (routineId: string, offending: string, observed: string) => string;
  }
> = {
  routine_slots_filled: {
    keys: "filled",
    present: true,
    passes: (routineId, expected) => `Routine "${routineId}" filled ${expected}.`,
    fails: (routineId, offending, observed) => `Routine "${routineId}" left ${offending} unfilled; filled: ${observed}.`,
  },
  routine_slots_unfilled: {
    keys: "filled",
    present: false,
    passes: (routineId, expected) => `Routine "${routineId}" left ${expected} unfilled.`,
    fails: (routineId, offending) => `Routine "${routineId}" filled ${offending}; expected it unfilled.`,
  },
  routine_slots_returned: {
    keys: "returned",
    present: true,
    passes: (routineId, expected) => `Routine "${routineId}" selector returned ${expected} this turn.`,
    fails: (routineId, offending, observed) =>
      `Routine "${routineId}" selector returned no value for ${offending} this turn; returned: ${observed}.`,
  },
  routine_slots_not_returned: {
    keys: "returned",
    present: false,
    passes: (routineId, expected) => `Routine "${routineId}" selector returned no value for ${expected} this turn.`,
    fails: (routineId, offending) => `Routine "${routineId}" selector returned ${offending} this turn; expected no value.`,
  },
};

const evaluateRoutineSlotKeys = (
  assertion: RoutineSlotKeysAssertion,
  output: EvalRunObservedOutput,
): SuiteTraceAssertionVerdict => {
  if (!output.turnTrace) {
    return missingTrace(assertion);
  }
  const matches = routineStages(output, assertion.routineId);
  if (matches.length === 0) {
    return fail(assertion, `Routine "${assertion.routineId}" did not claim the turn.`);
  }
  const slotKeys = routineSlotKeys(matches);
  if (!slotKeys) {
    return fail(assertion, `Routine "${assertion.routineId}" recorded no step trace to read its slots from.`);
  }
  const check = SLOT_KEY_CHECKS[assertion.type];
  const observed = slotKeys[check.keys];
  const offending = assertion.slotKeys.filter((key) => observed.has(key) !== check.present);
  if (offending.length === 0) {
    return pass(assertion, check.passes(assertion.routineId, assertion.slotKeys.join(", ")));
  }
  return fail(assertion, check.fails(assertion.routineId, offending.join(", "), listOrNone(observed)));
};

/**
 * Every skill the turn dispatched, whether as a turn skill (`skill_dispatch` stage)
 * or as a routine skill step (a `skill_dispatched` entry in the routine subtrace),
 * so a case can assert the same skill effect however the routine was driven.
 */
const dispatchedSkillNames = (output: EvalRunObservedOutput): string[] => {
  const fromStages = stages(output)
    .filter((stage) => stage.kind === "skill_dispatch")
    .map((stage) => readString(stage.outputs, "skillName") ?? stage.id.replace(/^dispatch:/u, ""));
  const fromRoutineSteps = stages(output)
    .flatMap((stage) => routineTrace(stage)?.steps ?? [])
    .filter((step) => step.event === "skill_dispatched" && typeof step.skillName === "string")
    .map((step) => step.skillName as string);
  return [...fromStages, ...fromRoutineSteps];
};

export const evaluateTraceAssertion = (
  assertion: SuiteTraceAssertion,
  output: ConversationQualityObservedOutput,
): SuiteTraceAssertionVerdict => {
  if (output.error) {
    return { assertion, status: "error", reason: output.error.message };
  }

  switch (assertion.type) {
    case "turn_route": {
      if (!output.turnTrace) {
        return missingTrace(assertion);
      }
      const routes = observedRoutes(output);
      if (routes.includes(assertion.route)) {
        return pass(assertion, `Turn was routed as "${assertion.route}".`);
      }
      return fail(
        assertion,
        routes.length === 0
          ? `Turn trace recorded no route; expected "${assertion.route}".`
          : `Turn was routed as ${routes.join(", ")}; expected "${assertion.route}".`,
      );
    }
    case "turn_uses_skill": {
      if (!output.turnTrace) {
        return missingTrace(assertion);
      }
      const dispatched = dispatchedSkillNames(output);
      if (dispatched.includes(assertion.skillName)) {
        return pass(assertion, `Turn dispatched skill "${assertion.skillName}".`);
      }
      const observed = dispatched.join(", ");
      return fail(
        assertion,
        observed
          ? `Turn dispatched ${observed}; expected "${assertion.skillName}".`
          : `Turn dispatched no skill; expected "${assertion.skillName}".`,
      );
    }
    case "turn_skips_skill": {
      if (!output.turnTrace) {
        return missingTrace(assertion);
      }
      if (dispatchedSkillNames(output).includes(assertion.skillName)) {
        return fail(assertion, `Turn dispatched skill "${assertion.skillName}"; expected it not to run.`);
      }
      return pass(assertion, `Turn did not dispatch skill "${assertion.skillName}".`);
    }
    case "turn_activates_routine": {
      if (!output.turnTrace) {
        return missingTrace(assertion);
      }
      if (routineStages(output, assertion.routineId).length > 0) {
        return pass(assertion, `Routine "${assertion.routineId}" claimed the turn.`);
      }
      return fail(assertion, `Routine "${assertion.routineId}" did not claim the turn.`);
    }
    case "routine_step_reached": {
      if (!output.turnTrace) {
        return missingTrace(assertion);
      }
      const matches = routineStages(output, assertion.routineId);
      if (matches.length === 0) {
        return fail(assertion, `Routine "${assertion.routineId}" did not claim the turn.`);
      }
      const reached = matches.some((stage) => {
        const trace = routineTrace(stage);
        if (!trace) {
          return false;
        }
        return (
          trace.landedStepId === assertion.stepId ||
          trace.steps.some((step) => step.stepId === assertion.stepId)
        );
      });
      if (reached) {
        return pass(
          assertion,
          `Routine "${assertion.routineId}" reached step "${assertion.stepId}".`,
        );
      }
      const landed = matches
        .map((stage) => routineTrace(stage)?.landedStepId)
        .filter((step): step is string => typeof step === "string")
        .join(", ");
      return fail(
        assertion,
        landed
          ? `Routine "${assertion.routineId}" landed on ${landed}; expected "${assertion.stepId}".`
          : `Routine "${assertion.routineId}" recorded no step trace to match "${assertion.stepId}".`,
      );
    }
    case "routine_slots_filled":
    case "routine_slots_unfilled":
    case "routine_slots_returned":
    case "routine_slots_not_returned":
      return evaluateRoutineSlotKeys(assertion, output);
    case "routine_yielded": {
      if (!output.turnTrace) {
        return missingTrace(assertion);
      }
      const yieldStage = stages(output).find(
        (stage) => stage.kind === "routine_yield" && readString(stage.outputs, "routineId") === assertion.routineId,
      );
      if (!yieldStage) {
        return fail(assertion, `Routine "${assertion.routineId}" did not yield the turn.`);
      }
      const parkedOn = readString(yieldStage.outputs, "stepId");
      if (parkedOn === assertion.stepId) {
        return pass(assertion, `Routine "${assertion.routineId}" yielded the turn and stays on "${parkedOn}".`);
      }
      return fail(
        assertion,
        `Routine "${assertion.routineId}" yielded the turn on ${parkedOn ?? "no recorded step"}; expected "${assertion.stepId}".`,
      );
    }
    case "turn_asks_clarification": {
      if (!output.turnTrace) {
        return missingTrace(assertion);
      }
      const clarified = stages(output).some(
        (stage) =>
          (stage.id === "clarification" && readString(stage.outputs, "decision") === "ask") ||
          stage.id === "dispatch:clarification.answer",
      );
      if (clarified) {
        return pass(assertion, "Turn asked a clarifying question.");
      }
      return fail(assertion, "Turn did not ask a clarifying question.");
    }
    case "turn_grounding_verdict": {
      const verdict = output.groundingVerdict ?? output.groundingSummary?.verdict;
      if (!verdict) {
        return {
          assertion,
          status: "error",
          reason: "No grounding summary was captured for this run.",
        };
      }
      if (verdict === assertion.verdict) {
        return pass(assertion, `Grounding verdict was "${verdict}".`);
      }
      return fail(assertion, `Grounding verdict was "${verdict}"; expected "${assertion.verdict}".`);
    }
    case "turn_answer_coverage": {
      const observed = observedCoverage(output);
      if (!observed) {
        return missingTrace(assertion);
      }
      const { source, availability, coverage } = observed;
      if (availability !== "assessed" || !coverage) {
        return fail(
          assertion,
          availability
            ? `Coverage verdict availability was "${availability}"; expected an assessed "${assertion.coverage}" verdict.`
            : `${source} recorded no coverage verdict; expected "${assertion.coverage}".`,
        );
      }
      if (coverage === assertion.coverage) {
        return pass(assertion, `Coverage verdict was "${coverage}".`);
      }
      return fail(assertion, `Coverage verdict was "${coverage}"; expected "${assertion.coverage}".`);
    }
    case "turn_persists_no_reply": {
      if (!output.reviewTurn) {
        return {
          assertion,
          status: "error",
          reason: "Persisted replies are observed only for a review turn; run the case in review mode.",
        };
      }
      const persisted = output.reviewTurn.persistedAssistantMessageCount;
      if (persisted === 0) {
        return pass(assertion, "The turn persisted no assistant message.");
      }
      return fail(assertion, `The turn persisted ${persisted} assistant message(s); expected none.`);
    }
    case "turn_reply_source": {
      if (!output.turnTrace) {
        return missingTrace(assertion);
      }
      const source = observedReplySource(output);
      if (!source) {
        return fail(assertion, `The turn composed no answer (no compose stage); expected "${assertion.source}".`);
      }
      if (source === assertion.source) {
        return pass(assertion, `The answer came from "${source}".`);
      }
      return fail(assertion, `The answer came from "${source}"; expected "${assertion.source}".`);
    }
    case "turn_directive_committed": {
      if (!output.turnTrace) {
        return missingTrace(assertion);
      }
      const observed = observedDirectiveAdherence(output, assertion.directive);
      if (observed.commitment) {
        return pass(assertion, `The answer committed to "${assertion.directive}" before writing: ${observed.commitment}`);
      }
      if (observed.graded) {
        return fail(assertion, `The answer graded "${assertion.directive}" but made no commitment for it before writing.`);
      }
      if (observed.ungraded) {
        return fail(assertion, `The answer left "${assertion.directive}" ungraded.`);
      }
      return fail(
        assertion,
        observed.composed
          ? `The compose stage recorded nothing for "${assertion.directive}": it was not rendered into the answer prompt, or a decline replaced the graded answer.`
          : `The turn composed no answer (no compose stage); expected a commitment to "${assertion.directive}".`,
      );
    }
    case "voice_bridge_emitted": {
      if (!output.voiceTurn) {
        return missingVoiceObservation(assertion);
      }
      const { bridged } = output.voiceTurn;
      if (bridged === assertion.expected) {
        return pass(assertion, `Turn ${bridged ? "bridged" : "did not bridge"}.`);
      }
      return fail(
        assertion,
        `Turn ${bridged ? "bridged" : "did not bridge"}; expected ${assertion.expected ? "a bridge" : "no bridge"}.`,
      );
    }
    case "voice_turn_limit_reached": {
      if (!output.voiceTurn) {
        return missingVoiceObservation(assertion);
      }
      const { turnLimitReached } = output.voiceTurn;
      if (turnLimitReached === assertion.expected) {
        return pass(assertion, `Turn ${turnLimitReached ? "reached" : "did not reach"} the turn limit.`);
      }
      return fail(
        assertion,
        `Turn ${turnLimitReached ? "reached" : "did not reach"} the turn limit; expected ${assertion.expected ? "it to" : "it not to"}.`,
      );
    }
    case "voice_turn_outcome": {
      if (!output.voiceTurn) {
        return missingVoiceObservation(assertion);
      }
      const { outcomeKind } = output.voiceTurn;
      if (outcomeKind === assertion.kind) {
        return pass(assertion, `Turn outcome was "${outcomeKind}".`);
      }
      return fail(assertion, `Turn outcome was ${outcomeKind ?? "none"}; expected "${assertion.kind}".`);
    }
  }
};
