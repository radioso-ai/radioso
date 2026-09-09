import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { TestExecutionRepository } from "../../src/db/repositories/testExecutionRepository.js";
import type { AgentRevision } from "../../src/modules/agents/agentRevision.js";
import { TestExecutionService } from "../../src/modules/test-execution/testExecution.js";
import { ContextVariableRepository } from "../../src/db/repositories/contextVariableRepository.js";
import { Database } from "../../src/shared/infra/database.js";
import { NoopUsageLimitPolicy } from "../../src/shared/domain/usageLimitPolicy.js";
import { runAllTestMigrations } from "../support/databaseMigrations.js";

const url = process.env.INTEGRATION_DATABASE_URL;
const describeDb = url ? describe : describe.skip;

describeDb("test execution repository", () => {
  const accountId = randomUUID(), workspaceId = randomUUID(), agentId = randomUUID(), revisionId = randomUUID(), secondRevisionId = randomUUID();
  let database: Database;
  let repository: TestExecutionRepository;
  const snapshot = { customInstruction: null, directives: [], routines: [], contextVariableEnablements: [] };
  const frozenRevision = (id = revisionId): AgentRevision => ({ id, snapshot, sourceDraftGeneration: 1, sourceBasePublishedRevisionId: null, createdAt: new Date(0), publishedAt: null, publishedVersion: null });

  beforeAll(async () => {
    database = new Database(url!); await runAllTestMigrations(database); repository = new TestExecutionRepository(database.kysely);
    await database.query("INSERT INTO accounts (id,name,email,password_hash) VALUES ($1,$2,$3,$4)", [accountId, "test", `test-execution-${accountId}@example.com`, "hash"]);
    await database.query("INSERT INTO workspaces (id,account_id,name,public_route_key) VALUES ($1,$2,$3,$4)", [workspaceId, accountId, "test", `test-execution-${workspaceId}`]);
    await database.query("INSERT INTO agents (id,workspace_id,name) VALUES ($1,$2,$3)", [agentId, workspaceId, "test"]);
    await database.query("INSERT INTO agent_drafts (agent_id,workspace_id,generation,snapshot) VALUES ($1,$2,1,$3::jsonb)", [agentId, workspaceId, JSON.stringify(snapshot)]);
    await database.query("INSERT INTO agent_revisions (id,agent_id,workspace_id,snapshot,source_draft_generation) VALUES ($1,$2,$3,$4::jsonb,1)", [revisionId, agentId, workspaceId, JSON.stringify(snapshot)]);
    await database.query("INSERT INTO agent_revisions (id,agent_id,workspace_id,snapshot,source_draft_generation) VALUES ($1,$2,$3,$4::jsonb,1)", [secondRevisionId, agentId, workspaceId, JSON.stringify(snapshot)]);
  });
  afterAll(async () => { await database.query("DELETE FROM accounts WHERE id=$1", [accountId]).catch(() => undefined); await database.close(); });

  it("persists immutable sides, fences late completion, and replays a completed request identity", async () => {
    const executionId = randomUUID(), sideId = randomUUID(), conversationId = randomUUID(), turnId = randomUUID(), attemptId = randomUUID();
    await repository.create({ id: executionId, workspaceId, agentId, mode: "single", generation: 1, testValues: [], sides: [{ id: sideId, executionId, revision: frozenRevision(), conversationId, state: "ready", retryable: false, history: [], continuation: null }] });
    const claimed = await repository.claimTurn({ workspaceId, agentId, executionId, sideIds: [sideId], generation: 1, turnId, attemptId, message: "hello", inputFingerprint: "hello", now: new Date(1000), leaseMs: 30_000, retry: false });
    if (typeof claimed === "string") throw new Error(`claim failed: ${claimed}`);
    const completed = await repository.complete({ workspaceId, agentId, executionId, sideId, turnId, attemptId, fence: claimed.claims[0].attempt.fence, result: { answer: "answer", messageId: randomUUID(), continuation: { version: 1 } }, now: new Date(2000) });
    expect(completed).toMatchObject({ state: "completed", sides: [{ state: "completed" }] });
    await expect(repository.complete({ workspaceId, agentId, executionId, sideId, turnId, attemptId, fence: claimed.claims[0].attempt.fence, result: { answer: "late", messageId: randomUUID(), continuation: null }, now: new Date(3000) })).resolves.toBe("stale");
    const replay = await repository.claimTurn({ workspaceId, agentId, executionId, sideIds: [sideId], generation: 1, turnId, attemptId, message: "hello", inputFingerprint: "hello", now: new Date(4000), leaseMs: 30_000, retry: false });
    expect(typeof replay === "string" ? replay : replay.claims[0]?.replay).toMatchObject({ answer: "answer", continuation: { version: 1 } });
  });

  it("lists private execution evidence only inside its workspace and retains turn attempt metadata", async () => {
    const executionId = randomUUID(), sideId = randomUUID(), turnId = randomUUID(), attemptId = randomUUID();
    await repository.create({ id: executionId, workspaceId, agentId, mode: "single", generation: 1, testValues: [{ name: "tier", value: "gold" } as never], sides: [{ id: sideId, executionId, revision: frozenRevision(), conversationId: randomUUID(), state: "ready", retryable: false, history: [], continuation: null }] });
    const claim = await repository.claimTurn({ workspaceId, agentId, executionId, sideIds: [sideId], generation: 1, turnId, attemptId, message: "history input", inputFingerprint: "history input", now: new Date(1_000), leaseMs: 1_000, retry: false });
    if (typeof claim === "string") throw new Error(claim);
    await repository.fail({ workspaceId, agentId, executionId, sideId, turnId, attemptId, fence: claim.claims[0].attempt.fence, code: "provider_timeout", now: new Date(2_000) });

    await expect(repository.list({ workspaceId, agentId, limit: 50 })).resolves.toMatchObject({ executions: expect.arrayContaining([expect.objectContaining({ id: executionId, mode: "single", state: "partial", sides: [expect.objectContaining({ id: sideId, state: "failed" })] })]) });
    const firstPage = await repository.list({ workspaceId, agentId, limit: 1 });
    expect(firstPage).toMatchObject({ executions: [expect.objectContaining({ id: expect.any(String) })], hasMore: true, nextCursor: expect.any(String) });
    const secondPage = await repository.list({ workspaceId, agentId, limit: 1, cursor: firstPage.nextCursor! });
    expect(secondPage.executions[0]?.id).not.toBe(firstPage.executions[0]?.id);
    await expect(repository.find({ workspaceId, agentId, executionId })).resolves.toMatchObject({ testValues: [{ name: "tier", value: "gold" }], sides: [expect.objectContaining({ history: [expect.objectContaining({ content: "history input", turnId })] })] });
    await expect(repository.listAttempts({ workspaceId, agentId, executionId })).resolves.toEqual([expect.objectContaining({ sideId, turnId, attemptId, fence: claim.claims[0].attempt.fence, state: "failed", failureCode: "provider_timeout" })]);
    await expect(repository.list({ workspaceId: randomUUID(), agentId, limit: 50 })).resolves.toMatchObject({ executions: [] });
    await expect(repository.listAttempts({ workspaceId: randomUUID(), agentId, executionId })).resolves.toEqual([]);
  });

  it("claims all comparison sides atomically and serializes simultaneous completions", async () => {
    const executionId = randomUUID(), leftId = randomUUID(), rightId = randomUUID(), turnId = randomUUID(), attemptId = randomUUID();
    await repository.create({ id: executionId, workspaceId, agentId, mode: "compare", generation: 1, testValues: [], sides: [
      { id: leftId, executionId, revision: frozenRevision(), conversationId: randomUUID(), state: "ready", retryable: false, history: [], continuation: null },
      { id: rightId, executionId, revision: frozenRevision(secondRevisionId), conversationId: randomUUID(), state: "ready", retryable: false, history: [], continuation: null },
    ] });
    await expect(repository.claimTurn({ workspaceId, agentId, executionId, sideIds: [leftId, randomUUID()], generation: 1, turnId, attemptId, message: "hello", inputFingerprint: "hello", now: new Date(1000), leaseMs: 1000, retry: false })).resolves.toBe("turn_conflict");
    expect((await repository.find({ workspaceId, agentId, executionId }))?.sides.every((side) => side.state === "ready")).toBe(true);
    const claim = await repository.claimTurn({ workspaceId, agentId, executionId, sideIds: [leftId, rightId], generation: 1, turnId, attemptId, message: "hello", inputFingerprint: "hello", now: new Date(1000), leaseMs: 1000, retry: false });
    if (typeof claim === "string") throw new Error(claim);
    await Promise.all(claim.claims.map((item) => repository.complete({ workspaceId, agentId, executionId, sideId: item.sideId, turnId, attemptId, fence: item.attempt.fence, result: { answer: item.sideId, messageId: randomUUID(), continuation: null }, now: new Date(2000) })));
    expect(await repository.find({ workspaceId, agentId, executionId })).toMatchObject({ state: "completed", sides: [{ state: "completed" }, { state: "completed" }] });
  });

  it("atomically forks one settled comparison side while refusing a side with an active fenced attempt", async () => {
    const executionId = randomUUID(), leftId = randomUUID(), rightId = randomUUID(), leftConversationId = randomUUID();
    const history = [{ turnId: randomUUID(), attemptId: randomUUID(), role: "assistant" as const, content: "settled answer", messageId: randomUUID(), createdAt: new Date(1_000) }];
    await repository.create({ id: executionId, workspaceId, agentId, mode: "compare", generation: 1, testValues: [{ name: "tier", value: "gold" } as never], sides: [
      { id: leftId, executionId, revision: frozenRevision(), conversationId: leftConversationId, state: "completed", retryable: false, history, continuation: { routine: "next" } },
      { id: rightId, executionId, revision: frozenRevision(secondRevisionId), conversationId: randomUUID(), state: "ready", retryable: false, history: [], continuation: null },
    ] });

    const retained = await repository.retainSide({ workspaceId, agentId, executionId, sideId: leftId, retainedExecutionId: randomUUID(), retainedSideId: randomUUID(), retainedConversationId: randomUUID() });
    expect(retained).toMatchObject({ mode: "single", testValues: [{ name: "tier", value: "gold" }], sides: [{ revision: { id: revisionId }, history, continuation: { routine: "next" } }] });
    expect(typeof retained === "string" ? undefined : retained.sides[0]?.conversationId).not.toBe(leftConversationId);
    await expect(repository.find({ workspaceId, agentId, executionId })).resolves.toMatchObject({ mode: "compare", sides: [{ id: leftId, history }, { id: rightId }] });

    const activeExecutionId = randomUUID(), activeLeftId = randomUUID(), activeRightId = randomUUID(), turnId = randomUUID(), attemptId = randomUUID();
    await repository.create({ id: activeExecutionId, workspaceId, agentId, mode: "compare", generation: 1, testValues: [], sides: [
      { id: activeLeftId, executionId: activeExecutionId, revision: frozenRevision(), conversationId: randomUUID(), state: "ready", retryable: false, history: [], continuation: null },
      { id: activeRightId, executionId: activeExecutionId, revision: frozenRevision(secondRevisionId), conversationId: randomUUID(), state: "ready", retryable: false, history: [], continuation: null },
    ] });
    await repository.claimTurn({ workspaceId, agentId, executionId: activeExecutionId, sideIds: [activeLeftId, activeRightId], generation: 1, turnId, attemptId, message: "still running", inputFingerprint: "still running", now: new Date(2_000), leaseMs: 30_000, retry: false });
    await expect(repository.retainSide({ workspaceId, agentId, executionId: activeExecutionId, sideId: activeLeftId, retainedExecutionId: randomUUID(), retainedSideId: randomUUID(), retainedConversationId: randomUUID() })).resolves.toBe("unsettled");
  });

  it("rejects a live different attempt and supersedes an expired lease with a monotonic fence", async () => {
    const executionId = randomUUID(), sideId = randomUUID(), turnId = randomUUID(), firstAttempt = randomUUID(), recoveryAttempt = randomUUID();
    await repository.create({ id: executionId, workspaceId, agentId, mode: "single", generation: 1, testValues: [], sides: [{ id: sideId, executionId, revision: frozenRevision(), conversationId: randomUUID(), state: "ready", retryable: false, history: [], continuation: null }] });
    const first = await repository.claimTurn({ workspaceId, agentId, executionId, sideIds: [sideId], generation: 1, turnId, attemptId: firstAttempt, message: "hello", inputFingerprint: "hello", now: new Date(1000), leaseMs: 1000, retry: false });
    if (typeof first === "string") throw new Error(first);
    await expect(repository.claimTurn({ workspaceId, agentId, executionId, sideIds: [sideId], generation: 1, turnId, attemptId: randomUUID(), message: "hello", inputFingerprint: "hello", now: new Date(1500), leaseMs: 1000, retry: true })).resolves.toBe("turn_conflict");
    const recovered = await repository.claimTurn({ workspaceId, agentId, executionId, sideIds: [sideId], generation: 1, turnId, attemptId: recoveryAttempt, message: "hello", inputFingerprint: "hello", now: new Date(2500), leaseMs: 1000, retry: true });
    if (typeof recovered === "string") throw new Error(recovered);
    expect(recovered.claims[0].attempt.fence).toBeGreaterThan(first.claims[0].attempt.fence);
    await expect(repository.complete({ workspaceId, agentId, executionId, sideId, turnId, attemptId: firstAttempt, fence: first.claims[0].attempt.fence, result: { answer: "late", messageId: randomUUID(), continuation: null }, now: new Date(2600) })).resolves.toBe("stale");
    await expect(repository.complete({ workspaceId, agentId, executionId, sideId, turnId, attemptId: recoveryAttempt, fence: recovered.claims[0].attempt.fence, result: { answer: "fresh", messageId: randomUUID(), continuation: null }, now: new Date(2700) })).resolves.toMatchObject({ state: "completed" });
  });

  it("preserves input side order, keeps failed identities fenced, and re-delivers a completed side under a new retry identity", async () => {
    const executionId = randomUUID(), leftId = "ffffffff-ffff-4fff-8fff-ffffffffffff", rightId = "00000000-0000-4000-8000-000000000099";
    const turnId = randomUUID(), failedAttempt = randomUUID(), recoveredAttempt = randomUUID();
    await repository.create({ id: executionId, workspaceId, agentId, mode: "compare", generation: 1, testValues: [], sides: [
      { id: leftId, executionId, revision: frozenRevision(), conversationId: randomUUID(), state: "ready", retryable: false, history: [], continuation: null },
      { id: rightId, executionId, revision: frozenRevision(secondRevisionId), conversationId: randomUUID(), state: "ready", retryable: false, history: [], continuation: null },
    ] });
    expect((await repository.find({ workspaceId, agentId, executionId }))?.sides.map((side) => side.id)).toEqual([leftId, rightId]);

    const initial = await repository.claimTurn({ workspaceId, agentId, executionId, sideIds: [leftId, rightId], generation: 1, turnId, attemptId: failedAttempt, message: "hello", inputFingerprint: "hello", now: new Date(1000), leaseMs: 1_000, retry: false });
    if (typeof initial === "string") throw new Error(initial);
    await Promise.all(initial.claims.map((claim) => repository.fail({ workspaceId, agentId, executionId, sideId: claim.sideId, turnId, attemptId: failedAttempt, fence: claim.attempt.fence, code: "runner_failed", now: new Date(1100) })));
    await expect(repository.claimTurn({ workspaceId, agentId, executionId, sideIds: [leftId], generation: 1, turnId, attemptId: failedAttempt, message: "hello", inputFingerprint: "hello", now: new Date(1200), leaseMs: 1_000, retry: true })).resolves.toBe("attempt_conflict");

    const recovered = await repository.claimTurn({ workspaceId, agentId, executionId, sideIds: [leftId], generation: 1, turnId, attemptId: recoveredAttempt, message: "hello", inputFingerprint: "hello", now: new Date(1200), leaseMs: 1_000, retry: true });
    if (typeof recovered === "string") throw new Error(recovered);
    await repository.complete({ workspaceId, agentId, executionId, sideId: leftId, turnId, attemptId: recoveredAttempt, fence: recovered.claims[0].attempt.fence, result: { answer: "recovered", messageId: randomUUID(), continuation: null }, now: new Date(1300) });
    const replay = await repository.claimTurn({ workspaceId, agentId, executionId, sideIds: [leftId], generation: 1, turnId, attemptId: recoveredAttempt, message: "hello", inputFingerprint: "hello", now: new Date(1400), leaseMs: 1_000, retry: true });
    expect(typeof replay === "string" ? replay : replay.claims[0]?.replay?.answer).toBe("recovered");
    const lostResponseRetry = await repository.claimTurn({ workspaceId, agentId, executionId, sideIds: [leftId], generation: 1, turnId, attemptId: randomUUID(), message: "hello", inputFingerprint: "hello", now: new Date(1500), leaseMs: 1_000, retry: true });
    expect(typeof lostResponseRetry === "string" ? lostResponseRetry : lostResponseRetry.claims[0]?.replay?.answer).toBe("recovered");
    await expect(repository.claimTurn({ workspaceId, agentId, executionId, sideIds: [rightId], generation: 1, turnId, attemptId: failedAttempt, message: "hello", inputFingerprint: "hello", now: new Date(1500), leaseMs: 1_000, retry: true })).resolves.toBe("attempt_conflict");
    const rightRecoveryAttempt = randomUUID();
    const rightRecovery = await repository.claimTurn({ workspaceId, agentId, executionId, sideIds: [rightId], generation: 1, turnId, attemptId: rightRecoveryAttempt, message: "hello", inputFingerprint: "hello", now: new Date(1500), leaseMs: 1_000, retry: true });
    if (typeof rightRecovery === "string") throw new Error(rightRecovery);
    await repository.complete({ workspaceId, agentId, executionId, sideId: rightId, turnId, attemptId: rightRecoveryAttempt, fence: rightRecovery.claims[0].attempt.fence, result: { answer: "right recovered", messageId: randomUUID(), continuation: null }, now: new Date(1600) });
    const rightLostResponseRetry = await repository.claimTurn({ workspaceId, agentId, executionId, sideIds: [rightId], generation: 1, turnId, attemptId: randomUUID(), message: "hello", inputFingerprint: "hello", now: new Date(1700), leaseMs: 1_000, retry: true });
    expect(typeof rightLostResponseRetry === "string" ? rightLostResponseRetry : rightLostResponseRetry.claims[0]?.replay?.answer).toBe("right recovered");
  });

  it("keeps the aggregate and active turn running until independently finishing comparison sides settle", async () => {
    const executionId = randomUUID(), leftId = randomUUID(), rightId = randomUUID(), turnId = randomUUID(), attemptId = randomUUID();
    await repository.create({ id: executionId, workspaceId, agentId, mode: "compare", generation: 1, testValues: [], sides: [
      { id: leftId, executionId, revision: frozenRevision(), conversationId: randomUUID(), state: "ready", retryable: false, history: [], continuation: null },
      { id: rightId, executionId, revision: frozenRevision(secondRevisionId), conversationId: randomUUID(), state: "ready", retryable: false, history: [], continuation: null },
    ] });
    const claim = await repository.claimTurn({ workspaceId, agentId, executionId, sideIds: [leftId, rightId], generation: 1, turnId, attemptId, message: "hello", inputFingerprint: "hello", now: new Date(1000), leaseMs: 1_000, retry: false });
    if (typeof claim === "string") throw new Error(claim);
    await repository.fail({ workspaceId, agentId, executionId, sideId: leftId, turnId, attemptId, fence: claim.claims.find((item) => item.sideId === leftId)!.attempt.fence, code: "runner_failed", now: new Date(1100) });
    expect(await repository.find({ workspaceId, agentId, executionId })).toMatchObject({ state: "running" });
    expect((await database.query<{ state: string }>("SELECT state FROM agent_test_execution_turns WHERE execution_id = $1 AND turn_id = $2", [executionId, turnId]))[0]?.state).toBe("running");
    await repository.complete({ workspaceId, agentId, executionId, sideId: rightId, turnId, attemptId, fence: claim.claims.find((item) => item.sideId === rightId)!.attempt.fence, result: { answer: "right", messageId: randomUUID(), continuation: null }, now: new Date(1200) });
    expect(await repository.find({ workspaceId, agentId, executionId })).toMatchObject({ state: "partial" });
  });

  it("recovers an expired service lease, rejects reused retry identity, and delivery-replays the recovered response", async () => {
    let now = 1_000;
    let runnerCalls = 0;
    const runner = { run: async () => { runnerCalls += 1; return { answer: "recovered", messageId: randomUUID(), continuation: null }; } };
    const service = new TestExecutionService({
      revisions: repository,
      contextCatalog: new ContextVariableRepository(database.kysely),
      repository,
      runner,
      usageLimitPolicy: new NoopUsageLimitPolicy(),
      createId: randomUUID,
      now: () => new Date(now),
      leaseMs: 1_000,
    });
    const execution = await service.start({ workspaceId, agentId, accountId: null, mode: "single", revisionIds: [revisionId], testValues: [] });
    const turnId = randomUUID(), originalAttemptId = randomUUID(), recoveryAttemptId = randomUUID();
    const initial = await repository.claimTurn({ workspaceId, agentId, executionId: execution.id, sideIds: [execution.sides[0].id], generation: execution.generation, turnId, attemptId: originalAttemptId, message: "hello", inputFingerprint: JSON.stringify("hello"), now: new Date(now), leaseMs: 1_000, retry: false });
    if (typeof initial === "string") throw new Error(initial);
    now = 2_500;
    await expect(service.retry({ workspaceId, agentId, accountId: null, executionId: execution.id, sideId: execution.sides[0].id, generation: execution.generation, turnId, attemptId: originalAttemptId })).rejects.toMatchObject({ code: "conflict" });
    const recovered = await service.retry({ workspaceId, agentId, accountId: null, executionId: execution.id, sideId: execution.sides[0].id, generation: execution.generation, turnId, attemptId: recoveryAttemptId });
    expect(recovered.find((event) => event.type === "message_delta")).toMatchObject({ delta: "recovered" });
    const replay = await service.retry({ workspaceId, agentId, accountId: null, executionId: execution.id, sideId: execution.sides[0].id, generation: execution.generation, turnId, attemptId: recoveryAttemptId });
    expect(replay.find((event) => event.type === "message_delta")).toMatchObject({ delta: "recovered" });
    expect(runnerCalls).toBe(1);
  });

  it("re-delivers a completed server turn after a lost response with a new attempt identity", async () => {
    let runnerCalls = 0;
    const service = new TestExecutionService({
      revisions: repository,
      contextCatalog: new ContextVariableRepository(database.kysely),
      repository,
      runner: { run: async () => { runnerCalls += 1; return { answer: "cached answer", messageId: randomUUID(), continuation: null }; } },
      usageLimitPolicy: new NoopUsageLimitPolicy(),
      createId: randomUUID,
    });
    const execution = await service.start({ workspaceId, agentId, accountId: null, mode: "single", revisionIds: [revisionId], testValues: [] });
    const turnId = randomUUID(), initialAttemptId = randomUUID(), retryAttemptId = randomUUID();
    await service.message({ workspaceId, agentId, accountId: null, executionId: execution.id, message: "hello", generation: execution.generation, turnId, attemptId: initialAttemptId });
    const beforeRetry = await repository.find({ workspaceId, agentId, executionId: execution.id });
    const replay = await service.retry({ workspaceId, agentId, accountId: null, executionId: execution.id, sideId: execution.sides[0].id, generation: execution.generation, turnId, attemptId: retryAttemptId });
    const afterRetry = await repository.find({ workspaceId, agentId, executionId: execution.id });
    expect(replay.find((event) => event.type === "message_delta")).toMatchObject({ delta: "cached answer", attemptId: retryAttemptId });
    expect(runnerCalls).toBe(1);
    expect(afterRetry?.sides[0]?.history).toEqual(beforeRetry?.sides[0]?.history);
    expect(afterRetry?.state).toBe(beforeRetry?.state);
    await expect(service.message({ workspaceId, agentId, accountId: null, executionId: execution.id, message: "different input", generation: execution.generation, turnId, attemptId: randomUUID() })).rejects.toMatchObject({ code: "conflict" });
    await expect(service.retry({ workspaceId, agentId, accountId: null, executionId: execution.id, sideId: execution.sides[0].id, generation: execution.generation, turnId: randomUUID(), attemptId: randomUUID() })).rejects.toMatchObject({ code: "conflict" });
  });
});
