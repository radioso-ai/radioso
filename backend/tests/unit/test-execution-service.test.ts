import { describe, expect, it, vi } from "vitest";

import type { AgentRevision } from "../../src/modules/agents/agentRevision.js";
import {
  TestExecutionService,
  type TestExecution,
  type TestExecutionRepositoryPort,
  type TestExecutionRunnerResult,
} from "../../src/modules/test-execution/testExecution.js";
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
  async create(input: Parameters<TestExecutionRepositoryPort["create"]>[0]) {
    this.execution = { ...input, state: input.state ?? "running", createdAt: new Date(0) };
    return this.execution;
  }
  async find(): Promise<TestExecution | null> { return this.execution; }
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
  async list() { return { executions: this.execution ? [this.execution] : [], nextCursor: null, hasMore: false }; }
  async listAttempts() { return []; }
  async claimTurn(input: Parameters<TestExecutionRepositoryPort["claimTurn"]>[0]) {
    this.calls.push(`claim:${input.sideIds.join(",")}`);
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
  runner = vi.fn(async (): Promise<TestExecutionRunnerResult> => ({ answer: "answer", messageId: ids[6], continuation: { routine: "next" } })),
  usageLimitPolicy: Pick<UsageLimitPolicy, "reserveAnswer"> = new NoopUsageLimitPolicy(),
) => {
  const repository = new MemoryRepository();
  let next = 2;
  const service = new TestExecutionService({
    revisions: { findRevision: vi.fn(async ({ revisionId }) => revisionId === ids[0] ? revision(ids[0]) : revision(ids[1])), readDraftGeneration: vi.fn(async () => 1) },
    contextCatalog: { get: vi.fn(async () => ({ id: "40000000-0000-4000-8000-000000000001", workspaceId, name: "account_tier", description: null, valueType: "string" as const, trustTier: "signed" as const, sensitivity: "normal" as const, defaultSurfacing: "always" as const, createdAt: new Date(0), updatedAt: new Date(0) })) },
    repository, runner: { run: runner }, usageLimitPolicy, createId: () => ids[next++], now: () => new Date(1000),
  });
  return { service, repository, runner };
};

describe("TestExecutionService", () => {
  it("freezes distinct selected revisions and validated samples before creating independent compare sides", async () => {
    const { service, repository } = setup();
    const execution = await service.start({ workspaceId, agentId, accountId: null, mode: "compare", revisionIds: [ids[0], ids[1]], testValues: [{ contextVariableId: "40000000-0000-4000-8000-000000000001", value: "gold" }], expectedDraftGeneration: 1 });
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

    const execution = await service.start({ workspaceId, agentId, accountId: "account-1", mode: "compare", revisionIds: [ids[0], ids[1]], testValues: [] });

    expect(bootstrap).toHaveBeenCalledTimes(2);
    expect(bootstrap).toHaveBeenNthCalledWith(1, expect.objectContaining({ candidateRevision: expect.objectContaining({ id: ids[0] }) }));
    expect(execution.sides.map((side) => side.history)).toEqual([
      [expect.objectContaining({ role: "assistant", content: `Ciao from ${ids[0]}` })],
      [expect.objectContaining({ role: "assistant", content: `Ciao from ${ids[1]}` })],
    ]);
  });

  it("keeps lazy first send when no runner bootstrap is configured", async () => {
    const { service } = setup();
    const execution = await service.start({ workspaceId, agentId, accountId: null, mode: "single", revisionIds: [ids[0]], testValues: [] });

    expect(execution.sides[0]?.history).toEqual([]);
  });

  it("rejects duplicate, disabled, and incompatible supplied samples instead of omitting them", async () => {
    const { service } = setup();
    await expect(service.start({ workspaceId, agentId, accountId: null, mode: "single", revisionIds: [ids[0]], testValues: [{ contextVariableId: "40000000-0000-4000-8000-000000000001", value: "a" }, { contextVariableId: "40000000-0000-4000-8000-000000000001", value: "b" }] })).rejects.toMatchObject({ code: "bad_request" });
    await expect(service.start({ workspaceId, agentId, accountId: null, mode: "single", revisionIds: [ids[0]], testValues: [{ contextVariableId: "40000000-0000-4000-8000-000000000001", value: 3 }] })).rejects.toMatchObject({ code: "bad_request" });
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
    await expect(service.start({ workspaceId, agentId, accountId: null, mode: "single", revisionIds: [ids[0]], testValues: [] })).rejects.toMatchObject({ code: "bad_request" });

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
    const { service, repository } = setup(runner as never);
    const execution = await service.start({ workspaceId, agentId, accountId: null, mode: "single", revisionIds: [ids[0]], testValues: [] });
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
    const { service, repository } = setup(runner as never);
    const comparison = await service.start({ workspaceId, agentId, accountId: null, mode: "compare", revisionIds: [ids[0], ids[1]], testValues: [] });
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
    const { service, repository } = setup(runner as never);
    const execution = await service.start({ workspaceId, agentId, accountId: null, mode: "compare", revisionIds: [ids[0], ids[1]], testValues: [] });
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
    const execution = await service.start({ workspaceId, agentId, accountId: null, mode: "single", revisionIds: [ids[0]], testValues: [] });
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
    const execution = await service.start({ workspaceId, agentId, accountId: "account-1", mode: "compare", revisionIds: [ids[0], ids[1]], testValues: [] });

    await service.message({ workspaceId, agentId, accountId: "account-1", executionId: execution.id, message: "first", generation: 1, turnId: ids[6], attemptId: ids[7] });

    expect(runner).toHaveBeenCalledTimes(2);
    expect(reserveAnswer).toHaveBeenCalledTimes(2);
    expect(reserveAnswer).toHaveBeenNthCalledWith(1, { accountId: "account-1", workspaceId, surface: "test_execution" });
    expect(reserveAnswer).toHaveBeenNthCalledWith(2, { accountId: "account-1", workspaceId, surface: "test_execution" });
    expect(commit).toHaveBeenCalledTimes(2);
  });

  it("refuses a quota-exhausted side before dispatching its runner and preserves the quota error code", async () => {
    const runner = vi.fn(async (): Promise<TestExecutionRunnerResult> => ({ answer: "answer", messageId: ids[6], continuation: null }));
    const reserveAnswer = vi.fn(async () => { throw Object.assign(new Error("Usage limit exceeded"), { code: "usage_limit_exceeded", statusCode: 429 }); });
    const { service } = setup(runner, { reserveAnswer });
    const execution = await service.start({ workspaceId, agentId, accountId: "account-1", mode: "single", revisionIds: [ids[0]], testValues: [] });

    const events = await service.message({ workspaceId, agentId, accountId: "account-1", executionId: execution.id, message: "first", generation: 1, turnId: ids[6], attemptId: ids[7] });

    expect(runner).not.toHaveBeenCalled();
    expect(events).toEqual(expect.arrayContaining([expect.objectContaining({ type: "side_failed", code: "usage_limit_exceeded", retryable: true })]));
  });

  it("commits a reservation when a dispatched provider attempt fails", async () => {
    const commit = vi.fn(async () => undefined);
    const reserveAnswer = vi.fn(async () => ({ commit, release: vi.fn(async () => undefined) }));
    const runner = vi.fn(async (): Promise<TestExecutionRunnerResult> => { throw new Error("provider unavailable"); });
    const { service } = setup(runner, { reserveAnswer });
    const execution = await service.start({ workspaceId, agentId, accountId: "account-1", mode: "single", revisionIds: [ids[0]], testValues: [] });

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
    const execution = await service.start({ workspaceId, agentId, accountId: null, mode: "compare", revisionIds: [ids[0], ids[1]], testValues: [] });
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
    const execution = await service.start({ workspaceId, agentId, accountId: null, mode: "single", revisionIds: [ids[0]], testValues: [] });
    const events = await service.message({ workspaceId, agentId, accountId: null, executionId: execution.id, message: "first", generation: 1, turnId: ids[6], attemptId: ids[7] });
    expect(events).toEqual(expect.arrayContaining([expect.objectContaining({ type: "side_failed", code: "persistence_failed", retryable: false })]));
  });
});
