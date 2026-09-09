import { describe, expect, it } from "vitest";

import type { AgentRevision } from "../../src/modules/agents/agentRevision.js";
import type { EvalCase, EvalSnapshot } from "../../src/modules/eval/domain/types.js";
import { AppError } from "../../src/shared/domain/errors.js";
import { RevisionEvalRunService, type RevisionEvalRepositoryPort, type RevisionEvalRun } from "../../src/modules/eval/services/revisionEvalRun.js";

const workspaceId = "00000000-0000-4000-8000-000000000001";
const agentId = "00000000-0000-4000-8000-000000000002";
const revisionId = "00000000-0000-4000-8000-000000000003";
const caseId = "00000000-0000-4000-8000-000000000004";
const variableId = "00000000-0000-4000-8000-000000000005";
const idempotencyKey = "revision-eval-start-1";
const revision = (): AgentRevision => ({ id: revisionId, sourceDraftGeneration: 1, sourceBasePublishedRevisionId: null, createdAt: new Date(), publishedAt: null, publishedVersion: null, snapshot: { customInstruction: "frozen", directives: [], routines: [], contextVariableEnablements: [{ id: "00000000-0000-4000-8000-000000000006", agentId, variableId, source: "pushed", resolverSkillId: null, maxAgeSeconds: null, resolverTimeoutMs: null, surfacing: "always", enabled: true, createdAt: new Date(), updatedAt: new Date() }] } });
const snapshot = (): EvalSnapshot => ({ id: "00000000-0000-4000-8000-000000000007", workspaceId, sourceConversationId: "00000000-0000-4000-8000-000000000008", sourceMessageId: null, replayTarget: null, fidelity: "full", messages: [], originalInstructionBlock: null, originalModelId: null, originalRetrievalSettings: null, originalAgent: null, originalAgentConfig: null, sourceAgentId: agentId, originalRoutineState: null, originalRetrievalResult: null, capturedAt: new Date().toISOString(), capturedBy: null });
const evalCase = (): EvalCase => ({ id: caseId, workspaceId, snapshotId: snapshot().id, name: "case", assertions: [], executionMode: "safe_test", status: "pending", lastRunId: null, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() });

describe("RevisionEvalRunService", () => {
  it("freezes candidate, case, snapshot, and validated private values before dispatch", async () => {
    let stored: RevisionEvalRun | null = null;
    const repository: RevisionEvalRepositoryPort = {
      async create(input) { stored = structuredClone(input); return stored; }, async findByIdempotencyKey() { return null; }, async find() { return stored; },
      async claimNext() { return "none"; }, async complete() { return true; }, async fail() { return true; }, async retryFailed() { return false; },
    };
    const sourceCase = evalCase(); const sourceSnapshot = snapshot(); const sourceRevision = revision();
    const service = new RevisionEvalRunService({
      repository,
      revisions: { async findRevisionByWorkspace() { return { agentId, revision: sourceRevision }; }, async findRevision() { return sourceRevision; } },
      cases: { async findCase() { return sourceCase; }, async findSnapshot() { return sourceSnapshot; } },
      contextCatalog: { async get() { return { id: variableId, workspaceId, name: "customer", description: null, valueType: "string", trustTier: "unverified", sensitivity: "normal", defaultSurfacing: "always", createdAt: new Date(), updatedAt: new Date() }; } },
      runner: { async executeFrozenRevisionCase() { throw new Error("not dispatched"); } },
    });
    const run = await service.start({ workspaceId, accountId: null, revisionIds: [revisionId], caseIds: [caseId], testValues: [{ contextVariableId: variableId, value: "private sample" }], mode: "full_assistant", executionPolicy: "safe_test", idempotencyKey });
    sourceRevision.snapshot.customInstruction = "draft changed";
    sourceCase.assertions = [{ type: "answer_contains", pattern: "new", matchMode: "substring" }];
    sourceSnapshot.sourceAgentId = "00000000-0000-4000-8000-000000000009";
    expect(run.sides[0]?.revision.snapshot.customInstruction).toBe("frozen");
    expect(run.sides[0]?.cases[0]?.frozenCase.assertions).toEqual([]);
    expect(run.sides[0]?.cases[0]?.frozenSnapshot.sourceAgentId).toBe(agentId);
    expect(run.testValues[0]).toMatchObject({ value: "private sample", name: "customer" });
  });

  it("records a config error's own distinguishable reason instead of collapsing it into runner_failed", async () => {
    const runId = "00000000-0000-4000-8000-00000000000a";
    const sideId = "00000000-0000-4000-8000-00000000000b";
    const caseRowId = "00000000-0000-4000-8000-00000000000c";
    const failed: Array<Parameters<RevisionEvalRepositoryPort["fail"]>[0]> = [];
    let claimed = false;
    const stored: RevisionEvalRun = {
      id: runId, workspaceId, agentId, actorAccountId: null, mode: "full_assistant", executionPolicy: "safe_test",
      testValues: [], state: "pending", createdAt: new Date(), idempotencyKey,
      sides: [{ id: sideId, ordinal: 0, revisionId, revision: revision(), state: "pending", cases: [{ id: caseRowId, caseId, frozenCase: evalCase(), frozenSnapshot: snapshot(), state: "pending", outcome: "unavailable", result: null, activeAttemptId: null, activeFence: null, leaseExpiresAt: null }] }],
    };
    const repository: RevisionEvalRepositoryPort = {
      async create(input) { return input; },
      async findByIdempotencyKey() { return null; },
      async find() { return stored; },
      async claimNext(_input) {
        if (claimed) return "none";
        claimed = true;
        return { run: stored, side: stored.sides[0], evalCase: stored.sides[0].cases[0], fence: 1 };
      },
      async complete() { return true; },
      async fail(input) { failed.push(input); return true; },
      async retryFailed() { return false; },
    };
    const service = new RevisionEvalRunService({
      repository,
      revisions: { async findRevisionByWorkspace() { return { agentId, revision: revision() }; }, async findRevision() { return revision(); } },
      cases: { async findCase() { return evalCase(); }, async findSnapshot() { return snapshot(); } },
      contextCatalog: { async get() { return { id: variableId, workspaceId, name: "customer", description: null, valueType: "string", trustTier: "unverified", sensitivity: "normal", defaultSurfacing: "always", createdAt: new Date(), updatedAt: new Date() }; } },
      runner: { async executeFrozenRevisionCase() { throw new AppError(400, "bad_request", "Live agent configuration is unavailable for revision evaluation"); } },
    });

    await service.resume({ workspaceId, runId, accountId: null });

    expect(failed).toHaveLength(1);
    expect(failed[0]?.result.outcomeReason).toBe("bad_request");
    expect(failed[0]?.result.observedOutput.error?.code).toBe("bad_request");
  });

  it("records a started audit event when a revision eval run is created, mirroring agent.test_execution.started", async () => {
    const audit: Array<{ eventType: string; eventStatus: string; metadata: Record<string, unknown> }> = [];
    const repository: RevisionEvalRepositoryPort = {
      async create(input) { return input; }, async findByIdempotencyKey() { return null; }, async find() { return null; },
      async claimNext() { return "none"; }, async complete() { return true; }, async fail() { return true; }, async retryFailed() { return false; },
    };
    const service = new RevisionEvalRunService({
      repository,
      revisions: { async findRevisionByWorkspace() { return { agentId, revision: revision() }; }, async findRevision() { return revision(); } },
      cases: { async findCase() { return evalCase(); }, async findSnapshot() { return snapshot(); } },
      contextCatalog: { async get() { return { id: variableId, workspaceId, name: "customer", description: null, valueType: "string", trustTier: "unverified", sensitivity: "normal", defaultSurfacing: "always", createdAt: new Date(), updatedAt: new Date() }; } },
      runner: { async executeFrozenRevisionCase() { throw new Error("not dispatched"); } },
      audit: { async record(input) { audit.push(input); } },
    });

    await service.start({ workspaceId, accountId: "account-1", revisionIds: [revisionId], caseIds: [caseId], testValues: [], mode: "full_assistant", executionPolicy: "safe_test", idempotencyKey });

    expect(audit).toHaveLength(1);
    expect(audit[0]).toMatchObject({ eventType: "agent.revision_eval_run.started", eventStatus: "success" });
  });

  it("records a completed audit event once resume's claim loop settles the run, without carrying prompts, completions, or chunks", async () => {
    const runId = "00000000-0000-4000-8000-00000000000d";
    const sideId = "00000000-0000-4000-8000-00000000000e";
    const caseRowId = "00000000-0000-4000-8000-00000000000f";
    const stored: RevisionEvalRun = {
      id: runId, workspaceId, agentId, actorAccountId: null, mode: "full_assistant", executionPolicy: "safe_test",
      testValues: [], state: "pending", createdAt: new Date(), idempotencyKey,
      sides: [{ id: sideId, ordinal: 0, revisionId, revision: revision(), state: "pending", cases: [{ id: caseRowId, caseId, frozenCase: evalCase(), frozenSnapshot: snapshot(), state: "pending", outcome: "unavailable", result: null, activeAttemptId: null, activeFence: null, leaseExpiresAt: null }] }],
    };
    let claimed = false;
    const audit: Array<{ eventType: string; eventStatus: string; metadata: Record<string, unknown> }> = [];
    const repository: RevisionEvalRepositoryPort = {
      async create(input) { return input; },
      async findByIdempotencyKey() { return null; },
      async find() { return stored; },
      async claimNext() {
        if (claimed) return "none";
        claimed = true;
        return { run: stored, side: stored.sides[0], evalCase: stored.sides[0].cases[0], fence: 1 };
      },
      async complete() {
        stored.sides[0].cases[0].state = "completed";
        stored.sides[0].state = "completed";
        stored.state = "completed";
        return true;
      },
      async fail() { return true; },
      async retryFailed() { return false; },
    };
    const service = new RevisionEvalRunService({
      repository,
      revisions: { async findRevisionByWorkspace() { return { agentId, revision: revision() }; }, async findRevision() { return revision(); } },
      cases: { async findCase() { return evalCase(); }, async findSnapshot() { return snapshot(); } },
      contextCatalog: { async get() { return { id: variableId, workspaceId, name: "customer", description: null, valueType: "string", trustTier: "unverified", sensitivity: "normal", defaultSurfacing: "always", createdAt: new Date(), updatedAt: new Date() }; } },
      runner: { async executeFrozenRevisionCase() { return { status: "pass", outcomeReason: null, assertionVerdicts: [], observedOutput: { retrievedChunks: [] }, resolvedConfig: {} }; } },
      audit: { async record(input) { audit.push(input); } },
    });

    await service.resume({ workspaceId, runId, accountId: null });

    const completedEvents = audit.filter((event) => event.eventType === "agent.revision_eval_run.completed");
    expect(completedEvents).toHaveLength(1);
    expect(completedEvents[0]).toMatchObject({ eventStatus: "success" });
    expect(JSON.stringify(completedEvents[0]?.metadata)).not.toMatch(/retrievedChunks|answer|prompt/i);
  });
});
