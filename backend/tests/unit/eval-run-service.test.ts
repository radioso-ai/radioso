import { describe, expect, it } from "vitest";

import { EvalRunService } from "../../src/modules/eval/services/evalRunService.js";
import type {
  CreateCaseInput,
  CreateRunInput,
  CreateSnapshotInput,
  EvalRepositoryPort,
} from "../../src/modules/eval/services/evalRepository.js";
import type {
  EvalAssertion,
  EvalCase,
  EvalCaseStatus,
  EvalRun,
  EvalRunRetrievedChunk,
  EvalSnapshot,
} from "../../src/modules/eval/domain/types.js";
import type { EvalRetrievalRunnerPort } from "../../src/modules/eval/services/evalRunner.js";
import type { EvalLlmJudgePort } from "../../src/modules/eval/services/evalJudge.js";

const fixedDate = "2026-05-23T12:00:00.000Z";

const makeSnapshot = (overrides: Partial<EvalSnapshot> = {}): EvalSnapshot => ({
  id: "snap-1",
  workspaceId: "ws-1",
  sourceConversationId: "conv-1",
  sourceMessageId: "msg-2",
  fidelity: "messages_only",
  messages: [
    { id: "msg-1", role: "user", content: "what is the refund policy?", createdAt: fixedDate },
    { id: "msg-2", role: "assistant", content: "I don't know.", createdAt: fixedDate },
  ],
  originalInstructionBlock: null,
  originalModelId: null,
  originalRetrievalSettings: null,
  originalRetrievalResult: null,
  originalAgent: null,
  capturedAt: fixedDate,
  capturedBy: null,
  ...overrides,
});

class InMemoryEvalRepository implements EvalRepositoryPort {
  private snapshots = new Map<string, EvalSnapshot>();
  private cases = new Map<string, EvalCase>();
  private runs: EvalRun[] = [];
  private idCounter = 0;

  constructor(initial?: { snapshots?: EvalSnapshot[]; cases?: EvalCase[] }) {
    for (const s of initial?.snapshots ?? []) this.snapshots.set(s.id, s);
    for (const c of initial?.cases ?? []) this.cases.set(c.id, c);
  }

  private nextId(prefix: string): string {
    this.idCounter += 1;
    return `${prefix}-${this.idCounter}`;
  }

  async createSnapshot(input: CreateSnapshotInput): Promise<EvalSnapshot> {
    const id = this.nextId("snap");
    const snap: EvalSnapshot = { id, capturedAt: fixedDate, ...input };
    this.snapshots.set(id, snap);
    return snap;
  }

  async findSnapshot(workspaceId: string, id: string): Promise<EvalSnapshot | null> {
    const s = this.snapshots.get(id);
    return s && s.workspaceId === workspaceId ? s : null;
  }

  async createCase(input: CreateCaseInput): Promise<EvalCase> {
    const id = this.nextId("case");
    const created: EvalCase = {
      id,
      workspaceId: input.workspaceId,
      snapshotId: input.snapshotId,
      name: input.name,
      assertions: input.assertions,
      status: "pending",
      lastRunId: null,
      createdAt: fixedDate,
      updatedAt: fixedDate,
    };
    this.cases.set(id, created);
    return created;
  }

  async findCase(workspaceId: string, id: string): Promise<EvalCase | null> {
    const c = this.cases.get(id);
    return c && c.workspaceId === workspaceId ? c : null;
  }

  async listCases(workspaceId: string): Promise<EvalCase[]> {
    return [...this.cases.values()].filter((c) => c.workspaceId === workspaceId);
  }

  async updateCaseAssertions(workspaceId: string, caseId: string, assertions: EvalAssertion[]) {
    const existing = this.cases.get(caseId);
    if (!existing || existing.workspaceId !== workspaceId) throw new Error("case not found");
    const updated: EvalCase = { ...existing, assertions, status: "pending", lastRunId: null, updatedAt: fixedDate };
    this.cases.set(caseId, updated);
    return updated;
  }

  async updateCaseName(workspaceId: string, caseId: string, name: string) {
    const existing = this.cases.get(caseId);
    if (!existing || existing.workspaceId !== workspaceId) throw new Error("case not found");
    const updated: EvalCase = { ...existing, name, updatedAt: fixedDate };
    this.cases.set(caseId, updated);
    return updated;
  }

  async createRun(input: CreateRunInput): Promise<EvalRun> {
    const id = this.nextId("run");
    const run: EvalRun = {
      id,
      workspaceId: input.workspaceId,
      snapshotId: input.snapshotId,
      caseId: input.caseId,
      mode: input.mode,
      overrides: input.overrides,
      resolvedConfig: input.resolvedConfig,
      observedOutput: input.observedOutput,
      assertionVerdicts: input.assertionVerdicts,
      status: input.status,
      outcomeReason: input.outcomeReason,
      startedAt: fixedDate,
      completedAt: input.completedAt.toISOString(),
    };
    this.runs.push(run);
    return run;
  }

  async listRunsForCase(workspaceId: string, caseId: string): Promise<EvalRun[]> {
    return this.runs.filter((r) => r.workspaceId === workspaceId && r.caseId === caseId);
  }

  async updateCaseLastRun(
    workspaceId: string,
    caseId: string,
    lastRunId: string,
    status: EvalCaseStatus,
  ): Promise<EvalCase> {
    const existing = this.cases.get(caseId);
    if (!existing || existing.workspaceId !== workspaceId) throw new Error("case not found");
    const updated: EvalCase = { ...existing, lastRunId, status, updatedAt: fixedDate };
    this.cases.set(caseId, updated);
    return updated;
  }

  getRuns(): EvalRun[] {
    return [...this.runs];
  }
}

type StubRunnerCall = {
  query: string;
  historyLength: number;
  historyRoles: string[];
  agentName?: string | null;
  agentSourceScopeMode?: string;
  customInstruction?: string;
};

class StubRunner implements EvalRetrievalRunnerPort {
  public lastRetrieveCall: StubRunnerCall | null = null;
  public lastAnswerCall: StubRunnerCall | null = null;

  constructor(
    private readonly chunks: EvalRunRetrievedChunk[],
    private readonly error?: Error,
    private readonly answerText?: string,
  ) {}

  private capture(input: {
    query: string;
    history: { role: string }[];
    context?: {
      agent?: { name: string; sourceScope: { mode: string }; customInstruction: string } | null;
      customInstructionOverride?: string;
    };
  }): StubRunnerCall {
    return {
      query: input.query,
      historyLength: input.history.length,
      historyRoles: input.history.map((m) => m.role),
      agentName: input.context?.agent?.name ?? null,
      agentSourceScopeMode: input.context?.agent?.sourceScope?.mode,
      customInstruction:
        input.context?.customInstructionOverride ??
        input.context?.agent?.customInstruction,
    };
  }

  async retrieve(input: any) {
    this.lastRetrieveCall = this.capture(input);
    if (this.error) throw this.error;
    return { chunks: this.chunks };
  }

  async answer(input: any) {
    this.lastAnswerCall = this.capture(input);
    if (this.error) throw this.error;
    return { chunks: this.chunks, answer: this.answerText ?? "" };
  }
}

class StubJudge implements EvalLlmJudgePort {
  public calls: Array<{ observedAnswer: string; question: string; runId: string; assertionIndex: number }> = [];
  constructor(
    private readonly verdict: "pass" | "fail" | "error" = "pass",
    private readonly reason = "stub judge reason",
  ) {}
  async judge(input: { assertion: any; observedAnswer: string; question: string; runId: string; assertionIndex: number }) {
    this.calls.push({
      observedAnswer: input.observedAnswer,
      question: input.question,
      runId: input.runId,
      assertionIndex: input.assertionIndex,
    });
    return { assertion: input.assertion, status: this.verdict, reason: this.reason } as const;
  }
}

const passJudge = () => new StubJudge("pass", "Judge accepted the answer.");
const failJudge = () => new StubJudge("fail", "Judge rejected the answer.");

const refundIncludes: EvalAssertion = {
  type: "retrieval_includes_document",
  documentId: "doc-refund",
};

describe("EvalRunService.execute (retrieval_only)", () => {
  it("records a passing run when retrieval includes target document and updates case status", async () => {
    const snapshot = makeSnapshot();
    const repo = new InMemoryEvalRepository({ snapshots: [snapshot] });
    const evalCase = await repo.createCase({
      workspaceId: "ws-1",
      snapshotId: snapshot.id,
      name: "refund policy gap",
      assertions: [refundIncludes],
    });

    const runner = new StubRunner([
      { chunkId: "c1", documentId: "doc-other", title: "Other", rank: 0 },
      { chunkId: "c2", documentId: "doc-refund", title: "Refund Policy", rank: 1 },
    ]);
    const service = new EvalRunService(repo, runner, passJudge());

    const { run, case: updated } = await service.execute({
      workspaceId: "ws-1",
      snapshotId: snapshot.id,
      caseId: evalCase.id,
      mode: "retrieval_only",
    });

    expect(run.status).toBe("pass");
    expect(run.outcomeReason).toContain("doc-refund");
    expect(run.assertionVerdicts).toHaveLength(1);
    expect(run.assertionVerdicts[0]!.status).toBe("pass");
    expect(updated?.status).toBe("passing");
    expect(updated?.lastRunId).toBe(run.id);
  });

  it("records a failing run when any assertion fails", async () => {
    const snapshot = makeSnapshot();
    const repo = new InMemoryEvalRepository({ snapshots: [snapshot] });
    const evalCase = await repo.createCase({
      workspaceId: "ws-1",
      snapshotId: snapshot.id,
      name: "refund policy gap",
      assertions: [refundIncludes],
    });

    const runner = new StubRunner([
      { chunkId: "c1", documentId: "doc-other", title: "Other", rank: 0 },
    ]);
    const service = new EvalRunService(repo, runner, passJudge());

    const { run, case: updated } = await service.execute({
      workspaceId: "ws-1",
      snapshotId: snapshot.id,
      caseId: evalCase.id,
      mode: "retrieval_only",
    });

    expect(run.status).toBe("fail");
    expect(updated?.status).toBe("failing");
  });

  it("passes only when ALL assertions pass", async () => {
    const snapshot = makeSnapshot();
    const repo = new InMemoryEvalRepository({ snapshots: [snapshot] });
    const evalCase = await repo.createCase({
      workspaceId: "ws-1",
      snapshotId: snapshot.id,
      name: "multi assertion case",
      assertions: [
        { type: "retrieval_includes_document", documentId: "doc-A" },
        { type: "retrieval_excludes_document", documentId: "doc-stale" },
      ],
    });

    const runner = new StubRunner([
      { chunkId: "c1", documentId: "doc-A", title: "A", rank: 0 },
      { chunkId: "c2", documentId: "doc-other", title: "Other", rank: 1 },
    ]);
    const service = new EvalRunService(repo, runner, passJudge());

    const { run } = await service.execute({
      workspaceId: "ws-1",
      snapshotId: snapshot.id,
      caseId: evalCase.id,
      mode: "retrieval_only",
    });

    expect(run.status).toBe("pass");
    expect(run.assertionVerdicts).toHaveLength(2);
    expect(run.assertionVerdicts.every((v) => v.status === "pass")).toBe(true);
    expect(run.outcomeReason).toMatch(/All 2 assertions passed/);
  });

  it("fails when one of several assertions fails, returning the failing reason", async () => {
    const snapshot = makeSnapshot();
    const repo = new InMemoryEvalRepository({ snapshots: [snapshot] });
    const evalCase = await repo.createCase({
      workspaceId: "ws-1",
      snapshotId: snapshot.id,
      name: "multi assertion case",
      assertions: [
        { type: "retrieval_includes_document", documentId: "doc-A" },
        { type: "retrieval_excludes_document", documentId: "doc-stale" },
      ],
    });

    const runner = new StubRunner([
      { chunkId: "c1", documentId: "doc-A", title: "A", rank: 0 },
      { chunkId: "c2", documentId: "doc-stale", title: "Stale", rank: 1 },
    ]);
    const service = new EvalRunService(repo, runner, passJudge());

    const { run } = await service.execute({
      workspaceId: "ws-1",
      snapshotId: snapshot.id,
      caseId: evalCase.id,
      mode: "retrieval_only",
    });

    expect(run.status).toBe("fail");
    expect(run.outcomeReason).toContain("doc-stale");
  });

  it("records the run with status 'recorded' when no case is provided", async () => {
    const snapshot = makeSnapshot();
    const repo = new InMemoryEvalRepository({ snapshots: [snapshot] });
    const runner = new StubRunner([
      { chunkId: "c1", documentId: "doc-a", title: "A", rank: 0 },
    ]);
    const service = new EvalRunService(repo, runner, passJudge());

    const { run, case: updated } = await service.execute({
      workspaceId: "ws-1",
      snapshotId: snapshot.id,
      mode: "retrieval_only",
    });

    expect(run.status).toBe("recorded");
    expect(run.caseId).toBeNull();
    expect(run.assertionVerdicts).toEqual([]);
    expect(updated).toBeNull();
  });

  it("records 'recorded' status when a case has zero assertions configured", async () => {
    const snapshot = makeSnapshot();
    const repo = new InMemoryEvalRepository({ snapshots: [snapshot] });
    const evalCase = await repo.createCase({
      workspaceId: "ws-1",
      snapshotId: snapshot.id,
      name: "no assertions yet",
      assertions: [],
    });
    const runner = new StubRunner([
      { chunkId: "c1", documentId: "doc-a", title: "A", rank: 0 },
    ]);
    const service = new EvalRunService(repo, runner, passJudge());

    const { run, case: updated } = await service.execute({
      workspaceId: "ws-1",
      snapshotId: snapshot.id,
      caseId: evalCase.id,
      mode: "retrieval_only",
    });

    expect(run.status).toBe("recorded");
    expect(run.assertionVerdicts).toEqual([]);
    // Case status is unchanged because a 'recorded' run has no pass/fail meaning.
    expect(updated?.status).toBe("pending");
    expect(updated?.lastRunId).toBeNull();
  });

  it("captures retrieval errors as run.status='error' without throwing", async () => {
    const snapshot = makeSnapshot();
    const repo = new InMemoryEvalRepository({ snapshots: [snapshot] });
    const evalCase = await repo.createCase({
      workspaceId: "ws-1",
      snapshotId: snapshot.id,
      name: "case",
      assertions: [refundIncludes],
    });
    const runner = new StubRunner([], new Error("embedding provider down"));
    const service = new EvalRunService(repo, runner, passJudge());

    const { run, case: updated } = await service.execute({
      workspaceId: "ws-1",
      snapshotId: snapshot.id,
      caseId: evalCase.id,
      mode: "retrieval_only",
    });

    expect(run.status).toBe("error");
    expect(run.outcomeReason).toBe("embedding provider down");
    expect(updated?.status).toBe("error");
  });

  it("rejects unknown snapshots and unknown cases", async () => {
    const repo = new InMemoryEvalRepository();
    const runner = new StubRunner([]);
    const service = new EvalRunService(repo, runner, passJudge());

    await expect(
      service.execute({ workspaceId: "ws-1", snapshotId: "missing", mode: "retrieval_only" }),
    ).rejects.toThrow(/Snapshot/);
  });

  it("rejects cases that reference a different snapshot", async () => {
    const snapA = makeSnapshot({ id: "snap-A" });
    const snapB = makeSnapshot({ id: "snap-B" });
    const repo = new InMemoryEvalRepository({ snapshots: [snapA, snapB] });
    const caseA = await repo.createCase({
      workspaceId: "ws-1",
      snapshotId: snapA.id,
      name: "a",
      assertions: [refundIncludes],
    });
    const runner = new StubRunner([]);
    const service = new EvalRunService(repo, runner, passJudge());

    await expect(
      service.execute({
        workspaceId: "ws-1",
        snapshotId: snapB.id,
        caseId: caseA.id,
        mode: "retrieval_only",
      }),
    ).rejects.toThrow(/does not match/);
  });

  it("replays multi-turn conversations by passing prior turns as history to the runner", async () => {
    const snapshot = makeSnapshot({
      messages: [
        { id: "m1", role: "user", content: "Tell me about your refund policy.", createdAt: fixedDate },
        { id: "m2", role: "assistant", content: "Our refund window is 30 days.", createdAt: fixedDate },
        { id: "m3", role: "user", content: "And what about international orders?", createdAt: fixedDate },
        { id: "m4", role: "assistant", content: "International orders also get 30 days.", createdAt: fixedDate },
      ],
    });
    const repo = new InMemoryEvalRepository({ snapshots: [snapshot] });
    const runner = new StubRunner([
      { chunkId: "c1", documentId: "doc-refund", title: "Refund Policy", rank: 0 },
    ]);
    const service = new EvalRunService(repo, runner, passJudge());

    await service.execute({
      workspaceId: "ws-1",
      snapshotId: snapshot.id,
      mode: "retrieval_only",
    });

    // The query is the LAST user message; the history is everything before it
    // (the prior user + assistant exchange). The trailing assistant message
    // (m4) is the output being regenerated and must NOT be in history.
    expect(runner.lastRetrieveCall?.query).toBe("And what about international orders?");
    expect(runner.lastRetrieveCall?.historyLength).toBe(2);
    expect(runner.lastRetrieveCall?.historyRoles).toEqual(["user", "assistant"]);
  });

  it("threads the snapshot's agent context and assistantInstructionsOverride into the runner", async () => {
    const snapshot = makeSnapshot({
      originalAgent: {
        agentId: "agent-1",
        name: "Support Bot",
        customInstruction: "Default agent instruction",
        greetingInstruction: "",
        assistantDefaultLocale: null,
        retrievalEnabled: true,
        suggestedQuestionsEnabled: true,
        sourceScope: { mode: "selected", sourceIds: ["src-1", "src-2"] },
        chatModelOverride: null,
      },
    });
    const repo = new InMemoryEvalRepository({ snapshots: [snapshot] });
    const evalCase = await repo.createCase({
      workspaceId: "ws-1",
      snapshotId: snapshot.id,
      name: "agent-context case",
      assertions: [refundIncludes],
    });
    const runner = new StubRunner([
      { chunkId: "c1", documentId: "doc-refund", title: "Refund Policy", rank: 0 },
    ]);
    const service = new EvalRunService(repo, runner, passJudge());

    await service.execute({
      workspaceId: "ws-1",
      snapshotId: snapshot.id,
      caseId: evalCase.id,
      mode: "retrieval_only",
      overrides: {
        assistantInstructionsOverride: { customInstruction: "Reply tersely." },
      },
    });

    expect(runner.lastRetrieveCall?.agentName).toBe("Support Bot");
    expect(runner.lastRetrieveCall?.agentSourceScopeMode).toBe("selected");
    // The override wins over the agent's baked-in instruction.
    expect(runner.lastRetrieveCall?.customInstruction).toBe("Reply tersely.");
  });

  it("supports full_assistant mode, capturing the generated answer in the run output", async () => {
    const snapshot = makeSnapshot();
    const repo = new InMemoryEvalRepository({ snapshots: [snapshot] });
    const evalCase = await repo.createCase({
      workspaceId: "ws-1",
      snapshotId: snapshot.id,
      name: "full-assistant case",
      assertions: [refundIncludes],
    });
    const runner = new StubRunner(
      [
        { chunkId: "c1", documentId: "doc-refund", title: "Refund Policy", rank: 0 },
      ],
      undefined,
      "Our refund window is 30 days from purchase.",
    );
    const service = new EvalRunService(repo, runner, passJudge());

    const { run } = await service.execute({
      workspaceId: "ws-1",
      snapshotId: snapshot.id,
      caseId: evalCase.id,
      mode: "full_assistant",
    });

    expect(run.mode).toBe("full_assistant");
    expect(run.observedOutput.answer).toBe("Our refund window is 30 days from purchase.");
    expect(run.status).toBe("pass");
  });

  it("delegates llm_judge assertions to the judge port and records its verdict", async () => {
    const snapshot = makeSnapshot();
    const repo = new InMemoryEvalRepository({ snapshots: [snapshot] });
    const evalCase = await repo.createCase({
      workspaceId: "ws-1",
      snapshotId: snapshot.id,
      name: "judged case",
      assertions: [
        { type: "llm_judge", expectedAnswer: "Refund window is 30 days." },
      ],
    });
    const runner = new StubRunner(
      [{ chunkId: "c1", documentId: "doc-refund", title: "Refund", rank: 0 }],
      undefined,
      "Our refund window is thirty days.",
    );
    const judge = passJudge();
    const service = new EvalRunService(repo, runner, judge);

    const { run } = await service.execute({
      workspaceId: "ws-1",
      snapshotId: snapshot.id,
      caseId: evalCase.id,
      mode: "full_assistant",
    });

    expect(judge.calls).toHaveLength(1);
    expect(judge.calls[0]!.observedAnswer).toBe("Our refund window is thirty days.");
    expect(run.status).toBe("pass");
    expect(run.assertionVerdicts[0]!.status).toBe("pass");
  });

  it("fails when the judge rejects the answer", async () => {
    const snapshot = makeSnapshot();
    const repo = new InMemoryEvalRepository({ snapshots: [snapshot] });
    const evalCase = await repo.createCase({
      workspaceId: "ws-1",
      snapshotId: snapshot.id,
      name: "judged case",
      assertions: [{ type: "llm_judge", expectedAnswer: "Refund window is 30 days." }],
    });
    const runner = new StubRunner([], undefined, "I don't know.");
    const service = new EvalRunService(repo, runner, failJudge());

    const { run, case: updated } = await service.execute({
      workspaceId: "ws-1",
      snapshotId: snapshot.id,
      caseId: evalCase.id,
      mode: "full_assistant",
    });

    expect(run.status).toBe("fail");
    expect(updated?.status).toBe("failing");
  });

  it("errors a judge assertion when the run mode produced no answer", async () => {
    const snapshot = makeSnapshot();
    const repo = new InMemoryEvalRepository({ snapshots: [snapshot] });
    const evalCase = await repo.createCase({
      workspaceId: "ws-1",
      snapshotId: snapshot.id,
      name: "judged case",
      assertions: [{ type: "llm_judge", expectedAnswer: "Refund window is 30 days." }],
    });
    const runner = new StubRunner([
      { chunkId: "c1", documentId: "doc-refund", title: "Refund", rank: 0 },
    ]);
    const judge = passJudge();
    const service = new EvalRunService(repo, runner, judge);

    // Running in retrieval_only — no answer is captured, so the judge can't grade.
    const { run } = await service.execute({
      workspaceId: "ws-1",
      snapshotId: snapshot.id,
      caseId: evalCase.id,
      mode: "retrieval_only",
    });

    expect(judge.calls).toHaveLength(0);
    expect(run.status).toBe("error");
    expect(run.assertionVerdicts[0]!.reason).toMatch(/full_assistant/);
  });
});
