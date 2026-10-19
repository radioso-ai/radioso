import { readFileSync } from "node:fs";

import { describe, expect, it, vi } from "vitest";

import { compileRoutineDefinition } from "../../../src/modules/routines/compiler.js";
import type { AssertionVerdict, EvalRunObservedOutput } from "../../../src/modules/eval/domain/types.js";
import {
  buildBaselineFile,
  diffAgainstBaseline,
  evaluateTraceAssertion,
  formatReport,
  hasBaselineGateFailures,
  isBaselineInitialized,
  mergeBaselineFile,
  parseConversationQualityCases,
  reduceSamples,
  runConversationQualitySuite,
  runConversationQualitySuiteSampled,
  scoreObservedOutput,
  summarizeRun,
  ZERO_TOLERANCE_JUDGE_TAG,
  type CaseReport,
  type ConversationQualityCase,
  type ConversationQualityObservedOutput,
  type ConversationQualityRunnerPort,
} from "../../../src/modules/eval/suite/index.js";
import type { EvalLlmJudgePort } from "../../../src/modules/eval/services/evalJudge.js";
import type { Directive } from "../../../src/modules/directives/public.js";
import {
  BOOK_DEMO_ROUTINE_ID,
  CONTACT_SUPPORT_ROUTINE_ID,
  START_RETURN_ROUTINE_ID,
  conversationQualityAgentConfig,
  conversationQualityCases,
  conversationQualityRoutines,
} from "../../fixtures/conversation-quality/index.js";
import { conversationQualityCorpus, MOUNTAIN_COURSE_DOC_ID } from "../../fixtures/conversation-quality/corpus.js";
import { pricesFromTheCoursePageDirective } from "../../fixtures/conversation-quality/directives.js";
import {
  canonicalAnswerEnvelope,
  conversationQualityChatHarness,
} from "../../support/conversationQualityChatHarness.js";

const observed = (overrides: Partial<ConversationQualityObservedOutput> = {}): ConversationQualityObservedOutput => ({
  retrievedChunks: [],
  ...overrides,
});

const trace = (stages: Array<Record<string, unknown>>): EvalRunObservedOutput["turnTrace"] => ({
  version: 1,
  spine: {
    traceId: "trace",
    startedAt: "2026-01-01T00:00:00.000Z",
    stages: stages as never,
  },
});

describe("trace assertions", () => {
  it("passes turn_route when the interpretation stage recorded the route", () => {
    const output = observed({
      turnTrace: trace([{ id: "turn_interpretation", kind: "turn_interpretation", status: "applied", outputs: { route: "retrieval" } }]),
    });
    expect(evaluateTraceAssertion({ type: "turn_route", route: "retrieval" }, output).status).toBe("pass");
    expect(evaluateTraceAssertion({ type: "turn_route", route: "direct" }, output).status).toBe("fail");
  });

  it("errors turn_route when no trace was captured", () => {
    const verdict = evaluateTraceAssertion({ type: "turn_route", route: "retrieval" }, observed());
    expect(verdict.status).toBe("error");
  });

  it("reads turn_reply_source from the compose stage: the planner's reply or the composer's", () => {
    const planned = observed({
      turnTrace: trace([{ id: "compose", kind: "compose", status: "applied", outputs: { source: "turn_planning", quickReplyKind: "thanks" } }]),
    });
    const composed = observed({
      turnTrace: trace([{ id: "compose", kind: "compose", status: "applied", outputs: { answerLength: 42 } }]),
    });

    expect(evaluateTraceAssertion({ type: "turn_reply_source", source: "turn_planning" }, planned).status).toBe("pass");
    const plannedAsComposer = evaluateTraceAssertion({ type: "turn_reply_source", source: "composer" }, planned);
    expect(plannedAsComposer.status).toBe("fail");
    expect(plannedAsComposer.reason).toContain("turn_planning");
    expect(evaluateTraceAssertion({ type: "turn_reply_source", source: "composer" }, composed).status).toBe("pass");
    expect(evaluateTraceAssertion({ type: "turn_reply_source", source: "turn_planning" }, composed).status).toBe("fail");
  });

  // #1575: the answer commits to what a directive requires before it writes, then grades itself.
  it("reads turn_directive_committed from the compose stage's commitment and grade for the directive", () => {
    const compose = (outputs: Record<string, unknown>) =>
      observed({ turnTrace: trace([{ id: "compose", kind: "compose", status: "applied", outputs }]) });
    const assertion = { type: "turn_directive_committed", directive: "prices-from-the-course-page" } as const;
    const graded = { directive: "prices-from-the-course-page", ruleId: "d1", satisfied: true, applicable: true, note: "no figures" };

    expect(evaluateTraceAssertion(assertion, compose({
      adherence: [{ ...graded, commitment: "leave out every figure" }],
    })).status).toBe("pass");
    const uncommitted = evaluateTraceAssertion(assertion, compose({ adherence: [graded] }));
    expect(uncommitted.status).toBe("fail");
    expect(uncommitted.reason).toContain("no commitment");
    const ungraded = evaluateTraceAssertion(assertion, compose({ ungradedDirectives: ["prices-from-the-course-page"] }));
    expect(ungraded.status).toBe("fail");
    expect(ungraded.reason).toContain("ungraded");
    expect(evaluateTraceAssertion(assertion, compose({ answerLength: 12 })).status).toBe("fail");
    expect(evaluateTraceAssertion(assertion, observed()).status).toBe("error");
  });

  it("fails turn_reply_source when no answer was composed, and errors without a trace", () => {
    const routineReply = observed({
      turnTrace: trace([{ id: "routine:book-demo", kind: "routine", status: "applied", outputs: {} }]),
    });

    expect(evaluateTraceAssertion({ type: "turn_reply_source", source: "composer" }, routineReply).status).toBe("fail");
    expect(evaluateTraceAssertion({ type: "turn_reply_source", source: "turn_planning" }, observed()).status).toBe("error");
  });

  it("passes turn_uses_skill on a matching dispatch stage", () => {
    const output = observed({
      turnTrace: trace([{ id: "dispatch:retrieval.answer", kind: "skill_dispatch", status: "applied", outputs: { skillName: "retrieval.answer" } }]),
    });
    expect(evaluateTraceAssertion({ type: "turn_uses_skill", skillName: "retrieval.answer" }, output).status).toBe("pass");
    expect(evaluateTraceAssertion({ type: "turn_uses_skill", skillName: "clarification.answer" }, output).status).toBe("fail");
  });

  it("sees a skill a routine step dispatched, and turn_skips_skill is its negation", () => {
    const routineTurn = (steps: Array<Record<string, unknown>>) => observed({
      turnTrace: trace([
        {
          id: `routine:${START_RETURN_ROUTINE_ID}`,
          kind: "routine_activate",
          status: "applied",
          outputs: { routineId: START_RETURN_ROUTINE_ID },
          subTrace: {
            namespace: "routine",
            version: 1,
            payload: {
              routineId: START_RETURN_ROUTINE_ID,
              startStepId: "ask_order",
              landedStepId: "done",
              capturedSlotKeys: [],
              filledSlotKeys: ["orderId", "reason"],
              steps,
            },
          },
        },
      ]),
    });
    const dispatched = routineTurn([
      { stepId: "ask_order", kind: "chat", event: "fast_forwarded" },
      { stepId: "create_return", kind: "skill", event: "skill_dispatched", skillName: "create_return_ticket", skillStatus: "completed" },
    ]);
    const waiting = routineTurn([{ stepId: "ask_reason", kind: "chat", event: "rendered" }]);

    expect(evaluateTraceAssertion({ type: "turn_uses_skill", skillName: "create_return_ticket" }, dispatched).status).toBe("pass");
    expect(evaluateTraceAssertion({ type: "turn_skips_skill", skillName: "create_return_ticket" }, dispatched).status).toBe("fail");
    expect(evaluateTraceAssertion({ type: "turn_uses_skill", skillName: "create_return_ticket" }, waiting).status).toBe("fail");
    expect(evaluateTraceAssertion({ type: "turn_skips_skill", skillName: "create_return_ticket" }, waiting).status).toBe("pass");
    expect(evaluateTraceAssertion({ type: "turn_skips_skill", skillName: "create_return_ticket" }, observed({})).status).toBe("error");
  });

  it("passes turn_activates_routine and routine_step_reached from the routine stage + subtrace", () => {
    const output = observed({
      turnTrace: trace([
        {
          id: `routine:${CONTACT_SUPPORT_ROUTINE_ID}`,
          kind: "routine_activate",
          status: "applied",
          outputs: { routineId: CONTACT_SUPPORT_ROUTINE_ID },
          subTrace: {
            namespace: "routine",
            version: 1,
            payload: {
              routineId: CONTACT_SUPPORT_ROUTINE_ID,
              startStepId: "ask_email",
              landedStepId: "ask_email",
              capturedSlotKeys: [],
              filledSlotKeys: [],
              steps: [{ stepId: "ask_email", kind: "chat", event: "rendered" }],
            },
          },
        },
      ]),
    });
    expect(evaluateTraceAssertion({ type: "turn_activates_routine", routineId: CONTACT_SUPPORT_ROUTINE_ID }, output).status).toBe("pass");
    expect(evaluateTraceAssertion({ type: "routine_step_reached", routineId: CONTACT_SUPPORT_ROUTINE_ID, stepId: "ask_email" }, output).status).toBe("pass");
    expect(evaluateTraceAssertion({ type: "routine_step_reached", routineId: CONTACT_SUPPORT_ROUTINE_ID, stepId: "ask_issue" }, output).status).toBe("fail");
    expect(evaluateTraceAssertion({ type: "turn_activates_routine", routineId: BOOK_DEMO_ROUTINE_ID }, output).status).toBe("fail");
  });

  it("passes routine_slots_filled only when every named slot is filled after the turn", () => {
    const output = observed({
      turnTrace: trace([
        {
          id: `routine:${BOOK_DEMO_ROUTINE_ID}`,
          kind: "routine_activate",
          status: "applied",
          outputs: { routineId: BOOK_DEMO_ROUTINE_ID },
          subTrace: {
            namespace: "routine",
            version: 1,
            payload: {
              routineId: BOOK_DEMO_ROUTINE_ID,
              startStepId: "ask_name",
              landedStepId: "ask_name",
              capturedSlotKeys: ["email", "preferredDate"],
              filledSlotKeys: ["email", "preferredDate"],
              steps: [{ stepId: "ask_name", kind: "chat", event: "reasked" }],
            },
          },
        },
      ]),
    });
    const filled = (slotKeys: string[]) =>
      evaluateTraceAssertion({ type: "routine_slots_filled", routineId: BOOK_DEMO_ROUTINE_ID, slotKeys }, output);

    expect(filled(["email", "preferredDate"]).status).toBe("pass");
    expect(filled(["email", "name"])).toMatchObject({ status: "fail", reason: expect.stringContaining("name") });
    expect(evaluateTraceAssertion(
      { type: "routine_slots_filled", routineId: CONTACT_SUPPORT_ROUTINE_ID, slotKeys: ["email"] },
      output,
    ).status).toBe("fail");
    expect(evaluateTraceAssertion(
      { type: "routine_slots_filled", routineId: BOOK_DEMO_ROUTINE_ID, slotKeys: ["email"] },
      observed({}),
    ).status).toBe("error");
  });

  it("passes routine_yielded only when the routine yielded the turn and stays parked on the step", () => {
    const output = observed({
      turnTrace: trace([
        {
          id: `routine_yield:${BOOK_DEMO_ROUTINE_ID}`,
          kind: "routine_yield",
          status: "skipped",
          outputs: { routineId: BOOK_DEMO_ROUTINE_ID, stepId: "ask_email", missingSlotKeys: ["email"] },
        },
      ]),
    });
    const yielded = (routineId: string, stepId: string) =>
      evaluateTraceAssertion({ type: "routine_yielded", routineId, stepId }, output);

    expect(yielded(BOOK_DEMO_ROUTINE_ID, "ask_email").status).toBe("pass");
    expect(yielded(BOOK_DEMO_ROUTINE_ID, "ask_date")).toMatchObject({ status: "fail", reason: expect.stringContaining("ask_email") });
    expect(yielded(CONTACT_SUPPORT_ROUTINE_ID, "ask_email").status).toBe("fail");
    expect(evaluateTraceAssertion(
      { type: "routine_yielded", routineId: BOOK_DEMO_ROUTINE_ID, stepId: "ask_email" },
      observed({}),
    ).status).toBe("error");
  });

  it("detects a clarifying question from either signal", () => {
    const engineSignal = observed({ turnTrace: trace([{ id: "clarification", kind: "clarification", status: "applied", outputs: { decision: "ask" } }]) });
    const skillSignal = observed({ turnTrace: trace([{ id: "dispatch:clarification.answer", kind: "skill_dispatch", status: "applied" }]) });
    const noSignal = observed({ turnTrace: trace([{ id: "clarification", kind: "clarification", status: "applied", outputs: { decision: "none" } }]) });
    expect(evaluateTraceAssertion({ type: "turn_asks_clarification" }, engineSignal).status).toBe("pass");
    expect(evaluateTraceAssertion({ type: "turn_asks_clarification" }, skillSignal).status).toBe("pass");
    expect(evaluateTraceAssertion({ type: "turn_asks_clarification" }, noSignal).status).toBe("fail");
  });

  it("reads the grounding verdict from the grounding summary", () => {
    const output = observed({ groundingSummary: { protocolVersion: 2, parseStatus: "valid_v2", verdict: "no_support", claimCount: 0, sourcedClaimCount: 0, unsourcedClaimCount: 0, invalidSourceCount: 0, assertionMismatch: false } });
    expect(evaluateTraceAssertion({ type: "turn_grounding_verdict", verdict: "no_support" }, output).status).toBe("pass");
    expect(evaluateTraceAssertion({ type: "turn_grounding_verdict", verdict: "grounded" }, output).status).toBe("fail");
  });

  it("reads the coverage verdict from the answer_coverage_head stage (#1260 F8)", () => {
    const output = observed({
      turnTrace: trace([{
        id: "answer_coverage_head",
        kind: "answer_coverage_head",
        status: "applied",
        outputs: { availability: "assessed", coverage: "partial", reason: "insufficient_evidence" },
      }]),
    });
    expect(evaluateTraceAssertion({ type: "turn_answer_coverage", coverage: "partial" }, output).status).toBe("pass");
    expect(evaluateTraceAssertion({ type: "turn_answer_coverage", coverage: "answered" }, output).status).toBe("fail");
  });

  it("fails turn_answer_coverage when the head reported no verdict", () => {
    const notAssessed = observed({
      turnTrace: trace([{
        id: "answer_coverage_head",
        kind: "answer_coverage_head",
        status: "fallback",
        outputs: { availability: "invalid" },
      }]),
    });
    expect(evaluateTraceAssertion({ type: "turn_answer_coverage", coverage: "unanswered" }, notAssessed).status).toBe("fail");

    const noStage = observed({ turnTrace: trace([]) });
    expect(evaluateTraceAssertion({ type: "turn_answer_coverage", coverage: "unanswered" }, noStage).status).toBe("fail");
  });

  it("reads a review turn's coverage verdict from its review facts, which carry no trace", () => {
    const reviewed = (answerCoverage: { availability: "assessed" | "not_recorded"; coverage?: "answered" | "unanswered" } | null) =>
      observed({ reviewTurn: { answerCoverage, persistedAssistantMessageCount: 0 } });

    expect(evaluateTraceAssertion({ type: "turn_answer_coverage", coverage: "unanswered" }, reviewed({ availability: "assessed", coverage: "unanswered" })).status).toBe("pass");
    expect(evaluateTraceAssertion({ type: "turn_answer_coverage", coverage: "answered" }, reviewed({ availability: "assessed", coverage: "unanswered" })).status).toBe("fail");
    expect(evaluateTraceAssertion({ type: "turn_answer_coverage", coverage: "answered" }, reviewed({ availability: "not_recorded" })).status).toBe("fail");
    expect(evaluateTraceAssertion({ type: "turn_answer_coverage", coverage: "answered" }, reviewed(null)).status).toBe("fail");
  });

  it("passes turn_persists_no_reply only when a review turn wrote no assistant row", () => {
    const wrote = (count: number) => observed({ reviewTurn: { answerCoverage: null, persistedAssistantMessageCount: count } });

    expect(evaluateTraceAssertion({ type: "turn_persists_no_reply" }, wrote(0)).status).toBe("pass");
    expect(evaluateTraceAssertion({ type: "turn_persists_no_reply" }, wrote(1)).status).toBe("fail");
    // A live turn is not observed for persisted replies, so the assertion cannot be scored on it.
    expect(evaluateTraceAssertion({ type: "turn_persists_no_reply" }, observed({ turnTrace: trace([]) })).status).toBe("error");
  });
});

const passJudge: EvalLlmJudgePort = {
  async judge({ assertion }) {
    return { assertion, status: "pass", reason: "ok" } satisfies AssertionVerdict;
  },
};

describe("scoreObservedOutput", () => {
  const groundedRetrieval = (): EvalRunObservedOutput =>
    observed({
      retrievedChunks: [{ chunkId: "c1", documentId: "doc-a", title: "A", rank: 1 }],
      answer: "The Pro plan is $49 per month.",
      citations: [{ documentId: "doc-a", chunkId: "c1", title: "A" }],
      turnTrace: trace([{ id: "turn_interpretation", kind: "turn_interpretation", status: "applied", outputs: { route: "retrieval" } }]),
    });

  it("passes a case mixing product, trace, and judge assertions", async () => {
    const score = await scoreObservedOutput(
      [
        { type: "turn_route", route: "retrieval" },
        { type: "retrieval_includes_document", documentId: "doc-a" },
        { type: "answer_contains", pattern: "49", matchMode: "substring" },
        { type: "llm_judge", expectedAnswer: "$49/mo" },
      ],
      groundedRetrieval(),
      { workspaceId: "ws", question: "price?", runId: "r1", judge: passJudge },
    );
    expect(score.status).toBe("pass");
    expect(score.verdicts).toHaveLength(4);
  });

  it("errors an llm_judge assertion when no judge is configured", async () => {
    const score = await scoreObservedOutput(
      [{ type: "llm_judge", expectedAnswer: "x" }],
      groundedRetrieval(),
      { workspaceId: "ws", question: "q", runId: "r" },
    );
    expect(score.status).toBe("error");
  });

  it("propagates a runner error to every assertion", async () => {
    const score = await scoreObservedOutput(
      [{ type: "turn_route", route: "retrieval" }],
      observed({ error: { message: "boom" } }),
      { workspaceId: "ws", question: "q", runId: "r" },
    );
    expect(score.status).toBe("error");
    expect(score.verdicts[0]?.reason).toBe("boom");
  });

  it("records a case with no assertions", async () => {
    const score = await scoreObservedOutput([], groundedRetrieval(), { workspaceId: "ws", question: "q", runId: "r" });
    expect(score.status).toBe("recorded");
  });
});

describe("baseline diff", () => {
  it("classifies regressions, fixes, new, and removed", () => {
    const current = [
      { caseId: "a", name: "A", status: "fail" as const },
      { caseId: "b", name: "B", status: "pass" as const },
      { caseId: "c", name: "C", status: "pass" as const },
    ];
    const diff = diffAgainstBaseline(current, { cases: { a: "pass", b: "fail", d: "pass" } });
    expect(diff.regressions.map((r) => r.caseId)).toEqual(["a"]);
    expect(diff.fixes.map((f) => f.caseId)).toEqual(["b"]);
    expect(diff.newCases.map((n) => n.caseId)).toEqual(["c"]);
    expect(diff.removed).toEqual(["d"]);
  });

  it("treats a case absent from the baseline as a gate failure", () => {
    const diff = diffAgainstBaseline(
      [{ caseId: "new-case", name: "New case", status: "fail" }],
      { cases: {} },
    );

    expect(hasBaselineGateFailures(diff)).toBe(true);
  });

  it("treats an empty baseline as uninitialized (so the runner can gate on it)", () => {
    expect(isBaselineInitialized({ cases: {} })).toBe(false);
    expect(isBaselineInitialized({ cases: { a: "pass" } })).toBe(true);
  });

  it("reads a status from either the bare or the sampled baseline entry", () => {
    // A sampled recorder writes what it measured — status plus the rate it was reduced from — while
    // the conversation-quality baseline is still a bare status. One file format has to carry both,
    // or the two suites cannot share the regression bookkeeping.
    const current = [
      { caseId: "a", name: "A", status: "fail" as const },
      { caseId: "b", name: "B", status: "pass" as const },
    ];
    const diff = diffAgainstBaseline(current, {
      cases: { a: { status: "pass", passRate: 1, samples: 3 }, b: "fail" },
    });
    expect(diff.regressions.map((entry) => entry.caseId)).toEqual(["a"]);
    expect(diff.fixes.map((entry) => entry.caseId)).toEqual(["b"]);
  });

  it("reports a pass rate that fell far below the recorded one, even though the status did not move", () => {
    // The silent half of a single-sample baseline: a case recorded `fail` that used to pass two runs
    // in three, and now never passes, reads as "unchanged" forever. Only the rate shows the drop.
    const diff = diffAgainstBaseline(
      [{ caseId: "a", name: "A", status: "fail", passRate: 0, samples: 3 }],
      { cases: { a: { status: "fail", passRate: 0.67, samples: 3 } } },
      { rateDropTolerance: 0.5 },
    );
    expect(diff.regressions).toEqual([]);
    expect(diff.rateRegressions).toEqual([
      { caseId: "a", name: "A", from: 0.67, to: 0 },
    ]);
  });

  it("does not report a rate drop inside the tolerance, or one against a baseline that recorded no rate", () => {
    // Small K makes the rate coarse — one sample of three moves it by a third — so the tolerance has
    // to be wider than the sampling noise it is reading through.
    expect(
      diffAgainstBaseline(
        [{ caseId: "a", name: "A", status: "fail", passRate: 0.34, samples: 3 }],
        { cases: { a: { status: "fail", passRate: 0.67, samples: 3 } } },
        { rateDropTolerance: 0.5 },
      ).rateRegressions,
    ).toEqual([]);
    expect(
      diffAgainstBaseline(
        [{ caseId: "a", name: "A", status: "fail", passRate: 0 }],
        { cases: { a: "fail" } },
        { rateDropTolerance: 0.5 },
      ).rateRegressions,
    ).toEqual([]);
  });

  it("does not call it a regression when this run sampled less than the baseline did", () => {
    // The bare smoke run is one sample. Against a baseline recorded from three, a case that passes
    // seven times in eight fails that single sample often enough to report a regression on
    // unchanged code — the exact defect sampling exists to remove, wearing a different hat. A run
    // that sampled less deeply than the baseline cannot support the claim, so it does not make it.
    const diff = diffAgainstBaseline(
      [{ caseId: "a", name: "A", status: "fail", passRate: 0, samples: 1 }],
      { cases: { a: { status: "pass", passRate: 1, samples: 3 } } },
    );

    expect(diff.regressions).toEqual([]);
    expect(diff.underSampled).toEqual([
      { caseId: "a", name: "A", from: "pass", to: "fail", samples: 1, baselineSamples: 3 },
    ]);
    expect(hasBaselineGateFailures(diff)).toBe(true);
  });

  it("does not report a rate drop from a run that sampled less deeply either", () => {
    // The status holds at `fail`, so this misses the pass -> not-pass guard entirely and lands in
    // the rate branch: a one-sample run of a case the baseline recorded failing two times in three
    // reports 0.67 -> 0 and exits nonzero. A shallower run cannot claim ANY regression.
    const diff = diffAgainstBaseline(
      [{ caseId: "a", name: "A", status: "fail", passRate: 0, samples: 1 }],
      { cases: { a: { status: "fail", passRate: 0.67, samples: 3 } } },
    );

    expect(diff.rateRegressions).toEqual([]);
    expect(diff.underSampled).toEqual([
      { caseId: "a", name: "A", from: "fail", to: "fail", samples: 1, baselineSamples: 3 },
    ]);
  });

  it("still reports a regression when the run sampled at least as deeply", () => {
    expect(
      diffAgainstBaseline(
        [{ caseId: "a", name: "A", status: "fail", passRate: 0, samples: 3 }],
        { cases: { a: { status: "pass", passRate: 1, samples: 3 } } },
      ).regressions.map((entry) => entry.caseId),
    ).toEqual(["a"]);
    // A baseline that recorded no sample count is the older single-sample form; nothing to compare.
    expect(
      diffAgainstBaseline(
        [{ caseId: "a", name: "A", status: "fail" }],
        { cases: { a: "pass" } },
      ).regressions.map((entry) => entry.caseId),
    ).toEqual(["a"]);
  });

  it("does not call a sampled pass → fail flip a regression while the pass rate moved within the tolerance", () => {
    // At the unanimous bar a case recorded passing five in five reads `fail` on any four-in-five run,
    // so the nightly gate failed on sampling noise in whichever near-ceiling case missed one sample.
    // With both sides sampled, the rate is the measurement and the status only its reduction.
    const diff = diffAgainstBaseline(
      [{ caseId: "a", name: "A", status: "fail", passRate: 0.6, samples: 5 }],
      { passThreshold: 1, cases: { a: { status: "pass", passRate: 1, samples: 5 } } },
      { passThreshold: 1 },
    );

    expect(diff.regressions).toEqual([]);
    expect(diff.rateRegressions).toEqual([]);
    expect(diff.withinTolerance).toEqual([{ caseId: "a", name: "A", from: 1, to: 0.6 }]);
    expect(hasBaselineGateFailures(diff)).toBe(false);
  });

  it("still reports a sampled pass → fail flip whose pass rate fell past the tolerance", () => {
    const diff = diffAgainstBaseline(
      [{ caseId: "a", name: "A", status: "fail", passRate: 0.4, samples: 5 }],
      { cases: { a: { status: "pass", passRate: 1, samples: 5 } } },
    );

    expect(diff.regressions.map((entry) => entry.caseId)).toEqual(["a"]);
    expect(diff.withinTolerance).toEqual([]);
    expect(hasBaselineGateFailures(diff)).toBe(true);
  });

  it("never waives a sampled pass → error flip as noise, however small the rate drop", () => {
    // Every sample errored: no evaluation completed, so the rate measures nothing. At a 0.5 bar the
    // drop from 0.5 to 0 does not exceed the tolerance, and would otherwise pass as noise.
    const diff = diffAgainstBaseline(
      [{ caseId: "a", name: "A", status: "error", passRate: 0, samples: 2 }],
      { passThreshold: 0.5, cases: { a: { status: "pass", passRate: 0.5, samples: 2 } } },
      { passThreshold: 0.5 },
    );

    expect(diff.regressions).toEqual([{ caseId: "a", name: "A", from: "pass", to: "error" }]);
    expect(diff.withinTolerance).toEqual([]);
  });

  it("does not hold a shallower run's within-tolerance flip as under-sampled", () => {
    const diff = diffAgainstBaseline(
      [{ caseId: "a", name: "A", status: "fail", passRate: 0.67, samples: 3 }],
      { cases: { a: { status: "pass", passRate: 1, samples: 5 } } },
    );

    expect(diff.underSampled).toEqual([]);
    expect(diff.withinTolerance.map((entry) => entry.caseId)).toEqual(["a"]);
    expect(hasBaselineGateFailures(diff)).toBe(false);
  });

  it("records sampled status evidence and the pass threshold in a sorted baseline file", () => {
    const file = buildBaselineFile(
      [
        { caseId: "b", name: "B", status: "pass", passRate: 1, samples: 5 },
        { caseId: "a", name: "A", status: "fail", passRate: 0.8, samples: 5 },
      ],
      "2026-01-01T00:00:00.000Z",
      0.8,
    );
    expect(Object.keys(file.cases)).toEqual(["a", "b"]);
    expect(file.passThreshold).toBe(0.8);
    expect(file.cases.a).toEqual({ status: "fail", passRate: 0.8, samples: 5 });
  });

  it("fails gating when the current pass threshold differs from the recorded threshold", () => {
    const diff = diffAgainstBaseline(
      [{ caseId: "a", name: "A", status: "pass", passRate: 1, samples: 5 }],
      { passThreshold: 0.8, cases: { a: { status: "pass", passRate: 1, samples: 5 } } },
      { passThreshold: 1 },
    );

    expect(diff.thresholdMismatch).toEqual({ baseline: 0.8, current: 1 });
    expect(hasBaselineGateFailures(diff)).toBe(true);
  });

  it("merges a filtered baseline update without removing unselected entries", () => {
    const merged = mergeBaselineFile(
      {
        generatedAt: "2026-01-01T00:00:00.000Z",
        passThreshold: 1,
        cases: {
          page: { status: "fail", passRate: 0, samples: 5 },
          routine: { status: "pass", passRate: 1, samples: 5 },
        },
      },
      [{ caseId: "page", name: "Page", status: "pass", passRate: 1, samples: 5 }],
      "2026-01-02T00:00:00.000Z",
      1,
    );

    expect(merged).toEqual({
      generatedAt: "2026-01-02T00:00:00.000Z",
      passThreshold: 1,
      cases: {
        page: { status: "pass", passRate: 1, samples: 5 },
        routine: { status: "pass", passRate: 1, samples: 5 },
      },
    });
  });

  it("treats a material sampled pass-rate drop as a gate failure", () => {
    const diff = diffAgainstBaseline(
      [{ caseId: "flaky", name: "Flaky", status: "fail", passRate: 0, samples: 5 }],
      { cases: { flaky: { status: "fail", passRate: 0.8, samples: 5 } } },
    );

    expect(diff.rateRegressions).toEqual([{ caseId: "flaky", name: "Flaky", from: 0.8, to: 0 }]);
    expect(hasBaselineGateFailures(diff)).toBe(true);
  });

  it("holds a zero-tolerance judge to the recorded rate even while the case stays within the general tolerance", () => {
    // Recorded at five in five, the judge now fails two samples: a reply made a claim twice. The case
    // rate moved within the tolerance, so only the judge's own rate can fail the run.
    const diff = diffAgainstBaseline(
      [{ caseId: "qr", name: "QR", status: "fail", passRate: 0.6, samples: 5, zeroToleranceJudgePassRate: 0.6 }],
      { passThreshold: 1, cases: { qr: { status: "pass", passRate: 1, samples: 5 } } },
      { passThreshold: 1 },
    );

    expect(diff.withinTolerance).toEqual([{ caseId: "qr", name: "QR", from: 1, to: 0.6 }]);
    expect(diff.judgeRegressions).toEqual([{ caseId: "qr", name: "QR", from: 1, to: 0.6 }]);
    expect(hasBaselineGateFailures(diff)).toBe(true);
  });

  it("keeps the general tolerance for a zero-tolerance case whose judge passed every sample it graded", () => {
    const diff = diffAgainstBaseline(
      [{ caseId: "qr", name: "QR", status: "fail", passRate: 0.8, samples: 5, zeroToleranceJudgePassRate: 1 }],
      { passThreshold: 1, cases: { qr: { status: "pass", passRate: 1, samples: 5 } } },
      { passThreshold: 1 },
    );

    expect(diff.judgeRegressions).toEqual([]);
    expect(diff.withinTolerance.map((entry) => entry.caseId)).toEqual(["qr"]);
    expect(hasBaselineGateFailures(diff)).toBe(false);
  });

  it("counts a failed zero-tolerance judge verdict at any sampling depth", () => {
    const diff = diffAgainstBaseline(
      [{ caseId: "qr", name: "QR", status: "fail", passRate: 0, samples: 1, zeroToleranceJudgePassRate: 0 }],
      { cases: { qr: { status: "pass", passRate: 1, samples: 5 } } },
    );

    expect(diff.judgeRegressions).toEqual([{ caseId: "qr", name: "QR", from: 1, to: 0 }]);
    expect(hasBaselineGateFailures(diff)).toBe(true);
  });
});

describe("eval command defaults", () => {
  it("uses the same five-sample depth for normal and baseline-recording commands", () => {
    const packageJson = JSON.parse(
      readFileSync(new URL("../../../package.json", import.meta.url), "utf8"),
    ) as { scripts: Record<string, string> };

    expect(packageJson.scripts.evals).toContain("--samples 5");
    expect(packageJson.scripts["evals:update-baseline"]).toContain("--samples 5");
  });
});

describe("runConversationQualitySuite", () => {
  const cases: ConversationQualityCase[] = [
    { id: "ok", name: "ok", query: "hi", assertions: [{ type: "turn_route", route: "direct" }] },
    { id: "boom", name: "boom", query: "hi", assertions: [{ type: "turn_route", route: "direct" }] },
  ];

  it("degrades a throwing runner to an error outcome without aborting the suite", async () => {
    const runner: ConversationQualityRunnerPort = {
      async run(evalCase) {
        if (evalCase.id === "boom") {
          throw new Error("runner exploded");
        }
        return observed({ turnTrace: trace([{ id: "turn_interpretation", kind: "turn_interpretation", status: "applied", outputs: { route: "direct" } }]) });
      },
    };
    const { outcomes } = await runConversationQualitySuite(cases, runner, { workspaceId: "ws" });
    expect(outcomes).toEqual([
      { caseId: "ok", name: "ok", status: "pass" },
      { caseId: "boom", name: "boom", status: "error" },
    ]);
  });
});

const coveredRefundReply = canonicalAnswerEnvelope({
  coverage: "answered_sufficient_evidence",
  requestFocus: "the refund window",
  outcome: "answer",
  answer: "Yes. You can request a full refund within 30 days of purchase[[1]].",
  claims: [[1]],
  grounding: "grounded",
});

const uncoveredDiscountReply = canonicalAnswerEnvelope({
  coverage: "unanswered_insufficient_evidence",
  requestFocus: "a nonprofit discount",
  outcome: "no_support",
  answer: "I don't have information about a nonprofit discount.",
  claims: [],
  grounding: "degraded",
});

describe("review execution mode", () => {
  const reviewCase: ConversationQualityCase = {
    id: "review-refund",
    name: "review refund",
    executionMode: "review",
    history: [
      { role: "user", content: "Hello, I have a question about my order." },
      { role: "assistant", content: "Happy to help. What would you like to know?" },
    ],
    query: "Can I still get a full refund two weeks after buying?",
    assertions: [
      { type: "turn_grounding_verdict", verdict: "grounded" },
      { type: "turn_answer_coverage", coverage: "answered" },
      { type: "turn_persists_no_reply" },
    ],
  };

  const passed = (report: CaseReport | undefined): void => {
    if (report?.status !== "pass") {
      throw new Error(`expected pass, got ${report?.status}: ${JSON.stringify(report?.verdicts, null, 2)}`);
    }
  };

  it("drives a review case through ChatService.review(), never answer(), and scores the review facts", async () => {
    const harness = conversationQualityChatHarness({ reply: coveredRefundReply });
    const answer = vi.spyOn(harness.service, "answer");
    const review = vi.spyOn(harness.service, "review");

    const { reports } = await runConversationQualitySuite([reviewCase], harness.port, { workspaceId: "ws" });

    passed(reports[0]);
    expect(review).toHaveBeenCalledOnce();
    expect(answer).not.toHaveBeenCalled();
    expect(harness.routineProvider.forTurn).not.toHaveBeenCalled();
    expect(harness.routineStore.loadActive).not.toHaveBeenCalled();
  });

  it("drives a case without executionMode through ChatService.answer() exactly as before", async () => {
    const harness = conversationQualityChatHarness({ reply: coveredRefundReply });
    const answer = vi.spyOn(harness.service, "answer");
    const review = vi.spyOn(harness.service, "review");
    const liveCase: ConversationQualityCase = {
      id: "live-refund",
      name: "live refund",
      query: "Can I still get a full refund two weeks after buying?",
      assertions: [
        { type: "answer_contains", pattern: "30 days", matchMode: "substring" },
        { type: "turn_answer_coverage", coverage: "answered" },
      ],
    };

    const { reports } = await runConversationQualitySuite([liveCase], harness.port, { workspaceId: "ws" });

    passed(reports[0]);
    expect(answer).toHaveBeenCalledOnce();
    expect(review).not.toHaveBeenCalled();
  });

  it("routes each sample of a review case to review() in the sampled runner", async () => {
    const run = vi.fn(async () => observed());
    const review = vi.fn(async () => observed({ reviewTurn: { answerCoverage: null, persistedAssistantMessageCount: 0 } }));
    const noReplyCase: ConversationQualityCase = { ...reviewCase, assertions: [{ type: "turn_persists_no_reply" }] };

    const { outcomes } = await runConversationQualitySuiteSampled([noReplyCase], { run, review }, {
      workspaceId: "ws",
      samples: 3,
      passThreshold: 1,
    });

    expect(outcomes[0]?.status).toBe("pass");
    expect(review).toHaveBeenCalledTimes(3);
    expect(review).toHaveBeenCalledWith(noReplyCase);
    expect(run).not.toHaveBeenCalled();
  });

  it("errors a review case on a runner that cannot drive review turns instead of running it live", async () => {
    const run = vi.fn(async () => observed());

    const { reports } = await runConversationQualitySuite([reviewCase], { run }, { workspaceId: "ws" });

    expect(reports[0]?.status).toBe("error");
    expect(reports[0]?.reason).toContain("review");
    expect(run).not.toHaveBeenCalled();
  });

  it("passes the email-tagged seed cases through ChatService.review()", async () => {
    const scriptedReplies: Record<string, string> = {
      "email-review-covered-refund": coveredRefundReply,
      "email-review-uncovered-nonprofit-discount": uncoveredDiscountReply,
    };
    const emailCases = conversationQualityCases.filter((evalCase) => evalCase.tags?.includes("email"));
    expect(emailCases.map((evalCase) => evalCase.id).sort()).toEqual(Object.keys(scriptedReplies).sort());

    for (const evalCase of emailCases) {
      const harness = conversationQualityChatHarness({ reply: scriptedReplies[evalCase.id] });
      const answer = vi.spyOn(harness.service, "answer");

      const { reports } = await runConversationQualitySuite([evalCase], harness.port, { workspaceId: "ws" });

      passed(reports[0]);
      expect(answer).not.toHaveBeenCalled();
    }
  });
});

// #1575: the withheld-figures case driven through the real chat pipeline with a scripted
// model reply, so the commitment the answer writes before `answer` is covered end to end:
// envelope schema, side-channel resolution, compose trace, persisted unmet grade.
describe("withheld-figures directive through the chat pipeline", () => {
  const withheldCase = conversationQualityCases.find((evalCase) => evalCase.id === "directive-withholds-figures-it")!;
  const directive: Directive = {
    name: pricesFromTheCoursePageDirective.name,
    condition: pricesFromTheCoursePageDirective.condition,
    action: pricesFromTheCoursePageDirective.action,
    priority: 75,
  };
  // The harness records no retrieved chunks; the route, commitment, and answer assertions are its to check.
  const pipelineCase: ConversationQualityCase = {
    ...withheldCase,
    assertions: withheldCase.assertions.filter((assertion) => !assertion.type.startsWith("retrieval_")),
  };
  // `satisfied` absent: the reply returns the commitment but no grade for the directive.
  const scriptedReply = (input: { answer: string; satisfied?: boolean }) => canonicalAnswerEnvelope({
    coverage: "answered_sufficient_evidence",
    requestFocus: "the full cost of the residential course",
    outcome: "answer",
    adherencePlan: [{ rule: "d1", commitment: "leave out every fee; point to the course page and reception" }],
    answer: input.answer,
    claims: [[1]],
    grounding: "grounded",
    adherence: input.satisfied === undefined
      ? []
      : [{ rule: "d1", satisfied: input.satisfied, applicable: true, note: input.satisfied ? "no fees stated" : "fees stated" }],
  });
  const runCase = async (reply: { answer: string; satisfied?: boolean }) => {
    const harness = conversationQualityChatHarness({
      reply: scriptedReply(reply),
      retrievedDocumentId: MOUNTAIN_COURSE_DOC_ID,
      directives: [directive],
    });
    const { reports } = await runConversationQualitySuite([pipelineCase], harness.port, { workspaceId: "ws" });
    const [assistantMessage] = [...harness.messageRepository.items.values()].flat().filter((message) => message.role === "assistant");
    return { report: reports[0], assistantMessage, metrics: harness.metrics.renderPrometheus() };
  };
  const withheldAnswer =
    "Il corso comprende pratica, meditazione e pasti vegetariani[[1]]. Le quote aggiornate sono sulla pagina del corso; per prenotare scrivi alla reception.";

  it("passes an answer that commits to leaving the fees out and leaves them out", async () => {
    const { report, assistantMessage } = await runCase({ answer: withheldAnswer, satisfied: true });

    if (report?.status !== "pass") {
      throw new Error(`expected pass, got ${report?.status}: ${JSON.stringify(report?.verdicts, null, 2)}`);
    }
    expect(assistantMessage?.metadata).not.toHaveProperty("unmetDirectives");
  });

  it("fails an answer that quotes the fees, and persists its own unmet grade for Quality", async () => {
    const { report, assistantMessage } = await runCase({
      answer: "La quota del programma è di 345 € e la camera singola costa 310 €[[1]].",
      satisfied: false,
    });

    expect(report?.status).toBe("fail");
    expect(report?.verdicts.filter((verdict) => verdict.status === "fail").map((verdict) => verdict.assertion.type))
      .toEqual(["answer_does_not_contain", "answer_does_not_contain", "answer_does_not_contain"]);
    expect(assistantMessage?.metadata?.unmetDirectives).toEqual(["prices-from-the-course-page"]);
  });

  it("records a directive the answer returned no grade for as ungraded on the compose stage and in the verdict counter", async () => {
    const { report, assistantMessage, metrics } = await runCase({ answer: withheldAnswer });

    const committed = report?.verdicts.find((verdict) => verdict.assertion.type === "turn_directive_committed");
    expect(committed?.status).toBe("fail");
    expect(committed?.reason).toContain("ungraded");
    expect(assistantMessage?.metadata).not.toHaveProperty("unmetDirectives");
    expect(metrics).toMatch(/chat_directive_adherence_verdicts_total\{verdict="ungraded"\} 1\b/);
    expect(metrics).not.toMatch(/chat_directive_adherence_verdicts_total\{verdict="satisfied"\}/);
  });
});

describe("reduceSamples", () => {
  const score = (status: "pass" | "fail" | "error" | "recorded", reason = status) => ({ status, reason, verdicts: [] });

  it("passes a unanimous case and marks it not flaky", () => {
    const reduced = reduceSamples([score("pass"), score("pass"), score("pass")], 1);
    expect(reduced.status).toBe("pass");
    expect(reduced.passRate).toBe(1);
    expect(reduced.flaky).toBe(false);
  });

  it("fails a flaky case under a unanimous threshold but passes it under a lower one", () => {
    const samples = [score("pass"), score("pass"), score("pass"), score("fail"), score("fail")];
    const strict = reduceSamples(samples, 1);
    expect(strict.status).toBe("fail");
    expect(strict.flaky).toBe(true);
    expect(strict.passCount).toBe(3);
    expect(strict.passRate).toBeCloseTo(0.6);

    const lenient = reduceSamples(samples, 0.5);
    expect(lenient.status).toBe("pass");
    expect(lenient.flaky).toBe(true);
  });

  it("reports error only when every non-pass sample errored, and recorded when all recorded", () => {
    expect(reduceSamples([score("error"), score("error")], 1).status).toBe("error");
    expect(reduceSamples([score("recorded"), score("recorded")], 1).status).toBe("recorded");
    // a real failure alongside an error is a fail, not an error
    expect(reduceSamples([score("fail"), score("error")], 1).status).toBe("fail");
  });

  it("never calls an all-errored case a pass, whatever the threshold", () => {
    // The threshold is a bar for how often a case passes, not a licence to call an outage a pass.
    // At `--pass-threshold 0` the rate check fired first and 0 >= 0 reduced every-sample-errored to
    // `pass`, which would record `status: "pass"` at `passRate: 0`.
    const errored = [
      { status: "error" as const, reason: "provider down", verdicts: [] },
      { status: "error" as const, reason: "provider down", verdicts: [] },
    ];

    expect(reduceSamples(errored, 0).status).toBe("error");
    expect(reduceSamples(errored, 1).status).toBe("error");
  });

  it("still passes a genuinely failing case once the threshold allows it", () => {
    const mixed = [
      { status: "pass" as const, reason: null, verdicts: [] },
      { status: "fail" as const, reason: "nope", verdicts: [] },
    ];

    expect(reduceSamples(mixed, 0.5).status).toBe("pass");
    expect(reduceSamples(mixed, 1).status).toBe("fail");
  });

  it("excludes recorded samples from the pass rate", () => {
    const reduced = reduceSamples([score("recorded"), score("pass"), score("pass")], 1);
    expect(reduced.status).toBe("pass");
    expect(reduced.passRate).toBe(1);
  });
});

describe("runConversationQualitySuiteSampled", () => {
  it("runs each case K times and reduces a flaky case to a threshold-gated status", async () => {
    const cases: ConversationQualityCase[] = [
      { id: "flaky", name: "flaky", query: "hi", assertions: [{ type: "turn_route", route: "retrieval" }] },
    ];
    let call = 0;
    const runner: ConversationQualityRunnerPort = {
      async run() {
        // Alternate route so 2 of 4 samples pass — a flaky case.
        const route = call++ % 2 === 0 ? "retrieval" : "direct";
        return observed({ turnTrace: trace([{ id: "turn_interpretation", kind: "turn_interpretation", status: "applied", outputs: { route } }]) });
      },
    };
    const { reports, outcomes } = await runConversationQualitySuiteSampled(cases, runner, {
      workspaceId: "ws",
      samples: 4,
      passThreshold: 1,
    });
    expect(reports[0]?.samples).toBe(4);
    expect(reports[0]?.passCount).toBe(2);
    expect(reports[0]?.flaky).toBe(true);
    expect(outcomes[0]?.status).toBe("fail");
  });

  it("measures a zero-tolerance case's judge on every graded sample, leaving judge errors to the case rate", async () => {
    const judged = (id: string, tags?: string[]): ConversationQualityCase => ({
      id,
      name: id,
      query: "hi",
      ...(tags ? { tags } : {}),
      assertions: [{ type: "llm_judge", expectedAnswer: "A short greeting." }],
    });
    const verdicts: AssertionVerdict["status"][] = ["pass", "fail", "pass", "error", "fail"];
    let call = 0;
    const judge: EvalLlmJudgePort = {
      async judge({ assertion }) {
        const status = verdicts[call++ % verdicts.length] ?? "pass";
        return { assertion, status, reason: status } satisfies AssertionVerdict;
      },
    };
    const runner: ConversationQualityRunnerPort = { run: async () => observed({ answer: "Hello!" }) };

    const { outcomes } = await runConversationQualitySuiteSampled(
      [judged("strict", [ZERO_TOLERANCE_JUDGE_TAG]), judged("general")],
      runner,
      { workspaceId: "ws", samples: 5, passThreshold: 1, judge },
    );

    expect(outcomes[0]).toMatchObject({ caseId: "strict", passRate: 0.4, zeroToleranceJudgePassRate: 0.6 });
    expect(outcomes[1]).toMatchObject({ caseId: "general", passRate: 0.4 });
    expect(outcomes[1]).not.toHaveProperty("zeroToleranceJudgePassRate");
  });
});

describe("report", () => {
  it("summarizes a run and surfaces regressions in the text", () => {
    const reports: CaseReport[] = [
      { caseId: "a", name: "A", status: "fail", reason: "nope", verdicts: [{ assertion: { type: "turn_route", route: "direct" }, status: "fail", reason: "was retrieval" }] },
      { caseId: "b", name: "B", status: "pass", reason: null, verdicts: [] },
    ];
    const outcomes = reports.map(({ caseId, name, status }) => ({ caseId, name, status }));
    const summary = summarizeRun(outcomes);
    expect(summary.pass).toBe(1);
    expect(summary.fail).toBe(1);
    const diff = diffAgainstBaseline(outcomes, { cases: { a: "pass" } });
    const text = formatReport(reports, diff, summary);
    expect(text).toContain("REGRESSIONS");
    expect(text).toContain("turn_route");
  });

  it("reports unbaselined cases and sampled-rate regressions as gate failures", () => {
    const reports: CaseReport[] = [
      { caseId: "new", name: "New", status: "fail", reason: "nope", verdicts: [] },
      { caseId: "flaky", name: "Flaky", status: "fail", reason: "nope", verdicts: [], samples: 5, passRate: 0 },
    ];
    const outcomes = reports.map(({ caseId, name, status, passRate, samples }) => ({ caseId, name, status, passRate, samples }));
    const diff = diffAgainstBaseline(outcomes, {
      cases: { flaky: { status: "fail", passRate: 0.8, samples: 5 } },
    });

    const text = formatReport(reports, diff, summarizeRun(outcomes));
    expect(text).toContain("MISSING BASELINE ENTRIES (1) — these fail the run:");
    expect(text).toContain("RATE REGRESSIONS (1) — these fail the run:");
  });

  it("reports under-sampled observations and threshold mismatches as gate failures", () => {
    const reports: CaseReport[] = [
      { caseId: "a", name: "A", status: "fail", reason: "nope", verdicts: [], samples: 1, passRate: 0 },
    ];
    const outcomes = reports.map(({ caseId, name, status, passRate, samples }) => ({ caseId, name, status, passRate, samples }));
    const diff = diffAgainstBaseline(
      outcomes,
      { passThreshold: 0.8, cases: { a: { status: "pass", passRate: 1, samples: 5 } } },
      { passThreshold: 1 },
    );

    const text = formatReport(reports, diff, summarizeRun(outcomes));
    expect(text).toContain("UNDER-SAMPLED REGRESSIONS (1) — these fail the run:");
    expect(text).toContain("BASELINE THRESHOLD MISMATCH — these fail the run:");
  });

  it("reports a zero-tolerance judge regression as a gate failure", () => {
    const reports: CaseReport[] = [
      { caseId: "qr", name: "QR", status: "fail", reason: "claim", verdicts: [], samples: 5, passRate: 0.6 },
    ];
    const diff = diffAgainstBaseline(
      [{ caseId: "qr", name: "QR", status: "fail", passRate: 0.6, samples: 5, zeroToleranceJudgePassRate: 0.6 }],
      { cases: { qr: { status: "pass", passRate: 1, samples: 5 } } },
    );

    const text = formatReport(reports, diff, summarizeRun([{ caseId: "qr", name: "QR", status: "fail" }]));
    expect(text).toContain("ZERO-TOLERANCE JUDGE REGRESSIONS (1) — these fail the run:");
    expect(text).toContain('qr "QR": 100% → 60% judge pass rate');
  });
});

describe("seed fixtures", () => {
  it("compiles every seed routine", () => {
    for (const routine of conversationQualityRoutines) {
      expect(() => compileRoutineDefinition(routine)).not.toThrow();
    }
  });

  it("attaches the four seed directives to the agent config", () => {
    expect(conversationQualityAgentConfig.authoredDirectives.map((directive) => directive.name).sort()).toEqual([
      "maximally-helpful",
      "pricing-precision",
      "refund-empathy",
      "security-precision",
    ]);
  });

  it("holds the quick-reply no-facts judge to zero tolerance and leaves the clarification judge on the general tolerance", () => {
    const strict = conversationQualityCases
      .filter((evalCase) => evalCase.tags?.includes(ZERO_TOLERANCE_JUDGE_TAG))
      .map((evalCase) => evalCase.id);
    const quickReplyJudged = conversationQualityCases
      .filter((evalCase) => evalCase.tags?.includes("quick-reply") && evalCase.assertions.some((assertion) => assertion.type === "llm_judge"))
      .map((evalCase) => evalCase.id);

    expect(strict.every((id) => quickReplyJudged.includes(id))).toBe(true);
    expect(quickReplyJudged.filter((id) => !strict.includes(id))).toEqual(["quick-reply-not-ack-pending-clarification"]);
    expect(strict).toContain("quick-reply-unlisted-language-standing-directive");
  });

  it("adds each probe directive only to its own case, never to the seeded agent", () => {
    const overridden = conversationQualityCases.filter((evalCase) => evalCase.agentConfigOverride?.authoredDirectives);
    const seededNames = conversationQualityAgentConfig.authoredDirectives.map((directive) => directive.name);
    expect(Object.fromEntries(overridden.map((evalCase) => [
      evalCase.id,
      evalCase.agentConfigOverride?.authoredDirectives?.map((directive) => directive.name),
    ]))).toEqual({
      "routine-step-outranks-always-on-handoff-directive": [...seededNames, "contact-form-only"],
      "quick-reply-unlisted-language-standing-directive": [...seededNames, "listed-languages"],
      "directive-withholds-figures-it": [...seededNames, "prices-from-the-course-page"],
      "directive-withholds-figures-en": [...seededNames, "prices-from-the-course-page"],
    });
    expect(seededNames).not.toContain("contact-form-only");
    expect(seededNames).not.toContain("listed-languages");
    expect(seededNames).not.toContain("prices-from-the-course-page");
  });

  it("validates the seed cases against the schema with unique ids", () => {
    const parsed = parseConversationQualityCases(conversationQualityCases);
    expect(parsed).toHaveLength(conversationQualityCases.length);
  });

  it("validates page context and page-read capability inputs", () => {
    const [parsed] = parseConversationQualityCases([
      {
        id: "page-read",
        name: "page read",
        query: "Summarize this page.",
        pageContext: {
          pageUrl: "https://example.com/release",
          pageTitle: "Release notes",
          pageLocale: "en",
          browserLocale: "en-US",
          content: "The release is named Blue Heron.",
        },
        clientContextCapabilities: {
          "page.read": {
            available: true,
            mode: "content",
            supportedOperations: ["metadata", "lookup", "summarize"],
          },
        },
        assertions: [],
      },
    ]);

    expect(parsed?.pageContext?.content).toContain("Blue Heron");
    expect(parsed?.clientContextCapabilities?.["page.read"]?.mode).toBe("content");
  });

  it("rejects malformed page-read capability inputs", () => {
    expect(() =>
      parseConversationQualityCases([
        {
          id: "page-read",
          name: "page read",
          query: "Summarize this page.",
          clientContextCapabilities: {
            "page.read": {
              available: true,
              mode: "content",
              supportedOperations: ["transform"],
            },
          },
          assertions: [],
        },
      ]),
    ).toThrow();
  });

  it("accepts a routine invocation in place of a query and rejects a case with neither", () => {
    const [parsed] = parseConversationQualityCases([
      {
        id: "invoke",
        name: "invoke",
        routineInvocation: { toolName: "start_return", input: { orderId: "A-1001", reason: "Wrong size" } },
        assertions: [{ type: "turn_skips_skill", skillName: "create_return_ticket" }],
      },
    ]);
    expect(parsed?.routineInvocation).toEqual({ toolName: "start_return", input: { orderId: "A-1001", reason: "Wrong size" } });
    expect(parsed?.query).toBeUndefined();
    expect(() => parseConversationQualityCases([{ id: "neither", name: "neither", assertions: [] }])).toThrow();
    expect(() => parseConversationQualityCases([
      { id: "both", name: "both", query: "hi", routineInvocation: { toolName: "start_return", input: {} }, assertions: [] },
    ])).toThrow();
  });

  it("only references document and routine ids that exist in the fixtures", () => {
    const documentIds = new Set(conversationQualityCorpus.map((doc) => doc.id));
    const routineIds = new Set(conversationQualityRoutines.map((routine) => routine.id));
    for (const evalCase of conversationQualityCases) {
      for (const assertion of evalCase.assertions) {
        if ("documentId" in assertion) {
          expect(documentIds.has(assertion.documentId)).toBe(true);
        }
        if ("routineId" in assertion) {
          expect(routineIds.has(assertion.routineId)).toBe(true);
        }
      }
    }
  });

  it("accepts a review case and rejects one carrying an input a review turn cannot take", () => {
    const review = { id: "review", name: "review", executionMode: "review", query: "Can I get a refund?", assertions: [] };
    const [parsed] = parseConversationQualityCases([review]);
    expect(parsed?.executionMode).toBe("review");

    expect(() => parseConversationQualityCases([{ ...review, executionMode: "safe_test" }])).toThrow();
    expect(() => parseConversationQualityCases([
      { ...review, query: undefined, routineInvocation: { toolName: "start_return", input: {} } },
    ])).toThrow();
    expect(() => parseConversationQualityCases([
      { ...review, routineStartState: { routineId: "r", path: ["s1"], variables: {}, status: "active" } },
    ])).toThrow();
    expect(() => parseConversationQualityCases([{ ...review, pageContext: { content: "page" } }])).toThrow();
    expect(() => parseConversationQualityCases([
      { ...review, clientContextCapabilities: { "page.read": { available: false, mode: null, supportedOperations: [] } } },
    ])).toThrow();
    expect(() => parseConversationQualityCases([{ ...review, agentConfigOverride: {} }])).toThrow();
  });

  it("ships two email review cases asserting only that no reply is persisted", () => {
    // A live review turn can end without a grounding or coverage verdict, so the email cases
    // assert the one review fact every sample carries.
    const emailCases = conversationQualityCases.filter((evalCase) => evalCase.tags?.includes("email"));
    expect(emailCases).toHaveLength(2);
    for (const evalCase of emailCases) {
      expect(evalCase.executionMode).toBe("review");
      expect(evalCase.assertions).toEqual([{ type: "turn_persists_no_reply" }]);
    }
  });

  it("rejects a dataset with duplicate case ids", () => {
    expect(() =>
      parseConversationQualityCases([
        { id: "dup", name: "one", query: "q", assertions: [] },
        { id: "dup", name: "two", query: "q", assertions: [] },
      ]),
    ).toThrow(/Duplicate/);
  });
});
