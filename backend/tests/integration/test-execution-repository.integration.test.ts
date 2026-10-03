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
    await repository.create({ id: executionId, workspaceId, agentId, mode: "single", generation: 1, testValues: [], skillEffects: "suppressed", idempotencyKey: executionId, sides: [{ id: sideId, executionId, revision: frozenRevision(), conversationId, state: "ready", retryable: false, history: [], continuation: null }] });
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
    await repository.create({ id: executionId, workspaceId, agentId, mode: "single", generation: 1, testValues: [{ name: "tier", value: "gold" } as never], skillEffects: "suppressed", idempotencyKey: executionId, sides: [{ id: sideId, executionId, revision: frozenRevision(), conversationId: randomUUID(), state: "ready", retryable: false, history: [], continuation: null }] });
    const claim = await repository.claimTurn({ workspaceId, agentId, executionId, sideIds: [sideId], generation: 1, turnId, attemptId, message: "history input", inputFingerprint: "history input", now: new Date(1_000), leaseMs: 1_000, retry: false });
    if (typeof claim === "string") throw new Error(claim);
    await repository.fail({ workspaceId, agentId, executionId, sideId, turnId, attemptId, fence: claim.claims[0].attempt.fence, code: "provider_timeout", now: new Date(2_000) });

    await expect(repository.list({ workspaceId, agentId, limit: 50 })).resolves.toMatchObject({ executions: expect.arrayContaining([expect.objectContaining({ id: executionId, mode: "single", state: "partial", skillEffects: "suppressed", sides: [expect.objectContaining({ id: sideId, state: "failed" })] })]) });
    const firstPage = await repository.list({ workspaceId, agentId, limit: 1 });
    expect(firstPage).toMatchObject({ executions: [expect.objectContaining({ id: expect.any(String) })], hasMore: true, nextCursor: expect.any(String) });
    const secondPage = await repository.list({ workspaceId, agentId, limit: 1, cursor: firstPage.nextCursor! });
    expect(secondPage.executions[0]?.id).not.toBe(firstPage.executions[0]?.id);
    await expect(repository.find({ workspaceId, agentId, executionId })).resolves.toMatchObject({ skillEffects: "suppressed", testValues: [{ name: "tier", value: "gold" }], sides: [expect.objectContaining({ history: [expect.objectContaining({ content: "history input", turnId })] })] });
    await expect(repository.listAttempts({ workspaceId, agentId, executionId })).resolves.toEqual([expect.objectContaining({ sideId, turnId, attemptId, fence: claim.claims[0].attempt.fence, state: "failed", failureCode: "provider_timeout" })]);
    await expect(repository.list({ workspaceId: randomUUID(), agentId, limit: 50 })).resolves.toMatchObject({ executions: [] });
    await expect(repository.listAttempts({ workspaceId: randomUUID(), agentId, executionId })).resolves.toEqual([]);
  });

  it("resolves an execution's agent id by workspace alone, and reads a cross-workspace id as absent", async () => {
    const executionId = randomUUID();
    await repository.create({ id: executionId, workspaceId, agentId, mode: "single", generation: 1, testValues: [], skillEffects: "suppressed", idempotencyKey: executionId, sides: [{ id: randomUUID(), executionId, revision: frozenRevision(), conversationId: randomUUID(), state: "ready", retryable: false, history: [], continuation: null }] });

    await expect(repository.findAgentId({ workspaceId, executionId })).resolves.toBe(agentId);
    await expect(repository.findAgentId({ workspaceId: randomUUID(), executionId })).resolves.toBeNull();
    await expect(repository.findAgentId({ workspaceId, executionId: randomUUID() })).resolves.toBeNull();
  });

  it("resolves the owning agent for a Test Chat call scoped only by testExecutionId, verifies a supplied one, and rejects a mismatch or a cross-workspace id", async () => {
    const service = new TestExecutionService({
      revisions: repository,
      contextCatalog: new ContextVariableRepository(database.kysely),
      repository,
      runner: { run: async () => ({ answer: "answer", messageId: randomUUID(), continuation: null }) },
      usageLimitPolicy: new NoopUsageLimitPolicy(),
      createId: randomUUID,
    });
    const execution = await service.start({ workspaceId, agentId, accountId: null, mode: "single", revisionIds: [revisionId], testValues: [], skillEffects: "suppressed", idempotencyKey: randomUUID() });

    // No agentId at all -- an operator MCP client continuing a session by id alone -- resolves it
    // from the execution itself.
    await expect(service.transcript({ workspaceId, executionId: execution.id })).resolves.toMatchObject({ id: execution.id });
    // The caller's own agentId, when it matches, is used as-is: no extra resolution read.
    await expect(service.transcript({ workspaceId, agentId, executionId: execution.id })).resolves.toMatchObject({ id: execution.id });
    // A mismatched explicit agentId is rejected exactly like any other wrong id.
    await expect(service.transcript({ workspaceId, agentId: randomUUID(), executionId: execution.id })).rejects.toMatchObject({ statusCode: 404 });
    // A testExecutionId this workspace does not own resolves to nothing.
    await expect(service.transcript({ workspaceId: randomUUID(), executionId: execution.id })).rejects.toMatchObject({ statusCode: 404 });
  });

  it("rejects send with another agent's id against this execution as not found, and creates no turn or attempt row", async () => {
    const otherAgentId = randomUUID();
    await database.query("INSERT INTO agents (id,workspace_id,name) VALUES ($1,$2,$3)", [otherAgentId, workspaceId, "other-agent"]);
    const service = new TestExecutionService({
      revisions: repository,
      contextCatalog: new ContextVariableRepository(database.kysely),
      repository,
      runner: { run: async () => ({ answer: "answer", messageId: randomUUID(), continuation: null }) },
      usageLimitPolicy: new NoopUsageLimitPolicy(),
      createId: randomUUID,
    });
    const execution = await service.start({ workspaceId, agentId, accountId: null, mode: "single", revisionIds: [revisionId], testValues: [], skillEffects: "suppressed", idempotencyKey: randomUUID() });
    const turnId = randomUUID();

    // A real agent's own id, but not the one this execution belongs to: rejected exactly like a
    // testExecutionId this workspace does not own, before any claim is attempted.
    await expect(service.send({ workspaceId, agentId: otherAgentId, accountId: null, executionId: execution.id, message: "hello", generation: execution.generation, turnId, attemptId: randomUUID() }))
      .rejects.toMatchObject({ statusCode: 404 });

    expect(await database.query("SELECT 1 FROM agent_test_execution_turns WHERE execution_id = $1 AND turn_id = $2", [execution.id, turnId])).toEqual([]);
    expect(await database.query("SELECT 1 FROM agent_test_execution_attempts WHERE execution_id = $1 AND turn_id = $2", [execution.id, turnId])).toEqual([]);
  });

  it("summarizes each listed execution from its sent turns and what its seed copied in, never from its transcript", async () => {
    const executionId = randomUUID(), seededId = randomUUID(), longId = randomUUID();
    const entry = (role: "user" | "assistant", content: string, at: number) => ({ turnId: randomUUID(), attemptId: randomUUID(), role, content, createdAt: new Date(at) });
    const side = (id: string, history: ReturnType<typeof entry>[], revision = frozenRevision()) => ({ id: randomUUID(), executionId: id, revision, conversationId: randomUUID(), state: "ready" as const, retryable: false, continuation: null, history });
    const sentTurn = (id: string, message: string, at: string) =>
      database.query("INSERT INTO agent_test_execution_turns (execution_id, turn_id, message, input_fingerprint, state, created_at) VALUES ($1, $2, $3, 'fingerprint', 'completed', $4)", [id, randomUUID(), message, at]);
    // A comparison: two sent turns answered on both sides, after a greeting.
    await repository.create({ id: executionId, workspaceId, agentId, mode: "compare", generation: 1, testValues: [], skillEffects: "suppressed", idempotencyKey: executionId, sides: [
      side(executionId, [entry("assistant", "Hi!", 1), entry("user", "first question", 2), entry("assistant", "answer", 3), entry("user", "second question", 4)]),
      side(executionId, [entry("assistant", "Hi!", 1), entry("user", "first question", 2)], frozenRevision(secondRevisionId)),
    ] });
    await sentTurn(executionId, "second question", "2026-09-08T10:02:00.000Z");
    await sentTurn(executionId, "first question", "2026-09-08T10:01:00.000Z");
    // A whitespace-only message counts as sent but never labels the test.
    await sentTurn(executionId, "   ", "2026-09-08T10:00:00.000Z");
    // A copy of a real conversation: what it copied in is recorded at start, and the operator then sends one message.
    await repository.create({ id: seededId, workspaceId, agentId, mode: "single", generation: 1, testValues: [], skillEffects: "suppressed", idempotencyKey: seededId, seededSummary: { turnCount: 2, firstMessage: "a customer's question" }, sides: [
      side(seededId, [entry("user", "a customer's question", 1), entry("assistant", "a reply", 2), entry("user", "a follow-up", 3)]),
    ] });
    await sentTurn(seededId, "the operator's question", "2026-09-08T10:04:00.000Z");
    // A long opening message is read only far enough to label the row and show that it was clipped.
    await repository.create({ id: longId, workspaceId, agentId, mode: "single", generation: 1, testValues: [], skillEffects: "suppressed", idempotencyKey: longId, sides: [side(longId, [])] });
    await sentTurn(longId, "y".repeat(20_000), "2026-09-08T10:03:00.000Z");

    const emptyId = randomUUID();
    await repository.create({ id: emptyId, workspaceId, agentId, mode: "single", generation: 1, testValues: [], skillEffects: "suppressed", idempotencyKey: emptyId, sides: [side(emptyId, [entry("assistant", "Hi!", 1)])] });

    const summaries = await repository.summarizeTurns({ workspaceId, agentId, executionIds: [executionId, seededId, longId, emptyId], firstMessageChars: 201 });

    expect(summaries.get(executionId)).toEqual({ turnCount: 3, firstMessage: "first question" });
    expect(summaries.get(seededId)).toEqual({ turnCount: 3, firstMessage: "a customer's question" });
    expect(summaries.get(longId)).toEqual({ turnCount: 1, firstMessage: "y".repeat(201) });
    expect(summaries.get(emptyId)).toEqual({ turnCount: 0, firstMessage: null });
    await expect(repository.summarizeTurns({ workspaceId: randomUUID(), agentId, executionIds: [executionId], firstMessageChars: 201 })).resolves.toEqual(new Map());

    // The seeded count on `find` is the same column `summarizeTurns` reads, so the two never disagree.
    await expect(repository.find({ workspaceId, agentId, executionId: seededId })).resolves.toMatchObject({ seededTurnCount: 2 });
    await expect(repository.find({ workspaceId, agentId, executionId })).resolves.toMatchObject({ seededTurnCount: 0 });
  });

  it("claims all comparison sides atomically and serializes simultaneous completions", async () => {
    const executionId = randomUUID(), leftId = randomUUID(), rightId = randomUUID(), turnId = randomUUID(), attemptId = randomUUID();
    await repository.create({ id: executionId, workspaceId, agentId, mode: "compare", generation: 1, testValues: [], skillEffects: "suppressed", idempotencyKey: executionId, sides: [
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
    await repository.create({ id: executionId, workspaceId, agentId, mode: "compare", generation: 1, testValues: [{ name: "tier", value: "gold" } as never], skillEffects: "allowed", idempotencyKey: executionId, sides: [
      { id: leftId, executionId, revision: frozenRevision(), conversationId: leftConversationId, state: "completed", retryable: false, history, continuation: { routine: "next" } },
      { id: rightId, executionId, revision: frozenRevision(secondRevisionId), conversationId: randomUUID(), state: "ready", retryable: false, history: [], continuation: null },
    ] });

    const retained = await repository.retainSide({ workspaceId, agentId, executionId, sideId: leftId, retainedExecutionId: randomUUID(), retainedSideId: randomUUID(), retainedConversationId: randomUUID() });
    // The retained execution keeps the frozen skill-effect policy of the comparison it forked from.
    expect(retained).toMatchObject({ mode: "single", skillEffects: "allowed", testValues: [{ name: "tier", value: "gold" }], sides: [{ revision: { id: revisionId }, history, continuation: { routine: "next" } }] });
    expect(typeof retained === "string" ? undefined : retained.sides[0]?.conversationId).not.toBe(leftConversationId);
    await expect(repository.find({ workspaceId, agentId, executionId })).resolves.toMatchObject({ mode: "compare", sides: [{ id: leftId, history }, { id: rightId }] });

    const activeExecutionId = randomUUID(), activeLeftId = randomUUID(), activeRightId = randomUUID(), turnId = randomUUID(), attemptId = randomUUID();
    await repository.create({ id: activeExecutionId, workspaceId, agentId, mode: "compare", generation: 1, testValues: [], skillEffects: "suppressed", idempotencyKey: activeExecutionId, sides: [
      { id: activeLeftId, executionId: activeExecutionId, revision: frozenRevision(), conversationId: randomUUID(), state: "ready", retryable: false, history: [], continuation: null },
      { id: activeRightId, executionId: activeExecutionId, revision: frozenRevision(secondRevisionId), conversationId: randomUUID(), state: "ready", retryable: false, history: [], continuation: null },
    ] });
    await repository.claimTurn({ workspaceId, agentId, executionId: activeExecutionId, sideIds: [activeLeftId, activeRightId], generation: 1, turnId, attemptId, message: "still running", inputFingerprint: "still running", now: new Date(2_000), leaseMs: 30_000, retry: false });
    await expect(repository.retainSide({ workspaceId, agentId, executionId: activeExecutionId, sideId: activeLeftId, retainedExecutionId: randomUUID(), retainedSideId: randomUUID(), retainedConversationId: randomUUID() })).resolves.toBe("unsettled");
  });

  it("rejects a live different attempt and supersedes an expired lease with a monotonic fence", async () => {
    const executionId = randomUUID(), sideId = randomUUID(), turnId = randomUUID(), firstAttempt = randomUUID(), recoveryAttempt = randomUUID();
    await repository.create({ id: executionId, workspaceId, agentId, mode: "single", generation: 1, testValues: [], skillEffects: "suppressed", idempotencyKey: executionId, sides: [{ id: sideId, executionId, revision: frozenRevision(), conversationId: randomUUID(), state: "ready", retryable: false, history: [], continuation: null }] });
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
    await repository.create({ id: executionId, workspaceId, agentId, mode: "compare", generation: 1, testValues: [], skillEffects: "suppressed", idempotencyKey: executionId, sides: [
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
    await repository.create({ id: executionId, workspaceId, agentId, mode: "compare", generation: 1, testValues: [], skillEffects: "suppressed", idempotencyKey: executionId, sides: [
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
    const execution = await service.start({ workspaceId, agentId, accountId: null, mode: "single", revisionIds: [revisionId], testValues: [], skillEffects: "suppressed", idempotencyKey: randomUUID() });
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
    const execution = await service.start({ workspaceId, agentId, accountId: null, mode: "single", revisionIds: [revisionId], testValues: [], skillEffects: "suppressed", idempotencyKey: randomUUID() });
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

  // #1362: a turn that failed used to leave the execution partial, and every later message
  // was refused as a turn conflict — a session whose failure repeats on retry was dead.
  it("answers the next message after a failed turn instead of locking the session", async () => {
    let runnerCalls = 0;
    const service = new TestExecutionService({
      revisions: repository,
      contextCatalog: new ContextVariableRepository(database.kysely),
      repository,
      runner: {
        run: async () => {
          runnerCalls += 1;
          if (runnerCalls === 1) throw new Error("runner failed");
          return { answer: "second answer", messageId: randomUUID(), continuation: null };
        },
      },
      usageLimitPolicy: new NoopUsageLimitPolicy(),
      createId: randomUUID,
    });
    const execution = await service.start({ workspaceId, agentId, accountId: null, mode: "single", revisionIds: [revisionId], testValues: [], skillEffects: "suppressed", idempotencyKey: randomUUID() });
    const failedTurnId = randomUUID();

    const failed = await service.message({ workspaceId, agentId, accountId: null, executionId: execution.id, message: "How do I contact a human?", generation: execution.generation, turnId: failedTurnId, attemptId: randomUUID() });
    const next = await service.message({ workspaceId, agentId, accountId: null, executionId: execution.id, message: "guest@example.com", generation: execution.generation, turnId: randomUUID(), attemptId: randomUUID() });

    expect(failed).toEqual(expect.arrayContaining([expect.objectContaining({ type: "side_failed", code: "runner_failed" })]));
    expect(next).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: "message_delta", delta: "second answer" }),
      expect.objectContaining({ type: "execution_completed" }),
    ]));
    // The failed turn is superseded: retrying it after a later turn would answer out of order.
    await expect(service.retry({ workspaceId, agentId, accountId: null, executionId: execution.id, sideId: execution.sides[0].id, generation: execution.generation, turnId: failedTurnId, attemptId: randomUUID() }))
      .rejects.toMatchObject({ statusCode: 409 });
    expect(runnerCalls).toBe(2);
  });

  // #1362 review: a comparison side whose failed turn a later message superseded is settled, so
  // it can be retained. The retained execution must keep that failure, not just the history.
  it("retains a comparison side with its attempts, so a superseded failed turn still reads as failed", async () => {
    const executionId = randomUUID(), leftId = randomUUID(), rightId = randomUUID(), failedTurn = randomUUID(), nextTurn = randomUUID();
    const failedAttempt = randomUUID(), nextAttempt = randomUUID();
    await repository.create({ id: executionId, workspaceId, agentId, mode: "compare", generation: 1, testValues: [], skillEffects: "suppressed", idempotencyKey: executionId, sides: [
      { id: leftId, executionId, revision: frozenRevision(), conversationId: randomUUID(), state: "ready", retryable: false, history: [], continuation: null },
      { id: rightId, executionId, revision: frozenRevision(secondRevisionId), conversationId: randomUUID(), state: "ready", retryable: false, history: [], continuation: null },
    ] });
    const claim = async (turnId: string, attemptId: string, message: string) => {
      const claimed = await repository.claimTurn({ workspaceId, agentId, executionId, sideIds: [leftId, rightId], generation: 1, turnId, attemptId, message, inputFingerprint: message, now: new Date(1_000), leaseMs: 30_000, retry: false });
      if (typeof claimed === "string") throw new Error(claimed);
      return (sideId: string) => claimed.claims.find((item) => item.sideId === sideId)!.attempt.fence;
    };
    const fenceOf = await claim(failedTurn, failedAttempt, "How do I contact a human?");
    await repository.fail({ workspaceId, agentId, executionId, sideId: leftId, turnId: failedTurn, attemptId: failedAttempt, fence: fenceOf(leftId), code: "runner_failed", now: new Date(1_100) });
    await repository.complete({ workspaceId, agentId, executionId, sideId: rightId, turnId: failedTurn, attemptId: failedAttempt, fence: fenceOf(rightId), result: { answer: "right first", messageId: randomUUID(), continuation: null }, now: new Date(1_100) });
    const nextFenceOf = await claim(nextTurn, nextAttempt, "guest@example.com");
    for (const sideId of [leftId, rightId]) {
      await repository.complete({ workspaceId, agentId, executionId, sideId, turnId: nextTurn, attemptId: nextAttempt, fence: nextFenceOf(sideId), result: { answer: `${sideId} next`, messageId: randomUUID(), continuation: null }, now: new Date(1_200) });
    }

    const retained = await repository.retainSide({ workspaceId, agentId, executionId, sideId: leftId, retainedExecutionId: randomUUID(), retainedSideId: randomUUID(), retainedConversationId: randomUUID() });
    if (typeof retained === "string") throw new Error(retained);
    const retainedSideId = retained.sides[0].id;

    await expect(repository.listAttempts({ workspaceId, agentId, executionId: retained.id })).resolves.toEqual([
      expect.objectContaining({ sideId: retainedSideId, turnId: failedTurn, attemptId: failedAttempt, state: "failed", failureCode: "runner_failed" }),
      expect.objectContaining({ sideId: retainedSideId, turnId: nextTurn, attemptId: nextAttempt, state: "completed" }),
    ]);
    const service = new TestExecutionService({ revisions: repository, contextCatalog: new ContextVariableRepository(database.kysely), repository, runner: { run: async () => ({ answer: "retained answer", messageId: randomUUID(), continuation: null }) }, usageLimitPolicy: new NoopUsageLimitPolicy(), createId: randomUUID });
    const transcript = await service.transcript({ workspaceId, agentId, executionId: retained.id });
    expect(transcript.sides[0]?.turns).toEqual([
      expect.objectContaining({ turnId: failedTurn, state: "failed", failureCode: "runner_failed", answer: null }),
      expect.objectContaining({ turnId: nextTurn, state: "completed" }),
    ]);
    // The source comparison keeps its own evidence, and the retained thread takes the next message.
    await expect(repository.listAttempts({ workspaceId, agentId, executionId })).resolves.toHaveLength(4);
    const next = await service.message({ workspaceId, agentId, accountId: null, executionId: retained.id, message: "Please call me back.", generation: retained.generation, turnId: randomUUID(), attemptId: randomUUID() });
    expect(next).toEqual(expect.arrayContaining([expect.objectContaining({ type: "execution_completed" })]));
  });

  it("refuses a new turn only while one is running, and retries only the latest failed turn", async () => {
    const executionId = randomUUID(), sideId = randomUUID(), firstTurn = randomUUID(), secondTurn = randomUUID();
    await repository.create({ id: executionId, workspaceId, agentId, mode: "single", generation: 1, testValues: [], skillEffects: "suppressed", idempotencyKey: executionId, sides: [{ id: sideId, executionId, revision: frozenRevision(), conversationId: randomUUID(), state: "ready", retryable: false, history: [], continuation: null }] });
    const claim = (turnId: string, message: string, retry = false, attemptId = randomUUID()) =>
      repository.claimTurn({ workspaceId, agentId, executionId, sideIds: [sideId], generation: 1, turnId, attemptId, message, inputFingerprint: message, now: new Date(1_000), leaseMs: 30_000, retry });
    const failClaim = async (turnId: string, claimed: Awaited<ReturnType<typeof claim>>) => {
      if (typeof claimed === "string") throw new Error(claimed);
      await repository.fail({ workspaceId, agentId, executionId, sideId, turnId, attemptId: claimed.claims[0].attempt.attemptId, fence: claimed.claims[0].attempt.fence, code: "runner_failed", now: new Date(1_100) });
    };

    await failClaim(firstTurn, await claim(firstTurn, "first"));
    const second = await claim(secondTurn, "second");
    expect(typeof second).not.toBe("string");
    await expect(claim(randomUUID(), "third")).resolves.toBe("turn_in_progress");
    await failClaim(secondTurn, second);

    await expect(claim(firstTurn, "first", true)).resolves.toBe("retry_invalid");
    const retried = await claim(secondTurn, "second", true);
    expect(typeof retried === "string" ? retried : retried.claims[0]?.attempt.turnId).toBe(secondTurn);
  });
});
