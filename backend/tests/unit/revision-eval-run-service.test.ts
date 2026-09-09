import { describe, expect, it } from "vitest";

import type { AgentRevision } from "../../src/modules/agents/agentRevision.js";
import type { EvalCase, EvalSnapshot } from "../../src/modules/eval/domain/types.js";
import { RevisionEvalRunService, type RevisionEvalRepositoryPort, type RevisionEvalRun } from "../../src/modules/eval/services/revisionEvalRun.js";

const workspaceId = "00000000-0000-4000-8000-000000000001";
const agentId = "00000000-0000-4000-8000-000000000002";
const revisionId = "00000000-0000-4000-8000-000000000003";
const caseId = "00000000-0000-4000-8000-000000000004";
const variableId = "00000000-0000-4000-8000-000000000005";
const revision = (): AgentRevision => ({ id: revisionId, sourceDraftGeneration: 1, sourceBasePublishedRevisionId: null, createdAt: new Date(), publishedAt: null, publishedVersion: null, snapshot: { customInstruction: "frozen", directives: [], routines: [], contextVariableEnablements: [{ id: "00000000-0000-4000-8000-000000000006", agentId, variableId, source: "pushed", resolverSkillId: null, maxAgeSeconds: null, resolverTimeoutMs: null, surfacing: "always", enabled: true, createdAt: new Date(), updatedAt: new Date() }] } });
const snapshot = (): EvalSnapshot => ({ id: "00000000-0000-4000-8000-000000000007", workspaceId, sourceConversationId: "00000000-0000-4000-8000-000000000008", sourceMessageId: null, replayTarget: null, fidelity: "full", messages: [], originalInstructionBlock: null, originalModelId: null, originalRetrievalSettings: null, originalAgent: null, originalAgentConfig: null, sourceAgentId: agentId, originalRoutineState: null, originalRetrievalResult: null, capturedAt: new Date().toISOString(), capturedBy: null });
const evalCase = (): EvalCase => ({ id: caseId, workspaceId, snapshotId: snapshot().id, name: "case", assertions: [], executionMode: "safe_test", status: "pending", lastRunId: null, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() });

describe("RevisionEvalRunService", () => {
  it("freezes candidate, case, snapshot, and validated private values before dispatch", async () => {
    let stored: RevisionEvalRun | null = null;
    const repository: RevisionEvalRepositoryPort = {
      async create(input) { stored = structuredClone(input); return stored; }, async find() { return stored; },
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
    const run = await service.start({ workspaceId, accountId: null, revisionIds: [revisionId], caseIds: [caseId], testValues: [{ contextVariableId: variableId, value: "private sample" }], mode: "full_assistant", executionPolicy: "safe_test" });
    sourceRevision.snapshot.customInstruction = "draft changed";
    sourceCase.assertions = [{ type: "answer_contains", pattern: "new", matchMode: "substring" }];
    sourceSnapshot.sourceAgentId = "00000000-0000-4000-8000-000000000009";
    expect(run.sides[0]?.revision.snapshot.customInstruction).toBe("frozen");
    expect(run.sides[0]?.cases[0]?.frozenCase.assertions).toEqual([]);
    expect(run.sides[0]?.cases[0]?.frozenSnapshot.sourceAgentId).toBe(agentId);
    expect(run.testValues[0]).toMatchObject({ value: "private sample", name: "customer" });
  });
});
