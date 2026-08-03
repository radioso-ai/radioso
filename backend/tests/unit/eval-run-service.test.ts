import { describe, expect, it } from "vitest";

import type { ConversationAgent } from "../../src/modules/agents/domain.js";
import { projectInternalAgentConfig } from "../../src/modules/agents/agentConfig.js";
import { EvalRunService, type EvalWorkbenchReplayRunnerPort } from "../../src/modules/eval/services/evalRunService.js";
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
import type { ActivityTrace } from "../../src/modules/retrieval/public.js";
import type { AnswerSegment, ChatCitation } from "../../src/modules/chat/contracts/answerTypes.js";
import type { WorkbenchReplayResult } from "../../src/modules/chat/composition.js";
import type { EvalRetrievalRunnerPort } from "../../src/modules/eval/services/evalRunner.js";
import type { EvalLlmJudgePort } from "../../src/modules/eval/services/evalJudge.js";
import type { RetrievalSettingsSnapshot } from "../../src/modules/settings/contracts/retrieval.js";

const fixedDate = "2026-05-23T12:00:00.000Z";

const activityTrace = (): ActivityTrace => ({
  traceId: "eval-trace",
  startedAt: fixedDate,
  completedAt: fixedDate,
  summary: {
    path: "retrieval",
    status: "success",
    candidateCounts: {
      semantic: 1,
      lexical: 0,
      merged: 1,
      final: 1,
    },
    retrievalSkipped: false,
    fallbackApplied: false,
  },
  stages: [
    {
      stageId: "context",
      kind: "context",
      label: "Context",
      status: "applied",
      startedAt: fixedDate,
    },
  ],
  links: [],
});

const makeSnapshot = (overrides: Partial<EvalSnapshot> = {}): EvalSnapshot => ({
  id: "snap-1",
  workspaceId: "ws-1",
  sourceConversationId: "conv-1",
  sourceMessageId: "msg-2",
  replayTarget: null,
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
  originalAgentConfig: null,
  sourceAgentId: null,
  originalRoutineState: null,
  capturedAt: fixedDate,
  capturedBy: null,
  ...overrides,
});

const retrievalSettingsSnapshot = (
  overrides: Partial<RetrievalSettingsSnapshot> = {},
): RetrievalSettingsSnapshot => ({
  queryRewriteEnabled: true,
  temporalStructuredLookupEnabled: true,
  temporalBoostUpcomingEnabled: true,
  temporalDeterministicSortEnabled: true,
  semanticRewriteInstructions: "captured semantic rewrite",
  lexicalRewriteInstructions: "captured lexical rewrite",
  suggestedQuestionsEnabled: true,
  suggestedQuestionsCount: 2,
  rerankEnabled: true,
  vectorTopK: 11,
  similarityThreshold: 0.42,
  rerankTopK: 6,
  metadataRules: [],
  customInstruction: "captured retrieval instruction",
  retrievalStrategy: "fixed",
  ...overrides,
});

const configuredAgent = (): ConversationAgent => ({
  id: "agent-full",
  workspaceId: "ws-1",
  name: "Full Config Bot",
  createdAt: new Date(0),
  updatedAt: new Date(0),
  customInstruction: "Use the captured full config.",
  suggestedQuestionsEnabled: false,
  assistantLinkUtmEnabled: false,
  citationDisplayEnabled: false,
  contactRequestsEnabled: false,
  webhookExportsEnabled: false,
  contactRequestDelivery: {
    recipientEmails: [],
    webhook: null,
  },
  retrievalEnabled: false,
  logo: null,
  theme: {
    brand: "#111111",
    brandText: "#ffffff",
    surface: "#ffffff",
    text: "#111111",
  },
  branding: {
    hidePoweredBy: false,
    privacyPolicyUrl: null,
  },
  greetingInstruction: "",
  assistantDefaultLocale: null,
  proactiveGreetingEnabled: false,
  sourceScope: { mode: "selected", sourceIds: ["source-a", "source-b"] },
  surfaceSettings: {
    authenticatedChat: { enabled: true },
    anonymousChat: { enabled: false, token: null },
    websiteEmbed: {
      enabled: false,
      token: null,
      allowedOrigins: [],
      launcherLabel: "Ask",
      launcherPosition: "bottom-right",
      theme: {
        brand: "#111111",
        brandText: "#ffffff",
        surface: "#ffffff",
        text: "#111111",
      },
      copy: {},
      expertOverrides: {},
    },
    extensions: {},
  },
  skillSettings: {
    "retrieval.answer": {
      vectorTopK: 3,
    },
  },
  chatModelOverride: null,
  authoredDirectives: [],
});

class InMemoryEvalRepository implements EvalRepositoryPort {
  private snapshots = new Map<string, EvalSnapshot>();
  private cases = new Map<string, EvalCase>();
  private runs: EvalRun[] = [];
  private idCounter = 0;
  public deleteCaseBeforeCreateRun = false;
  public deleteCaseBeforeLastRunUpdate = false;

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

  async listCasesWithLatestRun(workspaceId: string) {
    return [...this.cases.values()]
      .filter((c) => c.workspaceId === workspaceId)
      .map((evalCase) => {
        const latest = this.runs
          .filter((r) => r.workspaceId === workspaceId && r.caseId === evalCase.id)
          .sort((a, b) => b.startedAt.localeCompare(a.startedAt))[0];
        const snapshot = this.snapshots.get(evalCase.snapshotId);
        return {
          ...evalCase,
          latestRun: latest
            ? {
                id: latest.id,
                status: latest.status,
                mode: latest.mode,
                startedAt: latest.startedAt,
                completedAt: latest.completedAt,
                modelId: latest.resolvedConfig.modelId ?? null,
                outcomeReason: latest.outcomeReason,
              }
            : null,
          agent: {
            agentId: snapshot?.sourceAgentId ?? null,
            name: snapshot?.originalAgentConfig?.name ?? snapshot?.originalAgent?.name ?? null,
            internalName: null,
            deleted: false,
          },
        };
      });
  }

  async deleteCase(workspaceId: string, caseId: string): Promise<boolean> {
    const existing = this.cases.get(caseId);
    if (!existing || existing.workspaceId !== workspaceId) return false;
    this.cases.delete(caseId);
    this.runs = this.runs.map((r) =>
      r.workspaceId === workspaceId && r.caseId === caseId ? { ...r, caseId: null } : r,
    );
    return true;
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
    if (this.deleteCaseBeforeCreateRun && input.caseId) {
      this.deleteCaseBeforeCreateRun = false;
      await this.deleteCase(input.workspaceId, input.caseId);
    }
    const id = input.id ?? this.nextId("run");
    const run: EvalRun = {
      id,
      workspaceId: input.workspaceId,
      snapshotId: input.snapshotId,
      caseId: input.caseId && this.cases.has(input.caseId) ? input.caseId : null,
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
  ): Promise<EvalCase | null> {
    if (this.deleteCaseBeforeLastRunUpdate) {
      this.deleteCaseBeforeLastRunUpdate = false;
      await this.deleteCase(workspaceId, caseId);
    }
    const existing = this.cases.get(caseId);
    if (!existing || existing.workspaceId !== workspaceId) return null;
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
  agentId?: string | null;
  agentWorkspaceId?: string | null;
  agentSourceScopeMode?: string;
  agentSourceIds?: string[];
  agentRetrievalEnabled?: boolean;
  agentCitationDisplayEnabled?: boolean;
  customInstruction?: string;
  retrievalSkillSettings?: unknown;
  retrievalSettingsOverride?: unknown;
  conversationSummary?: string;
};

class StubRunner implements EvalRetrievalRunnerPort {
  public lastRetrieveCall: StubRunnerCall | null = null;
  public lastAnswerCall: StubRunnerCall | null = null;

  constructor(
    private readonly chunks: EvalRunRetrievedChunk[],
    private readonly error?: Error,
    private readonly answerText?: string,
    private readonly citations?: ChatCitation[],
    private readonly answerSegments?: AnswerSegment[],
    private readonly trace: ActivityTrace = activityTrace(),
  ) {}

  private capture(input: {
    query: string;
    history: { role: string }[];
    context?: {
      agent?: {
        id?: string;
        agentId?: string;
        workspaceId?: string;
        name: string;
        sourceScope: { mode: "all" } | { mode: "selected"; sourceIds: string[] };
        customInstruction: string;
        retrievalEnabled?: boolean;
        citationDisplayEnabled?: boolean;
        skillSettings?: Record<string, unknown>;
      } | null;
      customInstructionOverride?: string;
    };
    conversationSummary?: string;
    retrievalSettingsOverride?: unknown;
  }): StubRunnerCall {
    return {
      query: input.query,
      conversationSummary: input.conversationSummary,
      historyLength: input.history.length,
      historyRoles: input.history.map((m) => m.role),
      agentName: input.context?.agent?.name ?? null,
      agentId: input.context?.agent?.id ?? input.context?.agent?.agentId ?? null,
      agentWorkspaceId: input.context?.agent?.workspaceId ?? null,
      agentSourceScopeMode: input.context?.agent?.sourceScope?.mode,
      agentSourceIds: input.context?.agent?.sourceScope?.mode === "selected"
        ? input.context.agent.sourceScope.sourceIds
        : undefined,
      agentRetrievalEnabled: input.context?.agent?.retrievalEnabled,
      agentCitationDisplayEnabled: input.context?.agent?.citationDisplayEnabled,
      customInstruction:
        input.context?.customInstructionOverride ??
        input.context?.agent?.customInstruction,
      retrievalSkillSettings: input.context?.agent?.skillSettings?.["retrieval.answer"],
      retrievalSettingsOverride: input.retrievalSettingsOverride,
    };
  }

  async retrieve(input: any) {
    this.lastRetrieveCall = this.capture(input);
    if (this.error) throw this.error;
    return { chunks: this.chunks, activityTrace: this.trace };
  }

  async answer(input: any) {
    this.lastAnswerCall = this.capture(input);
    if (this.error) throw this.error;
    return {
      chunks: this.chunks,
      answer: this.answerText ?? "",
      citations: this.citations,
      answerSegments: this.answerSegments,
      activityTrace: this.trace,
    };
  }
}

class StubWorkbenchReplayRunner implements EvalWorkbenchReplayRunnerPort {
  public calls: Array<Parameters<EvalWorkbenchReplayRunnerPort["run"]>[0]> = [];

  async run(input: Parameters<EvalWorkbenchReplayRunnerPort["run"]>[0]): Promise<WorkbenchReplayResult> {
    this.calls.push(input);
    return {
      answer: "Replay answer.",
      citations: [{ documentId: "doc-refund", chunkId: "chunk-1", title: "Refund Policy" }],
      answerSegments: [{ text: "Replay answer.", citationIndices: [0] }],
      groundingSummary: {
        protocolVersion: 2,
        parseStatus: "valid_v2",
        verdict: "grounded",
        claimCount: 1,
        sourcedClaimCount: 1,
        unsourcedClaimCount: 0,
        invalidSourceCount: 0,
        assertionMismatch: false,
      },
      turnTrace: {
        version: 1,
        spine: {
          traceId: "engine-trace",
          startedAt: fixedDate,
          stages: [{ id: "compose", kind: "compose", status: "applied" as const }],
        },
      },
      resolvedConfig: {
        composedInstructions: "Resolved replay instructions.",
        modelProvider: "openai",
        modelId: "gpt-5-mini",
        // Mirror the real runner: echo the frozen summary it was given so an operator
        // can confirm the replay injected it. Conditional so summary-free replays match
        // the pre-existing exact-equality assertions.
        ...(input.conversationSummary ? { conversationSummary: input.conversationSummary } : {}),
        retrievedChunks: [{ chunkId: "chunk-1", documentId: "doc-refund", title: "Refund Policy", rank: 0 }],
      },
    };
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
    expect(run.observedOutput.activityTrace?.summary?.retrievalSkipped).toBe(false);
    expect(run.assertionVerdicts).toHaveLength(1);
    expect(run.assertionVerdicts[0]!.status).toBe("pass");
    expect(updated?.status).toBe("passing");
    expect(updated?.lastRunId).toBe(run.id);
  });

  it("records the run detached when its case is deleted before run insert", async () => {
    const snapshot = makeSnapshot();
    const repo = new InMemoryEvalRepository({ snapshots: [snapshot] });
    const evalCase = await repo.createCase({
      workspaceId: "ws-1",
      snapshotId: snapshot.id,
      name: "deleted while running",
      assertions: [refundIncludes],
    });
    repo.deleteCaseBeforeCreateRun = true;
    const runner = new StubRunner([
      { chunkId: "c1", documentId: "doc-refund", title: "Refund Policy", rank: 0 },
    ]);
    const service = new EvalRunService(repo, runner, passJudge());

    const { run, case: updated } = await service.execute({
      workspaceId: "ws-1",
      snapshotId: snapshot.id,
      caseId: evalCase.id,
      mode: "retrieval_only",
    });

    expect(run.caseId).toBeNull();
    expect(run.status).toBe("pass");
    expect(updated).toBeNull();
  });

  it("returns a detached run when its case is deleted before last-run linking", async () => {
    const snapshot = makeSnapshot();
    const repo = new InMemoryEvalRepository({ snapshots: [snapshot] });
    const evalCase = await repo.createCase({
      workspaceId: "ws-1",
      snapshotId: snapshot.id,
      name: "deleted while linking",
      assertions: [refundIncludes],
    });
    repo.deleteCaseBeforeLastRunUpdate = true;
    const runner = new StubRunner([
      { chunkId: "c1", documentId: "doc-refund", title: "Refund Policy", rank: 0 },
    ]);
    const service = new EvalRunService(repo, runner, passJudge());

    const { run, case: updated } = await service.execute({
      workspaceId: "ws-1",
      snapshotId: snapshot.id,
      caseId: evalCase.id,
      mode: "retrieval_only",
    });

    expect(run.caseId).toBeNull();
    expect(run.status).toBe("pass");
    expect(updated).toBeNull();
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
        citationDisplayEnabled: true,
        sourceScope: { mode: "selected", sourceIds: ["src-1", "src-2"] },
        skillSettings: {},
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

  it("uses the snapshot's captured retrieval settings as the replay base", async () => {
    const capturedSettings = retrievalSettingsSnapshot({
      queryRewriteEnabled: false,
      vectorTopK: 4,
      rerankEnabled: false,
      similarityThreshold: 0.31,
    });
    const snapshot = makeSnapshot({
      originalRetrievalSettings: capturedSettings,
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

    expect(runner.lastRetrieveCall?.retrievalSettingsOverride).toMatchObject({
      queryRewriteEnabled: false,
      vectorTopK: 4,
      rerankEnabled: false,
      similarityThreshold: 0.31,
    });
  });

  it("layers per-run retrieval overrides over captured retrieval settings", async () => {
    const snapshot = makeSnapshot({
      originalRetrievalSettings: retrievalSettingsSnapshot({
        vectorTopK: 4,
        rerankEnabled: false,
        similarityThreshold: 0.31,
      }),
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
      overrides: {
        retrievalSettingsOverride: {
          vectorTopK: 9,
        },
      },
    });

    expect(runner.lastRetrieveCall?.retrievalSettingsOverride).toMatchObject({
      vectorTopK: 9,
      rerankEnabled: false,
      similarityThreshold: 0.31,
    });
  });

  it("materializes full agent config snapshots before passing replay context to the runner", async () => {
    const agent = configuredAgent();
    const snapshot = makeSnapshot({
      sourceAgentId: agent.id,
      originalAgentConfig: projectInternalAgentConfig(agent),
      originalAgent: null,
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

    expect(runner.lastRetrieveCall?.agentId).toBe("agent-full");
    expect(runner.lastRetrieveCall?.agentWorkspaceId).toBe("ws-1");
    expect(runner.lastRetrieveCall?.agentName).toBe("Full Config Bot");
    expect(runner.lastRetrieveCall?.agentSourceScopeMode).toBe("selected");
    expect(runner.lastRetrieveCall?.agentSourceIds).toEqual(["source-a", "source-b"]);
    expect(runner.lastRetrieveCall?.agentRetrievalEnabled).toBe(false);
    expect(runner.lastRetrieveCall?.agentCitationDisplayEnabled).toBe(false);
    expect(runner.lastRetrieveCall?.customInstruction).toBe("Use the captured full config.");
    expect(runner.lastRetrieveCall?.retrievalSkillSettings).toEqual({
      vectorTopK: 3,
    });
  });

  it("supports full_assistant mode, capturing the generated answer in the run output", async () => {
    const fullAgent = configuredAgent();
    const snapshot = makeSnapshot({
      sourceAgentId: fullAgent.id,
      originalAgentConfig: projectInternalAgentConfig(fullAgent),
    });
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
      [{ documentId: "doc-refund", chunkId: "c1", title: "Refund Policy" }],
      [{ text: "Our refund window is 30 days from purchase.", citationIndices: [0] }],
    );
    const service = new EvalRunService(
      repo,
      runner,
      passJudge(),
      new StubWorkbenchReplayRunner(),
    );

    const { run } = await service.execute({
      workspaceId: "ws-1",
      snapshotId: snapshot.id,
      caseId: evalCase.id,
      mode: "full_assistant",
    });

    expect(run.mode).toBe("full_assistant");
    expect(run.observedOutput.answer).toBe("Replay answer.");
    expect(run.observedOutput.citations).toEqual([
      { documentId: "doc-refund", chunkId: "chunk-1", title: "Refund Policy" },
    ]);
    expect(run.observedOutput.answerSegments).toEqual([
      { text: "Replay answer.", citationIndices: [0] },
    ]);
    expect(run.observedOutput.turnTrace?.spine.traceId).toBe("engine-trace");
    expect(run.status).toBe("pass");
  });

  it("threads the frozen conversation summary into retrieval_only and legacy full_assistant runs", async () => {
    const snapshot = makeSnapshot({
      conversationSummary: "The user is comparing the Pro and Team plans.",
    });
    const repo = new InMemoryEvalRepository({ snapshots: [snapshot] });
    const runner = new StubRunner(
      [{ chunkId: "c1", documentId: "doc-refund", title: "Refund Policy", rank: 0 }],
      undefined,
      "Answer.",
    );
    const service = new EvalRunService(repo, runner, passJudge());

    await service.execute({ workspaceId: "ws-1", snapshotId: snapshot.id, mode: "retrieval_only" });
    expect(runner.lastRetrieveCall?.conversationSummary).toBe(
      "The user is comparing the Pro and Team plans.",
    );

    const { run } = await service.execute({ workspaceId: "ws-1", snapshotId: snapshot.id, mode: "full_assistant" });
    expect(runner.lastAnswerCall?.conversationSummary).toBe(
      "The user is comparing the Pro and Team plans.",
    );
    // The injected summary is echoed on the run's resolvedConfig for operator review.
    expect(run.resolvedConfig.conversationSummary).toBe(
      "The user is comparing the Pro and Team plans.",
    );

    const { run: retrievalRun } = await service.execute({
      workspaceId: "ws-1",
      snapshotId: snapshot.id,
      mode: "retrieval_only",
    });
    // retrieval_only injects no summary, so it echoes none.
    expect(retrievalRun.resolvedConfig.conversationSummary).toBeUndefined();
  });

  it("threads the frozen conversation summary into the workbench replay runner", async () => {
    const agent = configuredAgent();
    const snapshot = makeSnapshot({
      sourceAgentId: agent.id,
      originalAgentConfig: projectInternalAgentConfig(agent),
      conversationSummary: "The buyer already returned the item last week.",
    });
    const repo = new InMemoryEvalRepository({ snapshots: [snapshot] });
    const workbench = new StubWorkbenchReplayRunner();
    const service = new EvalRunService(repo, new StubRunner([]), passJudge(), workbench);

    const { run } = await service.execute({ workspaceId: "ws-1", snapshotId: snapshot.id, mode: "full_assistant" });

    expect(workbench.calls).toHaveLength(1);
    expect(workbench.calls[0]?.conversationSummary).toBe(
      "The buyer already returned the item last week.",
    );
    // The replayed summary the runner reports back is echoed on the run's resolvedConfig.
    expect(run.resolvedConfig.conversationSummary).toBe(
      "The buyer already returned the item last week.",
    );
  });

  it("runs the Workbench engine replay entry point and translates turn trace into the run record", async () => {
    const agent = configuredAgent();
    const snapshot = makeSnapshot({
      sourceAgentId: agent.id,
      originalAgentConfig: projectInternalAgentConfig(agent),
    });
    const repo = new InMemoryEvalRepository({ snapshots: [snapshot] });
    const evalCase = await repo.createCase({
      workspaceId: "ws-1",
      snapshotId: snapshot.id,
      name: "workbench replay case",
      assertions: [refundIncludes],
    });
    const workbench = new StubWorkbenchReplayRunner();
    const service = new EvalRunService(repo, new StubRunner([]), passJudge(), workbench);

    const { run } = await service.executeWorkbenchReplay({
      workspaceId: "ws-1",
      snapshotId: snapshot.id,
      caseId: evalCase.id,
      mode: "full_assistant",
      overrides: {
        agentConfigOverride: {
          customInstruction: "Workbench override.",
        },
      },
    });

    expect(workbench.calls).toHaveLength(1);
    expect(workbench.calls[0]).toMatchObject({
      workspaceId: "ws-1",
      sourceAgentId: "agent-full",
      query: "what is the refund policy?",
      agentConfigOverride: {
        customInstruction: "Workbench override.",
      },
    });
    expect(run.observedOutput).toMatchObject({
      retrievedChunks: [{ chunkId: "chunk-1", documentId: "doc-refund", title: "Refund Policy", rank: 0 }],
      answer: "Replay answer.",
      citations: [{ documentId: "doc-refund", chunkId: "chunk-1", title: "Refund Policy" }],
      answerSegments: [{ text: "Replay answer.", citationIndices: [0] }],
      groundingVerdict: "grounded",
      groundingDiagnostics: {
        protocolVersion: 2,
        parseStatus: "valid_v2",
        claimCount: 1,
        sourcedClaimCount: 1,
        unsourcedClaimCount: 0,
        invalidSourceCount: 0,
        assertionMismatch: false,
      },
      turnTrace: {
        version: 1,
        spine: { traceId: "engine-trace" },
      },
    });
    expect(run.resolvedConfig).toEqual({
      composedInstructions: "Resolved replay instructions.",
      modelProvider: "openai",
      modelId: "gpt-5-mini",
    });
    expect(run.status).toBe("pass");
  });

  it("uses the Workbench engine replay path for full-assistant runs with a full agent snapshot", async () => {
    const agent = configuredAgent();
    const snapshot = makeSnapshot({
      sourceAgentId: agent.id,
      originalAgentConfig: projectInternalAgentConfig(agent),
    });
    const repo = new InMemoryEvalRepository({ snapshots: [snapshot] });
    const workbench = new StubWorkbenchReplayRunner();
    const legacyRunner = new StubRunner(
      [{ chunkId: "legacy", documentId: "legacy-doc", title: "Legacy", rank: 0 }],
      undefined,
      "Legacy answer.",
    );
    const service = new EvalRunService(repo, legacyRunner, passJudge(), workbench);

    const { run } = await service.execute({
      workspaceId: "ws-1",
      snapshotId: snapshot.id,
      mode: "full_assistant",
    });

    expect(workbench.calls).toHaveLength(1);
    expect(legacyRunner.lastAnswerCall).toBeNull();
    expect(workbench.calls[0]).toMatchObject({
      workspaceId: "ws-1",
      sourceAgentId: agent.id,
      query: "what is the refund policy?",
      usageAttribution: {
        surface: "eval",
        requestId: run.id,
      },
    });
    expect(run.observedOutput.answer).toBe("Replay answer.");
    expect(run.observedOutput.turnTrace).toMatchObject({
      version: 1,
      spine: { traceId: "engine-trace" },
    });
  });

  it("falls back to the legacy full-assistant runner when Workbench replay is not configured", async () => {
    const snapshot = makeSnapshot();
    const repo = new InMemoryEvalRepository({ snapshots: [snapshot] });
    const legacyRunner = new StubRunner(
      [{ chunkId: "legacy", documentId: "legacy-doc", title: "Legacy", rank: 0 }],
      undefined,
      "Legacy answer.",
    );
    const service = new EvalRunService(repo, legacyRunner, passJudge());

    const { run } = await service.execute({
      workspaceId: "ws-1",
      snapshotId: snapshot.id,
      mode: "full_assistant",
    });

    expect(legacyRunner.lastAnswerCall).not.toBeNull();
    expect(run.observedOutput.answer).toBe("Legacy answer.");
  });

  it("falls back to the legacy full-assistant runner for snapshots without full agent config", async () => {
    const snapshot = makeSnapshot({
      originalAgentConfig: null,
      sourceAgentId: null,
    });
    const repo = new InMemoryEvalRepository({ snapshots: [snapshot] });
    const workbench = new StubWorkbenchReplayRunner();
    const legacyRunner = new StubRunner(
      [{ chunkId: "legacy", documentId: "legacy-doc", title: "Legacy", rank: 0 }],
      undefined,
      "Legacy snapshot answer.",
    );
    const service = new EvalRunService(repo, legacyRunner, passJudge(), workbench);

    const { run } = await service.execute({
      workspaceId: "ws-1",
      snapshotId: snapshot.id,
      mode: "full_assistant",
    });

    expect(workbench.calls).toHaveLength(0);
    expect(legacyRunner.lastAnswerCall).not.toBeNull();
    expect(run.observedOutput.answer).toBe("Legacy snapshot answer.");
  });

  it("keeps legacy full-assistant overrides on the Workbench engine replay path", async () => {
    const agent = configuredAgent();
    const snapshot = makeSnapshot({
      sourceAgentId: agent.id,
      originalAgentConfig: projectInternalAgentConfig(agent),
      originalRetrievalSettings: retrievalSettingsSnapshot({ vectorTopK: 4 }),
    });
    const repo = new InMemoryEvalRepository({ snapshots: [snapshot] });
    const workbench = new StubWorkbenchReplayRunner();
    const legacyRunner = new StubRunner(
      [{ chunkId: "legacy", documentId: "legacy-doc", title: "Legacy", rank: 0 }],
      undefined,
      "Legacy answer.",
    );
    const service = new EvalRunService(repo, legacyRunner, passJudge(), workbench);

    await service.execute({
      workspaceId: "ws-1",
      snapshotId: snapshot.id,
      mode: "full_assistant",
      overrides: {
        modelOverride: { provider: "openai", model: "gpt-5-mini" },
        assistantInstructionsOverride: { customInstruction: "Reply tersely." },
        retrievalSettingsOverride: { vectorTopK: 9 },
      },
    });

    expect(legacyRunner.lastAnswerCall).toBeNull();
    expect(workbench.calls).toHaveLength(1);
    expect(workbench.calls[0]).toMatchObject({
      agentConfigOverride: {
        customInstruction: "Reply tersely.",
        chatModelOverride: { provider: "openai", model: "gpt-5-mini" },
      },
      retrievalSettingsOverride: { vectorTopK: 9 },
    });
  });

  it("forwards a routineStartState override to the workbench replay runner for mid-routine resume", async () => {
    const agent = configuredAgent();
    const snapshot = makeSnapshot({
      sourceAgentId: agent.id,
      originalAgentConfig: projectInternalAgentConfig(agent),
    });
    const repo = new InMemoryEvalRepository({ snapshots: [snapshot] });
    const evalCase = await repo.createCase({
      workspaceId: "ws-1",
      snapshotId: snapshot.id,
      name: "mid-routine replay case",
      assertions: [refundIncludes],
    });
    const workbench = new StubWorkbenchReplayRunner();
    const service = new EvalRunService(repo, new StubRunner([]), passJudge(), workbench);

    await service.executeWorkbenchReplay({
      workspaceId: "ws-1",
      snapshotId: snapshot.id,
      caseId: evalCase.id,
      mode: "full_assistant",
      overrides: {
        agentConfigOverride: { customInstruction: "Workbench override." },
        routineStartState: {
          routineId: "ask_email_on_interest",
          path: ["step_1_ask"],
          variables: { customer_email: "buyer@example.com" },
          status: "active",
        },
      },
    });

    expect(workbench.calls[0]).toMatchObject({
      routineStartState: {
        routineId: "ask_email_on_interest",
        path: ["step_1_ask"],
        variables: { customer_email: "buyer@example.com" },
        status: "active",
      },
    });
  });

  it("does NOT auto-seed the replay from the snapshot's captured routine state (it is post-turn)", async () => {
    const agent = configuredAgent();
    const snapshot = makeSnapshot({
      sourceAgentId: agent.id,
      originalAgentConfig: projectInternalAgentConfig(agent),
      originalRoutineState: {
        routineId: "ask_email_on_interest",
        path: ["step_0"],
        variables: {},
        status: "active",
      },
    });
    const repo = new InMemoryEvalRepository({ snapshots: [snapshot] });
    const evalCase = await repo.createCase({
      workspaceId: "ws-1",
      snapshotId: snapshot.id,
      name: "snapshot-routine replay case",
      assertions: [refundIncludes],
    });
    const workbench = new StubWorkbenchReplayRunner();
    const service = new EvalRunService(repo, new StubRunner([]), passJudge(), workbench);

    // No explicit override → the captured (post-turn) routine state is NOT applied.
    await service.executeWorkbenchReplay({
      workspaceId: "ws-1",
      snapshotId: snapshot.id,
      caseId: evalCase.id,
      mode: "full_assistant",
      overrides: { agentConfigOverride: { customInstruction: "x" } },
    });
    expect(workbench.calls[0]?.routineStartState).toBeUndefined();

    // An explicit override is the only thing that seeds a mid-routine replay.
    const overrideState = {
      routineId: "ask_email_on_interest",
      path: ["step_2"],
      variables: { customer_email: "a@b.com" },
      status: "active" as const,
    };
    await service.executeWorkbenchReplay({
      workspaceId: "ws-1",
      snapshotId: snapshot.id,
      caseId: evalCase.id,
      mode: "full_assistant",
      overrides: { routineStartState: overrideState },
    });
    expect(workbench.calls[1]).toMatchObject({ routineStartState: overrideState });
  });

  it("returns a detached Workbench replay run when its case is deleted before last-run linking", async () => {
    const agent = configuredAgent();
    const snapshot = makeSnapshot({
      sourceAgentId: agent.id,
      originalAgentConfig: projectInternalAgentConfig(agent),
    });
    const repo = new InMemoryEvalRepository({ snapshots: [snapshot] });
    const evalCase = await repo.createCase({
      workspaceId: "ws-1",
      snapshotId: snapshot.id,
      name: "workbench deleted case",
      assertions: [refundIncludes],
    });
    repo.deleteCaseBeforeLastRunUpdate = true;
    const service = new EvalRunService(
      repo,
      new StubRunner([]),
      passJudge(),
      new StubWorkbenchReplayRunner(),
    );

    const { run, case: updated } = await service.executeWorkbenchReplay({
      workspaceId: "ws-1",
      snapshotId: snapshot.id,
      caseId: evalCase.id,
      mode: "full_assistant",
    });

    expect(run.caseId).toBeNull();
    expect(run.status).toBe("pass");
    expect(updated).toBeNull();
  });

  it("emits one sanitized Workbench replay observability record", async () => {
    const agent = configuredAgent();
    const snapshot = makeSnapshot({
      sourceAgentId: agent.id,
      originalAgentConfig: projectInternalAgentConfig(agent),
    });
    const repo = new InMemoryEvalRepository({ snapshots: [snapshot] });
    const workbench = new StubWorkbenchReplayRunner();
    const logs: Array<{ fields: Record<string, unknown>; message: string }> = [];
    const service = new EvalRunService(
      repo,
      new StubRunner([]),
      passJudge(),
      workbench,
      {
        info(fields: Record<string, unknown>, message: string) {
          logs.push({ fields: fields as Record<string, unknown>, message });
        },
      },
    );

    const { run } = await service.executeWorkbenchReplay({
      workspaceId: "ws-1",
      accountId: "acct-1",
      snapshotId: snapshot.id,
      mode: "full_assistant",
      overrides: {
        agentConfigOverride: {
          customInstruction: "Sensitive override instruction that must not be logged.",
          skillSettings: {
            "retrieval.answer": {
              settings: {
                vectorTopK: 7,
              },
            },
          } as any,
        },
      },
    });

    expect(logs).toHaveLength(1);
    expect(logs[0]).toMatchObject({
      message: "Workbench replay eval run completed",
      fields: {
        workspaceId: "ws-1",
        accountId: "acct-1",
        agentId: "agent-full",
        snapshotId: "snap-1",
        runId: run.id,
        status: "recorded",
        outcome: "recorded",
        overrideKeys: ["customInstruction", "skillSettings"],
      },
    });
    expect(logs[0]!.fields.latencyMs).toEqual(expect.any(Number));
    const serialized = JSON.stringify(logs);
    expect(serialized).not.toContain("Sensitive override instruction");
    expect(serialized).not.toContain("vectorTopK");
    expect(serialized).not.toContain("Replay answer");
    expect(serialized).not.toContain("Refund Policy");
    expect(serialized).not.toContain("what is the refund policy?");
  });

  it("delegates llm_judge assertions to the judge port and records its verdict", async () => {
    const fullAgent = configuredAgent();
    const snapshot = makeSnapshot({
      sourceAgentId: fullAgent.id,
      originalAgentConfig: projectInternalAgentConfig(fullAgent),
    });
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
    const service = new EvalRunService(
      repo,
      runner,
      judge,
      new StubWorkbenchReplayRunner(),
    );

    const { run } = await service.execute({
      workspaceId: "ws-1",
      snapshotId: snapshot.id,
      caseId: evalCase.id,
      mode: "full_assistant",
    });

    expect(judge.calls).toHaveLength(1);
    expect(judge.calls[0]!.observedAnswer).toBe("Replay answer.");
    expect(run.status).toBe("pass");
    expect(run.assertionVerdicts[0]!.status).toBe("pass");
  });

  it("fails when the judge rejects the answer", async () => {
    const fullAgent = configuredAgent();
    const snapshot = makeSnapshot({
      sourceAgentId: fullAgent.id,
      originalAgentConfig: projectInternalAgentConfig(fullAgent),
    });
    const repo = new InMemoryEvalRepository({ snapshots: [snapshot] });
    const evalCase = await repo.createCase({
      workspaceId: "ws-1",
      snapshotId: snapshot.id,
      name: "judged case",
      assertions: [{ type: "llm_judge", expectedAnswer: "Refund window is 30 days." }],
    });
    const runner = new StubRunner([], undefined, "I don't know.");
    const service = new EvalRunService(
      repo,
      runner,
      failJudge(),
      new StubWorkbenchReplayRunner(),
    );

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
