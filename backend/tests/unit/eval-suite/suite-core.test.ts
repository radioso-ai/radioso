import { describe, expect, it } from "vitest";

import { compileRoutineDefinition } from "../../../src/modules/routines/compiler.js";
import type { AssertionVerdict, EvalRunObservedOutput } from "../../../src/modules/eval/domain/types.js";
import {
  buildBaselineFile,
  diffAgainstBaseline,
  evaluateTraceAssertion,
  formatReport,
  isBaselineInitialized,
  parseConversationQualityCases,
  reduceSamples,
  runConversationQualitySuite,
  runConversationQualitySuiteSampled,
  scoreObservedOutput,
  summarizeRun,
  type CaseReport,
  type ConversationQualityCase,
  type ConversationQualityRunnerPort,
  type SuiteTraceAssertion,
} from "../../../src/modules/eval/suite/index.js";
import type { EvalLlmJudgePort } from "../../../src/modules/eval/services/evalJudge.js";
import {
  BOOK_DEMO_ROUTINE_ID,
  CONTACT_SUPPORT_ROUTINE_ID,
  conversationQualityAgentConfig,
  conversationQualityCases,
  conversationQualityRoutines,
} from "../../fixtures/conversation-quality/index.js";
import { conversationQualityCorpus } from "../../fixtures/conversation-quality/corpus.js";

const observed = (overrides: Partial<EvalRunObservedOutput> = {}): EvalRunObservedOutput => ({
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

  it("passes turn_uses_skill on a matching dispatch stage", () => {
    const output = observed({
      turnTrace: trace([{ id: "dispatch:retrieval.answer", kind: "skill_dispatch", status: "applied", outputs: { skillName: "retrieval.answer" } }]),
    });
    expect(evaluateTraceAssertion({ type: "turn_uses_skill", skillName: "retrieval.answer" }, output).status).toBe("pass");
    expect(evaluateTraceAssertion({ type: "turn_uses_skill", skillName: "clarification.answer" }, output).status).toBe("fail");
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
        { type: "turn_route", route: "retrieval" } as SuiteTraceAssertion,
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
      [{ type: "turn_route", route: "retrieval" } as SuiteTraceAssertion],
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

  it("treats an empty baseline as uninitialized (so the runner can gate on it)", () => {
    expect(isBaselineInitialized({ cases: {} })).toBe(false);
    expect(isBaselineInitialized({ cases: { a: "pass" } })).toBe(true);
  });

  it("builds a sorted baseline file", () => {
    const file = buildBaselineFile(
      [
        { caseId: "b", name: "B", status: "pass" },
        { caseId: "a", name: "A", status: "fail" },
      ],
      "2026-01-01T00:00:00.000Z",
    );
    expect(Object.keys(file.cases)).toEqual(["a", "b"]);
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
});

describe("seed fixtures", () => {
  it("compiles every seed routine", () => {
    for (const routine of conversationQualityRoutines) {
      expect(() => compileRoutineDefinition(routine)).not.toThrow();
    }
  });

  it("attaches the three seed directives to the agent config", () => {
    expect(conversationQualityAgentConfig.authoredDirectives.map((directive) => directive.name).sort()).toEqual([
      "pricing-precision",
      "refund-empathy",
      "security-precision",
    ]);
  });

  it("validates the seed cases against the schema with unique ids", () => {
    const parsed = parseConversationQualityCases(conversationQualityCases);
    expect(parsed).toHaveLength(conversationQualityCases.length);
  });

  it("only references document and routine ids that exist in the fixtures", () => {
    const documentIds = new Set(conversationQualityCorpus.map((doc) => doc.id));
    const routineIds = new Set([CONTACT_SUPPORT_ROUTINE_ID, BOOK_DEMO_ROUTINE_ID]);
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

  it("rejects a dataset with duplicate case ids", () => {
    expect(() =>
      parseConversationQualityCases([
        { id: "dup", name: "one", query: "q", assertions: [] },
        { id: "dup", name: "two", query: "q", assertions: [] },
      ]),
    ).toThrow(/Duplicate/);
  });
});
