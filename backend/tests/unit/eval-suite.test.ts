import { describe, expect, it } from "vitest";

import { summarizeSuite } from "../../src/modules/eval/domain/suite.js";
import {
  EvalSuiteService,
  type EvalSuiteCaseSource,
  type EvalSuiteRunner,
} from "../../src/modules/eval/services/evalSuiteService.js";
import type { EvalRunInput, EvalRunOutcome } from "../../src/modules/eval/services/evalRunService.js";
import type {
  EvalAssertion,
  EvalCase,
  EvalCaseStatus,
  EvalRun,
  EvalRunStatus,
} from "../../src/modules/eval/domain/types.js";
import { evaluateAssertion } from "../../src/modules/eval/domain/outcomes.js";
import {
  eventRetrievalEvalCases,
  eventRetrievalFixtureDocuments,
} from "../fixtures/event-retrieval/event-eval-cases.js";

const fixedDate = "2026-06-28T12:00:00.000Z";

const answerAssertion: EvalAssertion = {
  type: "answer_contains",
  pattern: "refund",
  matchMode: "substring",
};

const makeCase = (overrides: Partial<EvalCase> = {}): EvalCase => ({
  id: "case-1",
  workspaceId: "ws-1",
  snapshotId: "snap-1",
  name: "Refund policy",
  assertions: [answerAssertion],
  status: "pending",
  lastRunId: null,
  createdAt: fixedDate,
  updatedAt: fixedDate,
  ...overrides,
});

const makeRun = (overrides: Partial<EvalRun> = {}): EvalRun => ({
  id: "run-1",
  workspaceId: "ws-1",
  snapshotId: "snap-1",
  caseId: "case-1",
  mode: "full_assistant",
  overrides: {},
  resolvedConfig: {},
  observedOutput: { retrievedChunks: [] },
  assertionVerdicts: [],
  status: "pass",
  outcomeReason: null,
  startedAt: fixedDate,
  completedAt: fixedDate,
  ...overrides,
});

describe("summarizeSuite", () => {
  it("counts only cases with expectations toward the pass rate", () => {
    const summary = summarizeSuite([
      makeCase({ status: "passing" }),
      makeCase({ status: "passing" }),
      makeCase({ status: "failing" }),
      makeCase({ status: "error" }),
      makeCase({ status: "pending" }),
      makeCase({ assertions: [], status: "pending" }),
    ]);

    expect(summary).toEqual({
      total: 6,
      scored: 5,
      passing: 2,
      failing: 1,
      error: 1,
      pending: 1,
      unscored: 1,
    });
  });

  it("returns a zeroed summary for an empty workspace", () => {
    expect(summarizeSuite([])).toEqual({
      total: 0,
      scored: 0,
      passing: 0,
      failing: 0,
      error: 0,
      pending: 0,
      unscored: 0,
    });
  });
});

describe("event retrieval eval fixtures", () => {
  it("defines deterministic event cases against enriched fixture evidence", () => {
    expect(eventRetrievalFixtureDocuments.some((document) => document.shape === "profile")).toBe(true);
    expect(eventRetrievalFixtureDocuments.some((document) => document.shape === "generic")).toBe(true);
    expect(eventRetrievalEvalCases.map((evalCase) => evalCase.id)).toEqual([
      "event-date-cross-paragraph",
      "event-next-events-listing",
      "event-actuality-sort",
    ]);
    expect(eventRetrievalEvalCases[0]?.assertions).toEqual(
      expect.arrayContaining([
        {
          type: "retrieval_chunk_metadata",
          documentId: "11111111-1111-4111-8111-111111111101",
          metadata: { dateFrom: "2026-08-10", dateTo: "2026-08-10" },
        },
      ]),
    );
    expect(eventRetrievalEvalCases[1]?.assertions).toEqual(
      expect.arrayContaining([
        {
          type: "retrieval_document_order",
          documentIds: [
            "11111111-1111-4111-8111-111111111102",
            "11111111-1111-4111-8111-111111111101",
            "11111111-1111-4111-8111-111111111103",
          ],
        },
      ]),
    );
  });

  it("evaluates retrieved evidence metadata and document order without answer prose", () => {
    const observedOutput = {
      retrievedChunks: [
        {
          chunkId: "chunk-next",
          documentId: "11111111-1111-4111-8111-111111111102",
          title: "July Community Clinic",
          rank: 0,
          metadata: { dateFrom: "2026-07-05", dateTo: "2026-07-05" },
        },
        {
          chunkId: "chunk-workshop",
          documentId: "11111111-1111-4111-8111-111111111101",
          title: "Summer Workshop",
          rank: 1,
          metadata: { dateFrom: "2026-08-10", dateTo: "2026-08-10" },
        },
      ],
    };

    expect(evaluateAssertion({
      type: "retrieval_chunk_metadata",
      documentId: "11111111-1111-4111-8111-111111111101",
      metadata: { dateFrom: "2026-08-10", dateTo: "2026-08-10" },
    }, observedOutput)).toMatchObject({ status: "pass" });
    // Enrichment attaches dates only to the chunks overlapping the fact's source
    // range, so the dated chunk may not be the document's first retrieved chunk.
    expect(evaluateAssertion({
      type: "retrieval_chunk_metadata",
      documentId: "11111111-1111-4111-8111-111111111101",
      metadata: { dateFrom: "2026-08-10", dateTo: "2026-08-10" },
    }, {
      retrievedChunks: [
        {
          chunkId: "chunk-workshop-intro",
          documentId: "11111111-1111-4111-8111-111111111101",
          title: "Summer Workshop",
          rank: 0,
          metadata: {},
        },
        ...observedOutput.retrievedChunks,
      ],
    })).toMatchObject({ status: "pass" });
    expect(evaluateAssertion({
      type: "retrieval_chunk_metadata",
      documentId: "11111111-1111-4111-8111-111111111101",
      metadata: { dateFrom: "2027-01-01" },
    }, observedOutput)).toMatchObject({ status: "fail" });
    expect(evaluateAssertion({
      type: "retrieval_document_order",
      documentIds: [
        "11111111-1111-4111-8111-111111111102",
        "11111111-1111-4111-8111-111111111101",
      ],
    }, observedOutput)).toMatchObject({ status: "pass" });
  });
});

class FakeCaseSource implements EvalSuiteCaseSource {
  constructor(private readonly cases: EvalCase[]) {}
  async listCases(workspaceId: string): Promise<EvalCase[]> {
    return this.cases.filter((c) => c.workspaceId === workspaceId);
  }
}

class RecordingRunner implements EvalSuiteRunner {
  public calls: EvalRunInput[] = [];
  constructor(private readonly outcomeFor: (input: EvalRunInput) => EvalRunOutcome | Promise<EvalRunOutcome>) {}
  async execute(input: EvalRunInput): Promise<EvalRunOutcome> {
    this.calls.push(input);
    return this.outcomeFor(input);
  }
}

const outcomeWithStatus = (caseId: string, runStatus: EvalRunStatus, caseStatus: EvalCaseStatus): EvalRunOutcome => ({
  run: makeRun({ id: `run-${caseId}`, caseId, status: runStatus }),
  case: makeCase({ id: caseId, status: caseStatus }),
});

describe("EvalSuiteService.run", () => {
  it("runs every scored case and reports a fresh aggregate", async () => {
    const cases = [
      makeCase({ id: "case-1", snapshotId: "snap-1" }),
      makeCase({ id: "case-2", snapshotId: "snap-2" }),
    ];
    const runner = new RecordingRunner((input) =>
      input.caseId === "case-1"
        ? outcomeWithStatus("case-1", "pass", "passing")
        : outcomeWithStatus("case-2", "fail", "failing"),
    );
    const service = new EvalSuiteService(new FakeCaseSource(cases), runner);

    const result = await service.run({ workspaceId: "ws-1", accountId: "acct-1" });

    expect(runner.calls).toHaveLength(2);
    expect(runner.calls.every((c) => c.mode === "full_assistant")).toBe(true);
    expect(result.results.map((r) => r.status)).toEqual(["pass", "fail"]);
    expect(result.summary).toMatchObject({ total: 2, scored: 2, passing: 1, failing: 1 });
  });

  it("skips cases with no expectations instead of running them", async () => {
    const cases = [
      makeCase({ id: "case-1", assertions: [] }),
      makeCase({ id: "case-2" }),
    ];
    const runner = new RecordingRunner(() => outcomeWithStatus("case-2", "pass", "passing"));
    const service = new EvalSuiteService(new FakeCaseSource(cases), runner);

    const result = await service.run({ workspaceId: "ws-1" });

    expect(runner.calls.map((c) => c.caseId)).toEqual(["case-2"]);
    expect(result.results[0]).toMatchObject({ caseId: "case-1", status: "skipped", run: null });
    expect(result.summary).toMatchObject({ total: 2, scored: 1, unscored: 1, passing: 1 });
  });

  it("isolates a single failing case run so the rest of the suite still completes", async () => {
    // case-1 was passing before, but its run now throws before any run is
    // recorded (e.g. its snapshot went missing). It must NOT still count as
    // passing in the aggregate — the rate has to match the per-case result.
    const cases = [
      makeCase({ id: "case-1", snapshotId: "snap-1", status: "passing" }),
      makeCase({ id: "case-2", snapshotId: "snap-2", status: "passing" }),
    ];
    const runner = new RecordingRunner((input) => {
      if (input.caseId === "case-1") {
        throw new Error("snapshot exploded");
      }
      return outcomeWithStatus("case-2", "pass", "passing");
    });
    const service = new EvalSuiteService(new FakeCaseSource(cases), runner);

    const result = await service.run({ workspaceId: "ws-1" });

    expect(result.results[0]).toMatchObject({ caseId: "case-1", status: "error", error: "snapshot exploded" });
    expect(result.results[1]).toMatchObject({ caseId: "case-2", status: "pass" });
    // The thrown case is counted as errored (not its stale passing status); the
    // other reflects its fresh passing run.
    expect(result.summary).toMatchObject({ total: 2, scored: 2, passing: 1, error: 1 });
  });

  it("forwards an explicit run mode to each case", async () => {
    const runner = new RecordingRunner(() => outcomeWithStatus("case-1", "pass", "passing"));
    const service = new EvalSuiteService(new FakeCaseSource([makeCase()]), runner);

    await service.run({ workspaceId: "ws-1", mode: "retrieval_only" });

    expect(runner.calls[0]?.mode).toBe("retrieval_only");
  });

  it("runs only the selected cases but reports the whole-suite pass rate", async () => {
    // case-2 starts failing; the operator runs only case-2 after a fix. The
    // headline must roll up ALL cases (case-1 + case-3 untouched + case-2 now
    // passing), not just the one that ran.
    const cases = [
      makeCase({ id: "case-1", snapshotId: "snap-1", status: "passing" }),
      makeCase({ id: "case-2", snapshotId: "snap-2", status: "failing" }),
      makeCase({ id: "case-3", snapshotId: "snap-3", status: "passing" }),
    ];
    const runner = new RecordingRunner(() => outcomeWithStatus("case-2", "pass", "passing"));
    const service = new EvalSuiteService(new FakeCaseSource(cases), runner);

    const result = await service.run({ workspaceId: "ws-1", caseIds: ["case-2"] });

    // Only the selected case ran.
    expect(runner.calls.map((c) => c.caseId)).toEqual(["case-2"]);
    expect(result.results).toHaveLength(1);
    expect(result.results[0]).toMatchObject({ caseId: "case-2", status: "pass" });
    // But the summary covers all three: case-1 + case-3 stay passing, case-2 now passing.
    expect(result.summary).toMatchObject({ total: 3, scored: 3, passing: 3, failing: 0 });
  });

  it("ignores unknown/foreign case ids in the selection", async () => {
    const cases = [makeCase({ id: "case-1", status: "passing" })];
    const runner = new RecordingRunner(() => outcomeWithStatus("case-1", "pass", "passing"));
    const service = new EvalSuiteService(new FakeCaseSource(cases), runner);

    const result = await service.run({ workspaceId: "ws-1", caseIds: ["case-1", "ghost"] });

    expect(runner.calls.map((c) => c.caseId)).toEqual(["case-1"]);
    expect(result.summary).toMatchObject({ total: 1, scored: 1, passing: 1 });
  });
});
