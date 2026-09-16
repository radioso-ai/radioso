import { randomUUID } from "node:crypto";

import { describe, expect, it, vi } from "vitest";

import { AgentSkillsService } from "../../../src/modules/agentSkills/service.js";
import { AgentRetrievalAuthoringService } from "../../../src/modules/agentSkills/retrievalAuthoring.js";
import { createRetrievalAuthoringCopilotTools } from "../../../src/modules/operatorCopilot/tools/retrievalAuthoring.js";
import { createDefaultSkillCapabilityRegistry } from "../../../src/modules/skills/capabilityRegistry.js";
import { InMemoryAgentSkillRepository } from "../../support/inMemoryAgentSkills.js";

const defaults = {
  workspaceId: "unused",
  retrievalStrategy: "fixed" as const,
  vectorTopK: 20,
  rerankEnabled: true,
  rerankTopK: 10,
  queryRewriteEnabled: true,
  temporalStructuredLookupEnabled: true,
  temporalBoostUpcomingEnabled: true,
  temporalDeterministicSortEnabled: false,
  semanticRewriteInstructions: "",
  lexicalRewriteInstructions: "",
  suggestedQuestionsEnabled: true,
  suggestedQuestionsCount: 3,
  metadataRules: [],
  similarityThreshold: 0.5,
};

const setup = async () => {
  const workspaceId = randomUUID();
  const agentId = randomUUID();
  const repository = new InMemoryAgentSkillRepository();
  const skills = new AgentSkillsService({ repository, capabilities: createDefaultSkillCapabilityRegistry() });
  const skill = await skills.create(workspaceId, agentId, {
    name: "answer_with_sources",
    capability: "retrieve",
    target: { kind: "source_scope", id: null },
    config: {
      sourceScope: { sourceIds: [randomUUID()] },
      vectorTopK: 12,
      rerankEnabled: true,
      rerankTopK: 8,
      exposedInputs: { query: true },
    },
    invocationMode: "default_answer",
    enabled: true,
  });
  return {
    workspaceId,
    agentId,
    skill,
    skills,
    authoring: new AgentRetrievalAuthoringService({
      agentSkills: skills,
      defaults: { getDefaults: (id) => ({ ...defaults, workspaceId: id }) as never },
    }),
  };
};

describe("Operator MCP retrieval authoring", () => {
  it("recovers the immutable retrieval review after a lost response without preparing again", async () => {
    const createProposal = vi.fn();
    const snapshot = { target: { agentId: randomUUID(), skillId: randomUUID(), skillName: "answer_with_sources" }, before: { vectorTopK: 12 }, after: { vectorTopK: 36 }, settingsVersion: "2026-09-13T00:00:00.000Z", lifecycle: "agent_skill_draft" as const };
    const [_, prepare] = createRetrievalAuthoringCopilotTools({
      retrievalAuthoring: {} as never, proposalRepository: { createProposal }, proposalAdapters: [], auditService: { record: vi.fn() },
      proposalRecovery: { recoverOperatorMcpProposal: vi.fn(async () => ({ status: "recovered", proposal: { id: randomUUID(), targetType: "agent_skill", reviewDigest: "d".repeat(43), expiresAt: new Date("2026-09-13T00:15:00Z"), reviewSnapshot: snapshot } })) },
    });
    const recovered = await prepare.reconcileMcpInvocation!({ invocation: { id: "invocation", grantId: "grant", operationId: "operation", inputDigest: "digest" }, context: { workspaceId: "workspace", operatorUserId: "user" }, staleBefore: new Date(0), now: new Date() } as never);
    expect(recovered).toMatchObject({ status: "recovered", output: { reviewDigest: "d".repeat(43), expiresAt: "2026-09-13T00:15:00.000Z", ...snapshot } });
    expect(createProposal).not.toHaveBeenCalled();
  });
  it("accepts citationHoldEnabled in the MCP-facing patch schema (#1260 review F6)", async () => {
    const workspaceId = randomUUID();
    const agentId = randomUUID();
    const skillId = randomUUID();
    const preparePatch = vi.fn(async (input: { patch: Record<string, unknown> }) => ({
      workspaceId,
      agentId,
      skillId,
      skill: { name: "answer_with_sources" },
      config: { citationHoldEnabled: input.patch.citationHoldEnabled },
      before: { citationHoldEnabled: true },
      after: { citationHoldEnabled: input.patch.citationHoldEnabled },
      settingsVersion: "2026-09-13T00:00:00.000Z",
    }));
    const createProposal = vi.fn(async () => ({ id: randomUUID() }) as never);
    const [, prepare] = createRetrievalAuthoringCopilotTools({
      retrievalAuthoring: { preparePatch } as never,
      proposalRepository: { createProposal },
      proposalAdapters: [],
      auditService: { record: vi.fn() },
      proposalRecovery: { recoverOperatorMcpProposal: vi.fn() },
    });
    const context = {
      workspaceId,
      operatorUserId: "operator-1",
      copilotConversationId: randomUUID(),
      currentAuthorization: { hasAllPermissions: vi.fn(async () => true) },
    };

    // Before the fix, `settingsPatch` is `.strict()` and does not list
    // `citationHoldEnabled`, so `prepareInput.parse` throws "Unrecognized
    // key(s)" here — Ray cannot even submit the patch, let alone have it applied.
    await prepare.createTool(context as never).invoke({ agentId, patch: { citationHoldEnabled: false } }, {} as never);

    expect(preparePatch).toHaveBeenCalledWith({ workspaceId, agentId, patch: { citationHoldEnabled: false } });
  });

  it("presents code-owned defaults separately from the existing agent retrieval override", async () => {
    const { authoring, workspaceId, agentId, skill } = await setup();

    await expect(authoring.inspect({ workspaceId, agentId })).resolves.toMatchObject({
      systemDefaults: { readOnly: true, settings: { vectorTopK: 20 } },
      agent: {
        agentId,
        skillId: skill.id,
        lifecycle: "agent_skill_draft",
        settings: { vectorTopK: 12, rerankTopK: 8 },
      },
    });
  });

  it("rejects a patch that tries to write a code-owned default or unsupported skill field", async () => {
    const { authoring, workspaceId, agentId } = await setup();

    await expect(authoring.preparePatch({
      workspaceId,
      agentId,
      patch: { similarityThreshold: 0.9 },
    })).rejects.toThrow();
    await expect(authoring.preparePatch({
      workspaceId,
      agentId,
      patch: { exposedInputs: { query: false } },
    })).rejects.toThrow();
  });

  it("keeps omitted settings intact in the reviewed full config", async () => {
    const { authoring, workspaceId, agentId } = await setup();
    const prepared = await authoring.preparePatch({
      workspaceId,
      agentId,
      patch: { vectorTopK: 36 },
    });

    expect(prepared.before).toMatchObject({ vectorTopK: 12, rerankTopK: 8 });
    expect(prepared.after).toMatchObject({ vectorTopK: 36, rerankTopK: 8 });
  });

  it("revalidates selected sources at apply time when a reviewed source is no longer in the workspace", async () => {
    const { workspaceId, agentId, skill, skills } = await setup();
    const selectedSourceId = randomUUID();
    let sourceStillExists = true;
    const authoring = new AgentRetrievalAuthoringService({
      agentSkills: skills,
      defaults: { getDefaults: () => ({}) as never },
      documentSources: { findExistingIdsByWorkspaceId: async () => sourceStillExists ? [selectedSourceId] : [] },
    });
    const prepared = await authoring.preparePatch({
      workspaceId,
      agentId,
      patch: { sourceScope: { sourceIds: [selectedSourceId] } },
    });
    sourceStillExists = false;

    await expect(authoring.validatePrepared({
      workspaceId,
      agentId,
      skillId: skill.id,
      config: prepared.config,
      skill: prepared.skill,
    })).rejects.toMatchObject({ statusCode: 400 });
  });
});
