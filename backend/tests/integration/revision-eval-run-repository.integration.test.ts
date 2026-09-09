import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { RevisionEvalRunRepository } from "../../src/db/repositories/revisionEvalRunRepository.js";
import type { AgentRevision } from "../../src/modules/agents/agentRevision.js";
import type { InternalAgentConfig } from "../../src/modules/agents/agentConfig.js";
import type { EvalCase, EvalSnapshot } from "../../src/modules/eval/domain/types.js";
import { EvalRunService } from "../../src/modules/eval/services/evalRunService.js";
import { RevisionEvalRunService } from "../../src/modules/eval/services/revisionEvalRun.js";
import type { RevisionEvalRun } from "../../src/modules/eval/services/revisionEvalRun.js";
import { Database } from "../../src/shared/infra/database.js";
import { conversationQualityAgentConfig } from "../fixtures/conversation-quality/agent.js";
import { runAllTestMigrations } from "../support/databaseMigrations.js";

const url = process.env.INTEGRATION_DATABASE_URL;
const describeDb = url ? describe : describe.skip;

describeDb("revision eval run repository", () => {
  const accountId = randomUUID(), workspaceId = randomUUID(), agentId = randomUUID(), revisionId = randomUUID(), snapshotId = randomUUID(), caseId = randomUUID(), conversationId = randomUUID();
  let database: Database; let repository: RevisionEvalRunRepository;
  const snapshot = { customInstruction: null, directives: [], routines: [], contextVariableEnablements: [] };
  const frozenRevision = (): AgentRevision => ({ id: revisionId, snapshot, sourceDraftGeneration: 1, sourceBasePublishedRevisionId: null, createdAt: new Date(0), publishedAt: null, publishedVersion: null });

  beforeAll(async () => {
    database = new Database(url!); await runAllTestMigrations(database); repository = new RevisionEvalRunRepository(database.kysely);
    await database.query("INSERT INTO accounts (id,name,email,password_hash) VALUES ($1,$2,$3,$4)", [accountId, "revision eval", `revision-eval-${accountId}@example.com`, "hash"]);
    await database.query("INSERT INTO workspaces (id,account_id,name,public_route_key) VALUES ($1,$2,$3,$4)", [workspaceId, accountId, "revision eval", `revision-eval-${workspaceId}`]);
    await database.query("INSERT INTO agents (id,workspace_id,name) VALUES ($1,$2,$3)", [agentId, workspaceId, "agent"]);
    await database.query("INSERT INTO conversations (id,workspace_id,agent_id) VALUES ($1,$2,$3)", [conversationId, workspaceId, agentId]);
    await database.query("INSERT INTO agent_revisions (id,agent_id,workspace_id,snapshot,source_draft_generation) VALUES ($1,$2,$3,$4::jsonb,1)", [revisionId, agentId, workspaceId, JSON.stringify(snapshot)]);
    await database.query("INSERT INTO eval_snapshots (id,workspace_id,source_conversation_id,source_agent_id,fidelity,messages) VALUES ($1,$2,$3,$4,'full','[]'::jsonb)", [snapshotId, workspaceId, conversationId, agentId]);
    await database.query("INSERT INTO eval_cases (id,workspace_id,snapshot_id,name,status,assertions,execution_mode) VALUES ($1,$2,$3,$4,'pending','[]'::jsonb,'safe_test')", [caseId, workspaceId, snapshotId, "case"]);
  });
  afterAll(async () => { await database.query("DELETE FROM accounts WHERE id=$1", [accountId]).catch(() => undefined); await database.close(); });

  it("preserves selected revision identity and requires explicit retry with a monotonic fence", async () => {
    const runId = randomUUID(), sideId = randomUUID(), runCaseId = randomUUID();
    const run: RevisionEvalRun = { id: runId, workspaceId, agentId, actorAccountId: accountId, mode: "full_assistant", executionPolicy: "safe_test", testValues: [], state: "pending", createdAt: new Date(), sides: [{ id: sideId, ordinal: 0, revisionId, revision: frozenRevision(), state: "pending", cases: [{ id: runCaseId, caseId, frozenCase: { id: caseId, workspaceId, snapshotId, name: "case", assertions: [], executionMode: "safe_test", status: "pending", lastRunId: null, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() }, frozenSnapshot: { id: snapshotId, workspaceId, sourceConversationId: randomUUID(), sourceMessageId: null, replayTarget: null, fidelity: "full", messages: [], originalInstructionBlock: null, originalModelId: null, originalRetrievalSettings: null, originalAgent: null, originalAgentConfig: null, sourceAgentId: agentId, originalRoutineState: null, originalRetrievalResult: null, capturedAt: new Date().toISOString(), capturedBy: null }, state: "pending", outcome: "unavailable", result: null, activeAttemptId: null, activeFence: null, leaseExpiresAt: null }] }] };
    await repository.create(run);
    expect((await repository.find({ workspaceId, runId }))?.sides[0]?.revision.id).toBe(revisionId);
    const firstAttempt = randomUUID(); const first = await repository.claimNext({ workspaceId, runId, attemptId: firstAttempt, now: new Date(1_000), leaseMs: 1_000 });
    if (first === "none") throw new Error("initial claim missing");
    await repository.fail({ workspaceId, runId, runCaseId, attemptId: firstAttempt, fence: first.fence, result: { status: "error", outcomeReason: "runner_failed", assertionVerdicts: [], observedOutput: { retrievedChunks: [], error: { message: "revision_eval_runner_failed", code: "runner_failed" } }, resolvedConfig: {} }, now: new Date(1_100) });
    await expect(repository.claimNext({ workspaceId, runId, attemptId: randomUUID(), now: new Date(2_000), leaseMs: 1_000 })).resolves.toBe("none");
    await expect(repository.retryFailed({ workspaceId, runId, revisionId, caseId })).resolves.toBe(true);
    const nextAttempt = randomUUID(); const retry = await repository.claimNext({ workspaceId, runId, attemptId: nextAttempt, now: new Date(2_000), leaseMs: 1_000 });
    if (retry === "none") throw new Error("retry claim missing");
    expect(retry.fence).toBeGreaterThan(first.fence);
  });

  it("bounds concurrent recovery polling, progresses after completion, and reclaims only expired leases", async () => {
    const burstCaseIds: string[] = [randomUUID(), randomUUID(), randomUUID()];
    await Promise.all(burstCaseIds.map((id, index) => database.query("INSERT INTO eval_cases (id,workspace_id,snapshot_id,name,status,assertions,execution_mode) VALUES ($1,$2,$3,$4,'pending','[]'::jsonb,'safe_test')", [id, workspaceId, snapshotId, `burst ${index}`])));
    const frozenSnapshot: EvalSnapshot = { id: snapshotId, workspaceId, sourceConversationId: conversationId, sourceMessageId: null, replayTarget: null, fidelity: "full", messages: [], originalInstructionBlock: null, originalModelId: null, originalRetrievalSettings: null, originalAgent: null, originalAgentConfig: null, sourceAgentId: agentId, originalRoutineState: null, originalRetrievalResult: null, capturedAt: new Date().toISOString(), capturedBy: null };
    const frozenCase = (id: string): EvalCase => ({ id, workspaceId, snapshotId, name: id, assertions: [], executionMode: "safe_test", status: "pending", lastRunId: null, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() });
    const waitFor = async (predicate: () => boolean | Promise<boolean>): Promise<void> => {
      for (let attempt = 0; attempt < 100; attempt += 1) {
        if (await predicate()) return;
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      throw new Error("revision eval did not reach its expected state");
    };
    const pause = () => new Promise((resolve) => setTimeout(resolve, 25));
    const releases: Array<() => void> = [];
    let providerCalls = 0;
    const service = new RevisionEvalRunService({
      repository,
      revisions: { async findRevisionByWorkspace() { return { agentId, revision: frozenRevision() }; }, async findRevision() { return frozenRevision(); } },
      cases: { async findCase(_workspaceId, id) { return burstCaseIds.includes(id) ? frozenCase(id) : null; }, async findSnapshot() { return frozenSnapshot; } },
      contextCatalog: { async get() { return null; } },
      runner: {
        async executeFrozenRevisionCase() {
          providerCalls += 1;
          await new Promise<void>((resolve) => releases.push(resolve));
          return { status: "pass" as const, outcomeReason: null, assertionVerdicts: [], observedOutput: { retrievedChunks: [] }, resolvedConfig: {} };
        },
      },
    });
    const run = await service.start({ workspaceId, accountId, revisionIds: [revisionId], caseIds: burstCaseIds, testValues: [], mode: "retrieval_only", executionPolicy: "safe_test" });

    await Promise.all(Array.from({ length: 20 }, () => service.get({ workspaceId, runId: run.id, accountId: randomUUID() })));
    await waitFor(() => providerCalls > 0);
    await pause();
    expect(providerCalls).toBe(1);
    await service.get({ workspaceId, runId: run.id, accountId: randomUUID() });
    await pause();
    expect(providerCalls).toBe(1);

    releases.shift()?.();
    await waitFor(() => providerCalls === 2);
    releases.shift()?.();
    await waitFor(() => providerCalls === 3);
    releases.shift()?.();
    await waitFor(async () => (await repository.find({ workspaceId, runId: run.id }))?.state === "completed");
    await Promise.all(Array.from({ length: 20 }, () => service.get({ workspaceId, runId: run.id, accountId: randomUUID() })));
    await pause();
    expect(providerCalls).toBe(3);

    const crashCaseId = randomUUID();
    await database.query("INSERT INTO eval_cases (id,workspace_id,snapshot_id,name,status,assertions,execution_mode) VALUES ($1,$2,$3,$4,'pending','[]'::jsonb,'safe_test')", [crashCaseId, workspaceId, snapshotId, "crash recovery"]);
    const crashedService = new RevisionEvalRunService({
      repository,
      revisions: { async findRevisionByWorkspace() { return { agentId, revision: frozenRevision() }; }, async findRevision() { return frozenRevision(); } },
      cases: { async findCase(_workspaceId, id) { return id === crashCaseId ? frozenCase(id) : null; }, async findSnapshot() { return frozenSnapshot; } },
      contextCatalog: { async get() { return null; } },
      runner: { async executeFrozenRevisionCase() { return new Promise<never>(() => undefined); } },
      now: () => new Date(1_000),
      leaseMs: 1_000,
    });
    const crashRun = await crashedService.start({ workspaceId, accountId, revisionIds: [revisionId], caseIds: [crashCaseId], testValues: [], mode: "retrieval_only", executionPolicy: "safe_test" });
    await waitFor(async () => (await repository.find({ workspaceId, runId: crashRun.id }))?.sides[0]?.cases[0]?.activeAttemptId !== null);
    const stalled = (await repository.find({ workspaceId, runId: crashRun.id }))?.sides[0]?.cases[0];
    if (!stalled?.activeAttemptId || stalled.activeFence === null) throw new Error("stalled claim missing");
    await expect(repository.claimNext({ workspaceId, runId: crashRun.id, attemptId: randomUUID(), now: new Date(1_500), leaseMs: 1_000 })).resolves.toBe("none");
    const recoveredAttemptId = randomUUID();
    const recovered = await repository.claimNext({ workspaceId, runId: crashRun.id, attemptId: recoveredAttemptId, now: new Date(2_001), leaseMs: 1_000 });
    if (recovered === "none") throw new Error("expired lease was not reclaimed");
    expect(recovered.fence).toBeGreaterThan(stalled.activeFence);
    const result = { status: "pass" as const, outcomeReason: null, assertionVerdicts: [], observedOutput: { retrievedChunks: [] }, resolvedConfig: {} };
    await expect(repository.complete({ workspaceId, runId: crashRun.id, runCaseId: stalled.id, attemptId: stalled.activeAttemptId, fence: stalled.activeFence, result, now: new Date(2_100) })).resolves.toBe(false);
    await expect(repository.complete({ workspaceId, runId: crashRun.id, runCaseId: recovered.evalCase.id, attemptId: recoveredAttemptId, fence: recovered.fence, result, now: new Date(2_100) })).resolves.toBe(true);
  });

  it("keeps provider-error evidence retryable while preserving a completed sibling", async () => {
    const secondCaseId = randomUUID();
    await database.query("INSERT INTO eval_cases (id,workspace_id,snapshot_id,name,status,assertions,execution_mode) VALUES ($1,$2,$3,$4,'pending','[]'::jsonb,'safe_test')", [secondCaseId, workspaceId, snapshotId, "sibling"]);
    const historicalSnapshot: EvalSnapshot = {
      id: snapshotId, workspaceId, sourceConversationId: conversationId, sourceMessageId: null,
      replayTarget: null, fidelity: "full", messages: [{ id: randomUUID(), role: "user", content: "check retrieval", createdAt: new Date().toISOString() }],
      originalInstructionBlock: null, originalModelId: null, originalRetrievalSettings: null,
      originalAgent: null, originalAgentConfig: null, sourceAgentId: agentId, originalRoutineState: null,
      originalRetrievalResult: null, capturedAt: new Date().toISOString(), capturedBy: null,
    };
    const frozenCase = (id: string): EvalCase => ({ id, workspaceId, snapshotId, name: id === caseId ? "case" : "sibling", assertions: [{ type: "retrieval_includes_document", documentId: "document" }], executionMode: "safe_test", status: "pending", lastRunId: null, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() });
    const liveConfig: InternalAgentConfig = { ...conversationQualityAgentConfig, name: "Revision eval", customInstruction: "live instruction" };
    let retrievalAttempts = 0;
    const evalRunner = new EvalRunService(
      {} as never,
      {
        async retrieve() {
          retrievalAttempts += 1;
          if (retrievalAttempts === 1) throw new Error("provider secret detail");
          return { chunks: [{ chunkId: "chunk", documentId: "document", title: "Recovered", rank: 0 }] };
        },
        async answer() { throw new Error("full assistant is not expected"); },
      },
      { async judge() { throw new Error("judge is not expected"); } },
      undefined,
      undefined,
      undefined,
      { async find() { return liveConfig; } },
    );
    const service = new RevisionEvalRunService({
      repository,
      revisions: { async findRevisionByWorkspace() { return { agentId, revision: frozenRevision() }; }, async findRevision() { return frozenRevision(); } },
      cases: { async findCase(_workspaceId, id) { return id === caseId || id === secondCaseId ? frozenCase(id) : null; }, async findSnapshot() { return historicalSnapshot; } },
      contextCatalog: { async get() { return null; } },
      runner: evalRunner,
    });
    const run = await service.start({ workspaceId, accountId, revisionIds: [revisionId], caseIds: [caseId, secondCaseId], testValues: [], mode: "retrieval_only", executionPolicy: "safe_test" });
    const waitFor = async (predicate: () => Promise<boolean>): Promise<void> => {
      for (let attempt = 0; attempt < 100; attempt += 1) {
        if (await predicate()) return;
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      throw new Error("revision eval did not reach its expected state");
    };
    await waitFor(async () => (await repository.find({ workspaceId, runId: run.id }))?.state === "partial");
    const beforeRetry = await repository.find({ workspaceId, runId: run.id });
    const failed = beforeRetry?.sides[0]?.cases.find((item) => item.state === "failed");
    const sibling = beforeRetry?.sides[0]?.cases.find((item) => item.state === "completed");
    expect(failed).toMatchObject({ outcome: "partial", result: { status: "error", observedOutput: { error: { code: "runner_failed" } } } });
    expect(failed?.result?.observedOutput.error?.message).not.toContain("provider secret detail");
    expect(sibling).toMatchObject({ outcome: "pass" });
    const siblingResult = sibling?.result;

    await service.retry({ workspaceId, runId: run.id, revisionId, caseId: failed!.caseId, accountId: randomUUID() });
    await waitFor(async () => (await repository.find({ workspaceId, runId: run.id }))?.state === "completed");
    const recovered = await repository.find({ workspaceId, runId: run.id });
    expect(recovered).toMatchObject({ agentId, actorAccountId: accountId, sides: [expect.objectContaining({ revisionId })] });
    expect(recovered?.sides[0]?.cases.find((item) => item.caseId === failed!.caseId)).toMatchObject({ state: "completed", outcome: "pass" });
    expect(recovered?.sides[0]?.cases.find((item) => item.caseId === sibling!.caseId)?.result).toEqual(siblingResult);
  });
});
