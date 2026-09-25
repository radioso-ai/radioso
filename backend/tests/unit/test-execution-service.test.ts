import { describe, expect, it, vi } from "vitest";

import type { AgentRevision } from "../../src/modules/agents/agentRevision.js";
import {
  TestExecutionService,
  type TestExecution,
  type TestExecutionAttemptRecord,
  type TestExecutionDefaultRevisionPort,
  type TestExecutionHistoryItem,
  type TestExecutionRepositoryPort,
  type TestExecutionRunnerResult,
  type TestExecutionSeed,
  type TestExecutionSeedSource,
  type TrustedTestExecutionRunnerPort,
} from "../../src/modules/test-execution/testExecution.js";
import { readSideTurns } from "../../src/modules/test-execution/testExecutionTurns.js";
import { NoopUsageLimitPolicy, type UsageLimitPolicy } from "../../src/shared/domain/usageLimitPolicy.js";

const ids = ["00000000-0000-4000-8000-000000000001", "00000000-0000-4000-8000-000000000002", "00000000-0000-4000-8000-000000000003", "00000000-0000-4000-8000-000000000004", "00000000-0000-4000-8000-000000000005", "00000000-0000-4000-8000-000000000006", "00000000-0000-4000-8000-000000000007", "00000000-0000-4000-8000-000000000008", "00000000-0000-4000-8000-000000000009", "00000000-0000-4000-8000-000000000010"];
const workspaceId = "10000000-0000-4000-8000-000000000001";
const agentId = "20000000-0000-4000-8000-000000000001";
const revision = (id: string, enabled = true): AgentRevision => ({
  id,
  snapshot: {
    customInstruction: null, directives: [], routines: [], contextVariableEnablements: [{
      id: "30000000-0000-4000-8000-000000000001", agentId, variableId: "40000000-0000-4000-8000-000000000001",
      source: "pushed", resolverSkillId: null, maxAgeSeconds: null, resolverTimeoutMs: null, surfacing: "always", enabled,
      createdAt: new Date(0), updatedAt: new Date(0),
    }],
  }, sourceDraftGeneration: 1, sourceBasePublishedRevisionId: null, createdAt: new Date(0), publishedAt: null, publishedVersion: null,
});

class MemoryRepository implements TestExecutionRepositoryPort {
  execution: TestExecution | null = null;
  calls: string[] = [];
  completeCalls = 0;
  replay?: TestExecutionRunnerResult;
  failThrows = false;
  byIdempotencyKey = new Map<string, TestExecution>();
  async create(input: Parameters<TestExecutionRepositoryPort["create"]>[0]) {
    const existing = this.byIdempotencyKey.get(input.idempotencyKey);
    if (existing) return existing;
    this.execution = { ...input, state: input.state ?? "running", createdAt: new Date(0) };
    this.byIdempotencyKey.set(input.idempotencyKey, this.execution);
    return this.execution;
  }
  async findByIdempotencyKey(input: Parameters<TestExecutionRepositoryPort["findByIdempotencyKey"]>[0]): Promise<TestExecution | null> {
    return this.byIdempotencyKey.get(input.idempotencyKey) ?? null;
  }
  async find(): Promise<TestExecution | null> { return this.execution; }
  recoverExpiredSidesCalls = 0;
  async recoverExpiredSides(input: Parameters<TestExecutionRepositoryPort["recoverExpiredSides"]>[0]): Promise<TestExecution | null> {
    this.recoverExpiredSidesCalls += 1;
    if (!this.execution) return null;
    for (const side of this.execution.sides) {
      if (side.state !== "running" || !this.staleLease || this.staleLease > input.now) continue;
      side.state = "failed"; side.retryable = true;
    }
    this.execution.state = this.execution.sides.every((item) => item.state === "completed") ? "completed"
      : this.execution.sides.some((item) => item.state === "running" || item.state === "ready") ? "running" : "partial";
    return this.execution;
  }
  staleLease: Date | null = null;
  async retainSide(input: Parameters<TestExecutionRepositoryPort["retainSide"]>[0]) {
    const source = this.execution;
    const side = source?.sides.find((candidate) => candidate.id === input.sideId);
    if (!source || !side) return "not_found" as const;
    if (source.mode !== "compare") return "not_comparison" as const;
    if (side.state === "running" || side.state === "failed") return "unsettled" as const;
    this.execution = {
      ...structuredClone(source),
      id: input.retainedExecutionId,
      mode: "single",
      generation: 1,
      state: side.state === "completed" ? "completed" : "running",
      sides: [{ ...structuredClone(side), id: input.retainedSideId, executionId: input.retainedExecutionId, conversationId: input.retainedConversationId }],
    };
    return this.execution;
  }
  async list(_input?: Parameters<TestExecutionRepositoryPort["list"]>[0]): ReturnType<TestExecutionRepositoryPort["list"]> { return { executions: this.execution ? [this.execution] : [], nextCursor: null, hasMore: false }; }
  attempts: TestExecutionAttemptRecord[] = [];
  async listAttempts() { return this.attempts; }
  transcriptSummaries = new Map<string, { turnCount: number; firstMessage: string | null }>();
  async summarizeTranscripts(input: Parameters<TestExecutionRepositoryPort["summarizeTranscripts"]>[0]) {
    this.calls.push(`summarize:${input.executionIds.join(",")}`);
    return new Map([...this.transcriptSummaries].filter(([id]) => input.executionIds.includes(id)));
  }
  lastLeaseMs: number | null = null;
  async claimTurn(input: Parameters<TestExecutionRepositoryPort["claimTurn"]>[0]) {
    this.calls.push(`claim:${input.sideIds.join(",")}`);
    this.lastLeaseMs = input.leaseMs;
    if (this.replay) {
      return { claims: input.sideIds.map((sideId) => ({ sideId, attempt: { executionId: input.executionId, sideId, turnId: input.turnId, attemptId: input.attemptId, message: input.message, inputFingerprint: input.inputFingerprint, fence: 1, leaseExpiresAt: input.now, state: "completed" as const }, replay: this.replay })) };
    }
    const claims = input.sideIds.map((sideId) => {
      const side = this.execution!.sides.find((item) => item.id === sideId)!;
      const existing = side.history.find((item) => item.turnId === input.turnId && item.role === "user");
      if (!existing) (side.history as Array<unknown>).push({ turnId: input.turnId, attemptId: input.attemptId, role: "user", content: input.message, createdAt: input.now });
      side.state = "running";
      return { sideId, attempt: { executionId: input.executionId, sideId, turnId: input.turnId, attemptId: input.attemptId, message: input.message, inputFingerprint: input.inputFingerprint, fence: 1, leaseExpiresAt: new Date(input.now.getTime() + input.leaseMs), state: "running" as const } };
    });
    return { claims };
  }
  async complete(input: Parameters<TestExecutionRepositoryPort["complete"]>[0]) {
    this.completeCalls += 1;
    const side = this.execution!.sides.find((item) => item.id === input.sideId)!;
    side.state = "completed"; side.retryable = false; side.continuation = input.result.continuation;
    (side.history as Array<unknown>).push({ turnId: input.turnId, attemptId: input.attemptId, role: "assistant", content: input.result.answer, messageId: input.result.messageId, createdAt: input.now });
    this.execution!.state = this.execution!.sides.every((item) => item.state === "completed") ? "completed" : "running";
    return this.execution!;
  }
  async fail(input: Parameters<TestExecutionRepositoryPort["fail"]>[0]) {
    if (this.failThrows) throw new Error("persistence unavailable");
    const side = this.execution!.sides.find((item) => item.id === input.sideId)!;
    side.state = "failed"; side.retryable = true; this.execution!.state = "partial";
    return this.execution!;
  }
}

const setup = (
  runner = vi.fn(async (_input: Parameters<TrustedTestExecutionRunnerPort["run"]>[0]): Promise<TestExecutionRunnerResult> => ({ answer: "answer", messageId: ids[6], continuation: { routine: "next" } })),
  usageLimitPolicy: Pick<UsageLimitPolicy, "reserveAnswer"> = new NoopUsageLimitPolicy(),
  options: { defaultRevision?: TestExecutionDefaultRevisionPort; draftGeneration?: number } = {},
) => {
  const repository = new MemoryRepository();
  let next = 2;
  const revisions = { findRevision: vi.fn(async ({ revisionId }: { revisionId: string }) => revisionId === ids[0] ? revision(ids[0]) : revision(ids[1])), readDraftGeneration: vi.fn(async () => options.draftGeneration ?? 1) };
  const service = new TestExecutionService({
    revisions,
    ...(options.defaultRevision ? { defaultRevision: options.defaultRevision } : {}),
    contextCatalog: { get: vi.fn(async () => ({ id: "40000000-0000-4000-8000-000000000001", workspaceId, name: "account_tier", description: null, valueType: "string" as const, trustTier: "signed" as const, sensitivity: "normal" as const, defaultSurfacing: "always" as const, createdAt: new Date(0), updatedAt: new Date(0) })) },
    repository, runner: { run: runner }, usageLimitPolicy, createId: () => ids[next++], now: () => new Date(1000),
  });
  return { service, repository, runner, revisions };
};

describe("TestExecutionService", () => {
  it("freezes distinct selected revisions and validated samples before creating independent compare sides", async () => {
    const { service, repository } = setup();
    const execution = await service.start({ idempotencyKey: "idem-test", workspaceId, agentId, accountId: null, mode: "compare", revisionIds: [ids[0], ids[1]], testValues: [{ contextVariableId: "40000000-0000-4000-8000-000000000001", value: "gold" }], expectedDraftGeneration: 1 });
    expect(execution.sides).toHaveLength(2);
    expect(execution.sides.map((side) => side.conversationId)).not.toContain(undefined);
    expect(execution.testValues[0]).toMatchObject({ name: "account_tier", trust: "verified", value: "gold" });
    expect(repository.execution?.mode).toBe("compare");
  });

  it("persists one isolated assistant-first greeting per selected immutable side", async () => {
    const repository = new MemoryRepository();
    const bootstrap = vi.fn(async ({ candidateRevision }: { candidateRevision: AgentRevision }) => ({
      answer: `Ciao from ${candidateRevision.id}`,
      messageId: `greeting-${candidateRevision.id}`,
    }));
    const service = new TestExecutionService({
      revisions: { findRevision: vi.fn(async ({ revisionId }) => revision(revisionId, false)), readDraftGeneration: vi.fn(async () => 1) },
      contextCatalog: { get: vi.fn() }, repository,
      runner: { bootstrap, run: vi.fn() }, usageLimitPolicy: new NoopUsageLimitPolicy(), createId: () => ids[2], now: () => new Date(1000),
    });

    const execution = await service.start({ idempotencyKey: "idem-test", workspaceId, agentId, accountId: "account-1", mode: "compare", revisionIds: [ids[0], ids[1]], testValues: [] });

    expect(bootstrap).toHaveBeenCalledTimes(2);
    expect(bootstrap).toHaveBeenNthCalledWith(1, expect.objectContaining({ candidateRevision: expect.objectContaining({ id: ids[0] }) }));
    expect(execution.sides.map((side) => side.history)).toEqual([
      [expect.objectContaining({ role: "assistant", content: `Ciao from ${ids[0]}` })],
      [expect.objectContaining({ role: "assistant", content: `Ciao from ${ids[1]}` })],
    ]);
  });

  it("keeps lazy first send when no runner bootstrap is configured", async () => {
    const { service } = setup();
    const execution = await service.start({ idempotencyKey: "idem-test", workspaceId, agentId, accountId: null, mode: "single", revisionIds: [ids[0]], testValues: [] });

    expect(execution.sides[0]?.history).toEqual([]);
  });

  it("defaults skillEffects to suppressed and threads the frozen policy into every runner turn", async () => {
    const { service, runner } = setup();
    const execution = await service.start({ idempotencyKey: "idem-test", workspaceId, agentId, accountId: null, mode: "single", revisionIds: [ids[0]], testValues: [] });

    expect(execution.skillEffects).toBe("suppressed");

    await service.message({ workspaceId, agentId, accountId: null, executionId: execution.id, message: "first", generation: 1, turnId: ids[6], attemptId: ids[7] });

    expect(runner.mock.calls.at(-1)?.[0]).toMatchObject({ skillEffects: "suppressed" });
  });

  it("passes the requesting account through to the runner so account-scoped skills (e.g. Slack) can resolve", async () => {
    const { service, runner } = setup();
    const execution = await service.start({ idempotencyKey: "idem-test", workspaceId, agentId, accountId: "account-7", mode: "single", revisionIds: [ids[0]], testValues: [], skillEffects: "allowed" });

    await service.message({ workspaceId, agentId, accountId: "account-7", executionId: execution.id, message: "first", generation: 1, turnId: ids[6], attemptId: ids[7] });

    expect(runner.mock.calls.at(-1)?.[0]).toMatchObject({ accountId: "account-7" });
  });

  it("claims each attempt with a lease that outlasts a turn carrying a full-length external tool call", async () => {
    const { service, repository } = setup();
    const execution = await service.start({ idempotencyKey: "idem-test", workspaceId, agentId, accountId: null, mode: "single", revisionIds: [ids[0]], testValues: [], skillEffects: "allowed" });

    await service.message({ workspaceId, agentId, accountId: null, executionId: execution.id, message: "first", generation: 1, turnId: ids[6], attemptId: ids[7] });

    // An external call is bounded at up to 90s (EXTERNAL_MCP_TOOL_CALL_TIMEOUT_MS cap) plus a
    // 10s connect, and a turn can chain a few such steps; the lease must cover more than one so
    // a concurrent detail read cannot expire a still-running attempt and let Retry re-fire it.
    expect(repository.lastLeaseMs).toBeGreaterThanOrEqual(200_000);
  });

  it("persists and echoes an explicitly requested skillEffects override", async () => {
    const { service, runner } = setup();
    const execution = await service.start({ idempotencyKey: "idem-test", workspaceId, agentId, accountId: null, mode: "single", revisionIds: [ids[0]], testValues: [], skillEffects: "allowed" });

    expect(execution.skillEffects).toBe("allowed");

    await service.message({ workspaceId, agentId, accountId: null, executionId: execution.id, message: "first", generation: 1, turnId: ids[6], attemptId: ids[7] });

    expect(runner.mock.calls.at(-1)?.[0]).toMatchObject({ skillEffects: "allowed" });
  });

  it("rejects duplicate, disabled, and incompatible supplied samples instead of omitting them", async () => {
    const { service } = setup();
    await expect(service.start({ idempotencyKey: "idem-test", workspaceId, agentId, accountId: null, mode: "single", revisionIds: [ids[0]], testValues: [{ contextVariableId: "40000000-0000-4000-8000-000000000001", value: "a" }, { contextVariableId: "40000000-0000-4000-8000-000000000001", value: "b" }] })).rejects.toMatchObject({ code: "bad_request" });
    await expect(service.start({ idempotencyKey: "idem-test", workspaceId, agentId, accountId: null, mode: "single", revisionIds: [ids[0]], testValues: [{ contextVariableId: "40000000-0000-4000-8000-000000000001", value: 3 }] })).rejects.toMatchObject({ code: "bad_request" });
  });

  it("rejects a selected deleted definition without a sample and freezes candidate and supplied JSON values", async () => {
    const sourceRevision = revision(ids[0]);
    const repository = new MemoryRepository();
    const supplied = { plan: "gold" };
    const service = new TestExecutionService({
      revisions: { findRevision: vi.fn(async () => sourceRevision), readDraftGeneration: vi.fn(async () => 1) },
      contextCatalog: { get: vi.fn(async () => null) }, repository,
      runner: { run: vi.fn() }, usageLimitPolicy: new NoopUsageLimitPolicy(), createId: () => ids[2], now: () => new Date(1000),
    });
    await expect(service.start({ idempotencyKey: "idem-test", workspaceId, agentId, accountId: null, mode: "single", revisionIds: [ids[0]], testValues: [] })).rejects.toMatchObject({ code: "bad_request" });

    const jsonRevision = structuredClone(sourceRevision);
    jsonRevision.snapshot.contextVariableEnablements[0].variableId = "40000000-0000-4000-8000-000000000009";
    const jsonService = new TestExecutionService({
      revisions: { findRevision: vi.fn(async () => jsonRevision), readDraftGeneration: vi.fn(async () => 1) },
      contextCatalog: { get: vi.fn(async () => ({ id: jsonRevision.snapshot.contextVariableEnablements[0].variableId, workspaceId, name: "options", description: null, valueType: "json" as const, trustTier: "unverified" as const, sensitivity: "normal" as const, defaultSurfacing: "always" as const, createdAt: new Date(0), updatedAt: new Date(0) })) },
      repository, runner: { run: vi.fn() }, usageLimitPolicy: new NoopUsageLimitPolicy(), createId: () => ids[3], now: () => new Date(1000),
    });
    await expect(jsonService.start({ workspaceId, agentId, accountId: null, mode: "single", revisionIds: [ids[0]], testValues: [{ contextVariableId: jsonRevision.snapshot.contextVariableEnablements[0].variableId, value: undefined }] })).rejects.toMatchObject({ code: "bad_request" });
    const execution = await jsonService.start({ workspaceId, agentId, accountId: null, mode: "single", revisionIds: [ids[0]], testValues: [{ contextVariableId: jsonRevision.snapshot.contextVariableEnablements[0].variableId, value: supplied }] });
    supplied.plan = "draft changed";
    jsonRevision.snapshot.contextVariableEnablements[0].enabled = false;
    expect(execution.testValues[0]?.value).toEqual({ plan: "gold" });
    expect(Object.isFrozen(execution.testValues[0]?.value)).toBe(true);
    expect(execution.sides[0]?.revision.snapshot.contextVariableEnablements[0]?.enabled).toBe(true);
  });

  it("passes persisted side continuation into the next safe-test turn only after the claim is durable", async () => {
    const runner = vi.fn(async (input: { continuation: unknown }): Promise<TestExecutionRunnerResult> => ({ answer: "answer", messageId: ids[6], continuation: input.continuation ? { routine: "later" } : { routine: "next" } }));
    const { service, repository } = setup(runner);
    const execution = await service.start({ idempotencyKey: "idem-test", workspaceId, agentId, accountId: null, mode: "single", revisionIds: [ids[0]], testValues: [] });
    await service.message({ workspaceId, agentId, accountId: null, executionId: execution.id, message: "first", generation: 1, turnId: ids[6], attemptId: ids[7] });
    repository.execution!.state = "completed";
    await service.message({ workspaceId, agentId, accountId: null, executionId: execution.id, message: "second", generation: 1, turnId: "50000000-0000-4000-8000-000000000001", attemptId: "60000000-0000-4000-8000-000000000001" });
    expect(runner).toHaveBeenCalledTimes(2);
    expect(runner.mock.calls.at(-1)?.[0].continuation).toEqual({ routine: "next" });
    expect(repository.calls).toEqual(expect.arrayContaining([expect.stringMatching(/^claim:/)]));
  });

  it("forks one settled comparison side into a single private execution without replaying the other version", async () => {
    const runner = vi.fn(async (input: { continuation: unknown }): Promise<TestExecutionRunnerResult> => ({
      answer: "answer", messageId: ids[6], continuation: input.continuation ? { routine: "later" } : { routine: "next" },
    }));
    const { service, repository } = setup(runner);
    const comparison = await service.start({ idempotencyKey: "idem-test", workspaceId, agentId, accountId: null, mode: "compare", revisionIds: [ids[0], ids[1]], testValues: [] });
    await service.message({ workspaceId, agentId, accountId: null, executionId: comparison.id, message: "first", generation: 1, turnId: ids[6], attemptId: ids[7] });
    const retained = await service.retainSide({ workspaceId, agentId, accountId: null, executionId: comparison.id, sideId: comparison.sides[1].id });

    expect(retained).toMatchObject({ mode: "single", testValues: comparison.testValues });
    expect(retained.sides).toHaveLength(1);
    expect(retained.sides[0]).toMatchObject({ revision: { id: ids[1] }, continuation: { routine: "next" } });
    expect(retained.sides[0]?.conversationId).not.toBe(comparison.sides[1]?.conversationId);
    expect(retained.sides[0]?.history).toEqual(comparison.sides[1]?.history);

    await service.message({ workspaceId, agentId, accountId: null, executionId: retained.id, message: "follow-up", generation: 1, turnId: "50000000-0000-4000-8000-000000000001", attemptId: "60000000-0000-4000-8000-000000000001" });
    expect(runner).toHaveBeenCalledTimes(3);
    expect(runner.mock.calls.at(-1)?.[0]).toMatchObject({ candidateRevision: { id: ids[1] }, continuation: { routine: "next" } });
    expect(repository.calls.at(-1)).toBe(`claim:${retained.sides[0].id}`);
  });

  it("retains the successful comparison side and emits retry output for only the failed side", async () => {
    let invocation = 0;
    const runner = vi.fn(async (input: { candidateRevision: AgentRevision }): Promise<TestExecutionRunnerResult> => {
      invocation += 1;
      if (invocation === 2) throw new Error("provider timeout");
      return { answer: input.candidateRevision.id, messageId: ids[6], continuation: null };
    });
    const { service, repository } = setup(runner);
    const execution = await service.start({ idempotencyKey: "idem-test", workspaceId, agentId, accountId: null, mode: "compare", revisionIds: [ids[0], ids[1]], testValues: [] });
    const initial = await service.message({ workspaceId, agentId, accountId: null, executionId: execution.id, message: "test", generation: 1, turnId: ids[6], attemptId: ids[7] });
    expect(initial.some((event) => event.type === "execution_partial")).toBe(true);
    const successful = repository.execution!.sides.find((side) => side.state === "completed")!;
    const failed = repository.execution!.sides.find((side) => side.state === "failed")!;
    const retry = await service.retry({ workspaceId, agentId, accountId: null, executionId: execution.id, sideId: failed.id, generation: 1, turnId: ids[6], attemptId: "70000000-0000-4000-8000-000000000001" });
    expect(retry.filter((event) => event.type === "message_delta")).toHaveLength(1);
    expect(successful.state).toBe("completed");
  });

  it("delivery-replays a persisted result without provider work or a second completion", async () => {
    const commit = vi.fn(async () => undefined);
    const reserveAnswer = vi.fn(async () => ({ commit, release: vi.fn(async () => undefined) }));
    const { service, repository, runner } = setup(undefined, { reserveAnswer });
    const execution = await service.start({ idempotencyKey: "idem-test", workspaceId, agentId, accountId: null, mode: "single", revisionIds: [ids[0]], testValues: [] });
    await service.message({ workspaceId, agentId, accountId: null, executionId: execution.id, message: "first", generation: 1, turnId: ids[6], attemptId: ids[7] });
    repository.replay = { answer: "cached", messageId: ids[6], continuation: null };
    const replay = await service.retry({ workspaceId, agentId, accountId: null, executionId: execution.id, sideId: execution.sides[0].id, generation: 1, turnId: ids[6], attemptId: "70000000-0000-4000-8000-000000000001" });
    expect(replay.find((event) => event.type === "message_delta")).toMatchObject({ delta: "cached" });
    expect(runner).toHaveBeenCalledTimes(1);
    expect(repository.completeCalls).toBe(1);
    expect(reserveAnswer).toHaveBeenCalledOnce();
    expect(commit).toHaveBeenCalledOnce();
  });

  it("reserves and commits once for each actual comparison-side provider attempt with request attribution", async () => {
    const commit = vi.fn(async () => undefined);
    const reserveAnswer = vi.fn(async () => ({ commit, release: vi.fn(async () => undefined) }));
    const { service, runner } = setup(undefined, { reserveAnswer });
    const execution = await service.start({ idempotencyKey: "idem-test", workspaceId, agentId, accountId: "account-1", mode: "compare", revisionIds: [ids[0], ids[1]], testValues: [] });

    await service.message({ workspaceId, agentId, accountId: "account-1", executionId: execution.id, message: "first", generation: 1, turnId: ids[6], attemptId: ids[7] });

    expect(runner).toHaveBeenCalledTimes(2);
    expect(reserveAnswer).toHaveBeenCalledTimes(2);
    expect(reserveAnswer).toHaveBeenNthCalledWith(1, { accountId: "account-1", workspaceId, surface: "test_execution", usage: "test_run" });
    expect(reserveAnswer).toHaveBeenNthCalledWith(2, { accountId: "account-1", workspaceId, surface: "test_execution", usage: "test_run" });
    expect(commit).toHaveBeenCalledTimes(2);
  });

  it("refuses a quota-exhausted side before dispatching its runner and preserves the quota error code", async () => {
    const runner = vi.fn(async (): Promise<TestExecutionRunnerResult> => ({ answer: "answer", messageId: ids[6], continuation: null }));
    const reserveAnswer = vi.fn(async () => { throw Object.assign(new Error("Usage limit exceeded"), { code: "usage_limit_exceeded", statusCode: 429 }); });
    const { service } = setup(runner, { reserveAnswer });
    const execution = await service.start({ idempotencyKey: "idem-test", workspaceId, agentId, accountId: "account-1", mode: "single", revisionIds: [ids[0]], testValues: [] });

    const events = await service.message({ workspaceId, agentId, accountId: "account-1", executionId: execution.id, message: "first", generation: 1, turnId: ids[6], attemptId: ids[7] });

    expect(runner).not.toHaveBeenCalled();
    expect(events).toEqual(expect.arrayContaining([expect.objectContaining({ type: "side_failed", code: "usage_limit_exceeded", retryable: true })]));
  });

  it("commits a reservation when a dispatched provider attempt fails", async () => {
    const commit = vi.fn(async () => undefined);
    const reserveAnswer = vi.fn(async () => ({ commit, release: vi.fn(async () => undefined) }));
    const runner = vi.fn(async (): Promise<TestExecutionRunnerResult> => { throw new Error("provider unavailable"); });
    const { service } = setup(runner, { reserveAnswer });
    const execution = await service.start({ idempotencyKey: "idem-test", workspaceId, agentId, accountId: "account-1", mode: "single", revisionIds: [ids[0]], testValues: [] });

    await service.message({ workspaceId, agentId, accountId: "account-1", executionId: execution.id, message: "first", generation: 1, turnId: ids[6], attemptId: ids[7] });

    expect(commit).toHaveBeenCalledOnce();
  });

  it("yields a fast side before a slow comparison side settles", async () => {
    let resolveSlow!: (result: TestExecutionRunnerResult) => void;
    const slow = new Promise<TestExecutionRunnerResult>((resolve) => { resolveSlow = resolve; });
    let calls = 0;
    const runner = vi.fn(async (): Promise<TestExecutionRunnerResult> => {
      calls += 1;
      return calls === 1 ? { answer: "fast", messageId: ids[6], continuation: null } : slow;
    });
    const { service } = setup(runner);
    const execution = await service.start({ idempotencyKey: "idem-test", workspaceId, agentId, accountId: null, mode: "compare", revisionIds: [ids[0], ids[1]], testValues: [] });
    const stream = service.streamMessage({ workspaceId, agentId, accountId: null, executionId: execution.id, message: "test", generation: 1, turnId: ids[6], attemptId: ids[7] });
    expect((await stream.next()).value).toMatchObject({ type: "side_started" });
    expect((await stream.next()).value).toMatchObject({ type: "side_started" });
    expect((await stream.next()).value).toMatchObject({ type: "message_delta", delta: "fast" });
    resolveSlow({ answer: "slow", messageId: ids[7], continuation: null });
  });

  it("turns a side persistence rejection into a bounded failed transport event", async () => {
    const runner = vi.fn(async (): Promise<TestExecutionRunnerResult> => { throw new Error("provider unavailable"); });
    const { service, repository } = setup(runner);
    repository.failThrows = true;
    const execution = await service.start({ idempotencyKey: "idem-test", workspaceId, agentId, accountId: null, mode: "single", revisionIds: [ids[0]], testValues: [] });
    const events = await service.message({ workspaceId, agentId, accountId: null, executionId: execution.id, message: "first", generation: 1, turnId: ids[6], attemptId: ids[7] });
    expect(events).toEqual(expect.arrayContaining([expect.objectContaining({ type: "side_failed", code: "persistence_failed", retryable: false })]));
  });

  it("self-heals a side stuck running past its lease on a plain detail read, without requiring a client-driven retry", async () => {
    const { service, repository } = setup();
    const execution = await service.start({ idempotencyKey: "idem-test", workspaceId, agentId, accountId: null, mode: "single", revisionIds: [ids[0]], testValues: [] });
    repository.execution!.sides[0].state = "running";
    repository.execution!.state = "running";
    repository.staleLease = new Date(500);

    const detail = await service.detail({ workspaceId, agentId, executionId: execution.id });

    expect(repository.recoverExpiredSidesCalls).toBe(1);
    expect(detail.execution.sides[0]?.state).toBe("failed");
    expect(detail.execution.sides[0]?.retryable).toBe(true);
  });

  it("does not attempt lease recovery on a read once the execution has already settled", async () => {
    const { service, repository } = setup();
    const execution = await service.start({ idempotencyKey: "idem-test", workspaceId, agentId, accountId: null, mode: "single", revisionIds: [ids[0]], testValues: [] });
    repository.execution!.sides[0].state = "completed";
    repository.execution!.state = "completed";

    await service.detail({ workspaceId, agentId, executionId: execution.id });

    expect(repository.recoverExpiredSidesCalls).toBe(0);
  });

  describe("seeded from a conversation", () => {
    const seedConversationId = "70000000-0000-4000-8000-000000000001";
    const seed = (messages: TestExecutionSeed["messages"], continuation: unknown = null): TestExecutionSeed => ({ messages, continuation });
    const thread: TestExecutionSeed["messages"] = [
      { role: "assistant", content: "Welcome", messageId: "m-0", createdAt: new Date(10) },
      { role: "user", content: "hello", messageId: "m-1", createdAt: new Date(20) },
      { role: "assistant", content: "hi there", messageId: "m-2", createdAt: new Date(30) },
      { role: "user", content: "another", messageId: "m-3", createdAt: new Date(40) },
    ];
    const seededSetup = (loadSeed: TestExecutionSeedSource["loadSeed"], bootstrap?: TrustedTestExecutionRunnerPort["bootstrap"]) => {
      const repository = new MemoryRepository();
      const audit = vi.fn(async () => {});
      let next = 1;
      const service = new TestExecutionService({
        revisions: { findRevision: vi.fn(async ({ revisionId }) => revision(revisionId, false)), readDraftGeneration: vi.fn(async () => 1) },
        contextCatalog: { get: vi.fn() }, repository,
        runner: { run: vi.fn(), ...(bootstrap ? { bootstrap } : {}) }, seedSource: { loadSeed },
        audit: { record: audit }, usageLimitPolicy: new NoopUsageLimitPolicy(), createId: () => `80000000-0000-4000-8000-${String(next++).padStart(12, "0")}`, now: () => new Date(1000),
      });
      return { service, repository, audit };
    };

    it("populates the single side's history and continuation from the source and keeps its own fresh conversation id", async () => {
      const continuation = { version: 1, routineState: { routineId: "booking", path: ["start"], variables: {}, status: "active" }, pendingClarification: null, directiveState: null };
      const loadSeed = vi.fn(async () => seed(thread, continuation));
      const { service } = seededSetup(loadSeed);

      const execution = await service.start({ idempotencyKey: "idem-seed", workspaceId, agentId, accountId: null, mode: "single", revisionIds: [ids[0]], testValues: [], seedConversationId });

      expect(loadSeed).toHaveBeenCalledWith({ workspaceId, agentId, conversationId: seedConversationId });
      const side = execution.sides[0];
      expect(side.conversationId).not.toBe(seedConversationId);
      expect(side.continuation).toEqual(continuation);
      expect(side.history.map(({ role, content, messageId, createdAt }) => ({ role, content, messageId, createdAt }))).toEqual(thread);
    });

    it("groups a seeded user message with the assistant reply that follows it under one turn", async () => {
      const { service } = seededSetup(async () => seed(thread));

      const execution = await service.start({ idempotencyKey: "idem-seed", workspaceId, agentId, accountId: null, mode: "single", revisionIds: [ids[0]], testValues: [], seedConversationId });

      const history = execution.sides[0].history;
      expect(history.every((entry) => entry.turnId && entry.attemptId)).toBe(true);
      expect(history[1].turnId).toBe(history[2].turnId);
      expect(history[1].attemptId).toBe(history[2].attemptId);
      expect(new Set(history.map((entry) => entry.turnId)).size).toBe(3);
    });

    it("never injects a greeting into a seeded execution, even when the runner bootstraps", async () => {
      const bootstrap = vi.fn(async () => ({ answer: "Ciao", messageId: "greeting" }));
      const { service } = seededSetup(async () => seed([]), bootstrap);

      const execution = await service.start({ idempotencyKey: "idem-seed", workspaceId, agentId, accountId: null, mode: "single", revisionIds: [ids[0]], testValues: [], seedConversationId });

      expect(bootstrap).not.toHaveBeenCalled();
      expect(execution.sides[0].history).toEqual([]);
      expect(execution.sides[0].continuation).toBeNull();
    });

    it("rejects seeding a comparison before touching the source", async () => {
      const loadSeed = vi.fn(async () => seed(thread));
      const { service } = seededSetup(loadSeed);

      await expect(service.start({ idempotencyKey: "idem-seed", workspaceId, agentId, accountId: null, mode: "compare", revisionIds: [ids[0], ids[1]], testValues: [], seedConversationId }))
        .rejects.toMatchObject({ statusCode: 400 });
      expect(loadSeed).not.toHaveBeenCalled();
    });

    it("answers 404 when the seed source does not own the conversation", async () => {
      const { service, repository } = seededSetup(async () => null);

      await expect(service.start({ idempotencyKey: "idem-seed", workspaceId, agentId, accountId: null, mode: "single", revisionIds: [ids[0]], testValues: [], seedConversationId }))
        .rejects.toMatchObject({ statusCode: 404 });
      expect(repository.execution).toBeNull();
    });

    it("records the seed conversation on the start audit event", async () => {
      const { service, audit } = seededSetup(async () => seed(thread));

      await service.start({ idempotencyKey: "idem-seed", workspaceId, agentId, accountId: null, mode: "single", revisionIds: [ids[0]], testValues: [], seedConversationId });

      expect(audit).toHaveBeenCalledWith(expect.objectContaining({ eventType: "agent.test_execution.started", metadata: expect.objectContaining({ seedConversationId, seededMessageCount: 4 }) }));
    });
  });
});

describe("test execution turns", () => {
  const entry = (overrides: Partial<TestExecution["sides"][number]["history"][number]>) => ({
    turnId: "turn-1", attemptId: "attempt-1", role: "user" as const, content: "Can I book a demo?", createdAt: new Date(1_000), ...overrides,
  });
  const attempt = (overrides: Partial<TestExecutionAttemptRecord>): TestExecutionAttemptRecord => ({
    executionId: "execution-1", sideId: "side-1", turnId: "turn-1", attemptId: "attempt-1", fence: 1, state: "completed", failureCode: null,
    leaseExpiresAt: new Date(0), createdAt: new Date(0), updatedAt: new Date(0), ...overrides,
  });

  it("pairs each user message with its answer and keeps a greeting as a turn with no user message", () => {
    const turns = readSideTurns({ id: "side-1", history: [
      entry({ turnId: "greeting", role: "assistant", content: "Hi!", messageId: "bootstrap:1", createdAt: new Date(500) }),
      entry({}),
      entry({ role: "assistant", content: "Sure, here is how.", messageId: "message-1", turnTrace: { version: 1 }, createdAt: new Date(2_000) }),
    ] }, [attempt({})]);

    expect(turns).toEqual([
      { turnId: "greeting", userMessage: null, answer: { messageId: "bootstrap:1", content: "Hi!" }, state: "completed", failureCode: null, createdAt: new Date(500), turnTrace: undefined },
      { turnId: "turn-1", userMessage: "Can I book a demo?", answer: { messageId: "message-1", content: "Sure, here is how." }, state: "completed", failureCode: null, createdAt: new Date(1_000), turnTrace: { version: 1 } },
    ]);
  });

  it("takes an unanswered turn's state and failure code from its highest-fenced attempt on the same side", () => {
    const turns = readSideTurns({ id: "side-1", history: [entry({ turnId: "failed" }), entry({ turnId: "running" }), entry({ turnId: "seeded" })] }, [
      attempt({ turnId: "failed", fence: 2, state: "failed", failureCode: "runner_failed" }),
      attempt({ turnId: "failed", fence: 1, state: "failed", failureCode: "lease_expired" }),
      attempt({ turnId: "running", state: "running" }),
      attempt({ turnId: "seeded", sideId: "side-2", state: "failed", failureCode: "runner_failed" }),
    ]);

    expect(turns.map(({ turnId, answer, state, failureCode }) => ({ turnId, answer, state, failureCode }))).toEqual([
      { turnId: "failed", answer: null, state: "failed", failureCode: "runner_failed" },
      { turnId: "running", answer: null, state: "running", failureCode: null },
      { turnId: "seeded", answer: null, state: "unanswered", failureCode: null },
    ]);
  });
});

describe("TestExecutionService turn reads", () => {
  const scope = { workspaceId, agentId };

  it("reads an execution as turns per side, without its continuation, conversation, or frozen inputs", async () => {
    const { service, repository } = setup();
    const execution = await service.start({ ...scope, idempotencyKey: "idem-read", accountId: null, mode: "single", revisionIds: [ids[0]], testValues: [] });
    await service.message({ ...scope, accountId: null, executionId: execution.id, message: "hello", generation: 1, turnId: "turn-1", attemptId: "attempt-1" });
    repository.execution!.state = "running";

    const transcript = await service.transcript({ ...scope, executionId: execution.id });

    expect(repository.recoverExpiredSidesCalls).toBe(1);
    expect(transcript).toEqual({
      id: execution.id, mode: "single", generation: 1, state: "completed", skillEffects: "suppressed", createdAt: new Date(0),
      sides: [{ id: execution.sides[0].id, revision: execution.sides[0].revision, state: "completed", turns: [
        { turnId: "turn-1", userMessage: "hello", answer: { messageId: ids[6], content: "answer" }, state: "completed", failureCode: null, createdAt: new Date(1000), turnTrace: undefined },
      ] }],
    });
  });

  it("reads the turn a message settled, on the first side unless one is named, and answers 404 for an unknown side or turn", async () => {
    const { service, repository } = setup();
    const execution = await service.start({ ...scope, idempotencyKey: "idem-turn", accountId: null, mode: "single", revisionIds: [ids[0]], testValues: [] });
    const sideId = execution.sides[0].id;
    await service.message({ ...scope, accountId: null, executionId: execution.id, message: "hello", generation: 1, turnId: "turn-1", attemptId: "attempt-1" });
    repository.attempts = [{ executionId: execution.id, sideId, turnId: "turn-1", attemptId: "attempt-1", fence: 1, state: "completed", failureCode: null, leaseExpiresAt: new Date(0), createdAt: new Date(0), updatedAt: new Date(0) }];

    await expect(service.turn({ ...scope, executionId: execution.id, turnId: "turn-1" })).resolves.toEqual({
      executionId: execution.id,
      side: { id: sideId, revision: execution.sides[0].revision, state: "completed" },
      turn: expect.objectContaining({ turnId: "turn-1", answer: { messageId: ids[6], content: "answer" }, state: "completed" }),
    });
    await expect(service.turn({ ...scope, executionId: execution.id, turnId: "turn-1", sideId })).resolves.toMatchObject({ side: { id: sideId } });
    await expect(service.turn({ ...scope, executionId: execution.id, turnId: "turn-2" })).rejects.toMatchObject({ statusCode: 404 });
    await expect(service.turn({ ...scope, executionId: execution.id, turnId: "turn-1", sideId: "side-unknown" })).rejects.toMatchObject({ statusCode: 404 });
  });

  it("lists a page with each execution's turn count and opening message from one projection read", async () => {
    const { service, repository } = setup();
    const item = (id: string): TestExecutionHistoryItem => ({ id, mode: "single", generation: 1, state: "completed", createdAt: new Date(0), skillEffects: "suppressed", sides: [] });
    const list = vi.spyOn(repository, "list").mockResolvedValue({ executions: [item("execution-1"), item("execution-2")], nextCursor: "cursor-2", hasMore: true });
    repository.transcriptSummaries.set("execution-1", { turnCount: 2, firstMessage: "Can I book a demo?" });

    const page = await service.summaries({ ...scope, limit: 2, cursor: "cursor-1" });

    expect(list).toHaveBeenCalledWith({ ...scope, limit: 2, cursor: "cursor-1" });
    expect(repository.calls).toEqual(["summarize:execution-1,execution-2"]);
    expect(page).toEqual({
      executions: [
        { ...item("execution-1"), turnCount: 2, firstMessage: "Can I book a demo?" },
        { ...item("execution-2"), turnCount: 0, firstMessage: null },
      ],
      nextCursor: "cursor-2",
      hasMore: true,
    });
  });
});

describe("TestExecutionService default revision", () => {
  const scope = { workspaceId, agentId, accountId: null, testValues: [] };

  it("starts a single test on the agent's default revision, fenced on the draft generation it was chosen from, once per idempotency key", async () => {
    const resolveDefault = vi.fn(async () => ({ revisionId: ids[1], expectedDraftGeneration: 1 }));
    const { service, revisions } = setup(undefined, undefined, { defaultRevision: { resolveDefault } });

    const execution = await service.start({ ...scope, mode: "single", idempotencyKey: "idem-default" });
    await service.start({ ...scope, mode: "single", idempotencyKey: "idem-default" });

    expect(resolveDefault).toHaveBeenCalledTimes(1);
    expect(resolveDefault).toHaveBeenCalledWith({ workspaceId, agentId });
    expect(revisions.readDraftGeneration).toHaveBeenCalledWith({ workspaceId, agentId });
    expect(execution.sides.map((side) => side.revision.id)).toEqual([ids[1]]);
  });

  it("refuses a default start when the draft moved after the default was chosen", async () => {
    const resolveDefault = vi.fn(async () => ({ revisionId: ids[1], expectedDraftGeneration: 1 }));
    const { service } = setup(undefined, undefined, { defaultRevision: { resolveDefault }, draftGeneration: 2 });

    await expect(service.start({ ...scope, mode: "single", idempotencyKey: "idem-moved" })).rejects.toMatchObject({ statusCode: 409 });
  });

  it("refuses a default for a comparison, or where no default source is configured", async () => {
    const resolveDefault = vi.fn(async () => ({ revisionId: ids[1], expectedDraftGeneration: 1 }));

    await expect(setup(undefined, undefined, { defaultRevision: { resolveDefault } }).service.start({ ...scope, mode: "compare", idempotencyKey: "idem-compare" }))
      .rejects.toMatchObject({ statusCode: 400 });
    expect(resolveDefault).not.toHaveBeenCalled();
    await expect(setup().service.start({ ...scope, mode: "single", idempotencyKey: "idem-unconfigured" })).rejects.toMatchObject({ statusCode: 400 });
  });
});
