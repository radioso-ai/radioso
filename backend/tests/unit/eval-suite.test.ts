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

describe("EvalSuiteService.runAll", () => {
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

    const result = await service.runAll({ workspaceId: "ws-1", accountId: "acct-1" });

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

    const result = await service.runAll({ workspaceId: "ws-1" });

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

    const result = await service.runAll({ workspaceId: "ws-1" });

    expect(result.results[0]).toMatchObject({ caseId: "case-1", status: "error", error: "snapshot exploded" });
    expect(result.results[1]).toMatchObject({ caseId: "case-2", status: "pass" });
    // The thrown case is counted as errored (not its stale passing status); the
    // other reflects its fresh passing run.
    expect(result.summary).toMatchObject({ total: 2, scored: 2, passing: 1, error: 1 });
  });

  it("forwards an explicit run mode to each case", async () => {
    const runner = new RecordingRunner(() => outcomeWithStatus("case-1", "pass", "passing"));
    const service = new EvalSuiteService(new FakeCaseSource([makeCase()]), runner);

    await service.runAll({ workspaceId: "ws-1", mode: "retrieval_only" });

    expect(runner.calls[0]?.mode).toBe("retrieval_only");
  });
});
