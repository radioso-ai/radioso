import type { RoutineRunTrace } from "@radioso/conversation-contract";

import type { AssertionVerdictStatus, EvalRunObservedOutput } from "../domain/types.js";

/**
 * Trace assertions read structured signal out of a turn's {@link EvalRunObservedOutput}
 * (its `turnTrace` spine and grounding summary) rather than the prose answer. They are
 * the deterministic, LLM-free half of the conversation-quality suite: which route was
 * classified, which skill produced the answer, whether a routine claimed the turn and
 * how far it advanced, whether the turn asked a clarifying question, and the grounding
 * verdict. Because they never call a model they are cheap and stable enough to gate on
 * every run.
 *
 * They live in the suite's own union — NOT the shipped product `EvalAssertion` union —
 * so the dashboard/API contract for operator-authored eval cases stays unchanged.
 */
export type SuiteTraceAssertion =
  | { type: "turn_route"; route: "retrieval" | "direct" }
  | { type: "turn_uses_skill"; skillName: string }
  | { type: "turn_activates_routine"; routineId: string }
  | { type: "routine_step_reached"; routineId: string; stepId: string }
  | { type: "turn_asks_clarification" }
  | { type: "turn_grounding_verdict"; verdict: "grounded" | "degraded" | "no_support" };

export type SuiteTraceAssertionType = SuiteTraceAssertion["type"];

const TRACE_ASSERTION_TYPES = new Set<string>([
  "turn_route",
  "turn_uses_skill",
  "turn_activates_routine",
  "routine_step_reached",
  "turn_asks_clarification",
  "turn_grounding_verdict",
]);

export const isTraceAssertion = (assertion: { type: string }): assertion is SuiteTraceAssertion =>
  TRACE_ASSERTION_TYPES.has(assertion.type);

export interface SuiteTraceAssertionVerdict {
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

const routineTrace = (stage: TraceStage): RoutineRunTrace | undefined => {
  const sub = stage.subTrace;
  if (!sub || sub.namespace !== "routine") {
    return undefined;
  }
  return sub.payload as RoutineRunTrace;
};

export const evaluateTraceAssertion = (
  assertion: SuiteTraceAssertion,
  output: EvalRunObservedOutput,
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
      const dispatched = stages(output).filter((stage) => stage.kind === "skill_dispatch");
      const hit = dispatched.some(
        (stage) =>
          readString(stage.outputs, "skillName") === assertion.skillName ||
          stage.id === `dispatch:${assertion.skillName}`,
      );
      if (hit) {
        return pass(assertion, `Turn dispatched skill "${assertion.skillName}".`);
      }
      const observed = dispatched
        .map((stage) => readString(stage.outputs, "skillName") ?? stage.id)
        .join(", ");
      return fail(
        assertion,
        observed
          ? `Turn dispatched ${observed}; expected "${assertion.skillName}".`
          : `Turn dispatched no skill; expected "${assertion.skillName}".`,
      );
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
  }
};
