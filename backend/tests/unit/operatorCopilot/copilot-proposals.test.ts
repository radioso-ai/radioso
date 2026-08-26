import { randomUUID } from "node:crypto";

import { describe, expect, it, vi } from "vitest";
import { z } from "zod";

vi.mock("../../../src/modules/routines/public.js", async (importOriginal) => ({
  ...await importOriginal<typeof import("../../../src/modules/routines/public.js")>(),
  routineToPortableDocument: vi.fn(),
}));

import {
  OperatorCopilotService,
  type CopilotConversation,
  type CopilotMessage,
  type CopilotProposal,
  type CopilotRepositoryPort,
} from "../../../src/modules/operatorCopilot/public.js";
import { createAgentSettingProposalCopilotTools } from "../../../src/modules/operatorCopilot/tools/agents.js";
import { createDirectiveProposalCopilotTools } from "../../../src/modules/operatorCopilot/tools/directives.js";
import { createRoutineProposalCopilotTools } from "../../../src/modules/operatorCopilot/tools/routines.js";

const workspaceId = randomUUID();
const accountId = randomUUID();
const operatorUserId = randomUUID();
const agentId = randomUUID();
const directiveId = randomUUID();
const workspaceRouteKeyResolver = { resolveWorkspaceKey: async () => "workspace" };

type ProposalToolDependencies = Parameters<typeof createDirectiveProposalCopilotTools>[0]
  & Parameters<typeof createRoutineProposalCopilotTools>[0]
  & Parameters<typeof createAgentSettingProposalCopilotTools>[0];

/** Ports for a draft that cites no replay: nothing is looked up and nothing is measured. */
const unmeasured = () => ({
  evidence: { record: vi.fn(), findMany: vi.fn(async () => []) },
  agentVersion: { get: vi.fn(async () => ({ updatedAt: new Date("2026-08-25T10:00:00.000Z") })) },
});

const createProposalTools = (deps: ProposalToolDependencies) => [
  ...createDirectiveProposalCopilotTools(deps),
  ...createRoutineProposalCopilotTools(deps),
  ...createAgentSettingProposalCopilotTools(deps),
];

describe("US3 copilot proposals", () => {
  it("emits a proposal after its completed draft tool call and associates it with the persisted copilot message", async () => {
    const repository = new MemoryProposalRepository();
    const conversation = await repository.createConversation({ workspaceId, operatorUserId, title: "Draft it" });
    const proposal = await repository.createProposal({
      workspaceId,
      operatorUserId,
      conversationId: conversation.id,
      targetType: "directive",
      targetRef: { agentId, directiveId: null },
      payload: { name: "Avoid competitors" },
      versionToken: "version-1",
      evidence: null,
    });
    const service = new OperatorCopilotService({
      repository,
      capabilityRunner: {
        runStreaming: () => ({
          events: (async function* () {
            yield { kind: "tool_call_invoked" as const, stepIndex: 0, toolName: "propose_directive", callId: "draft-1", at: 1 };
            yield {
              kind: "tool_call_completed" as const,
              stepIndex: 0,
              toolName: "propose_directive",
              callId: "draft-1",
              output: { proposalId: proposal.id, targetType: "directive", targetLabel: "Avoid competitors", summary: "Draft directive" },
              resultTokens: 1,
              latencyMs: 1,
              at: 2,
            };
          })(),
          result: Promise.resolve({ terminatedReason: "completed" as const, finalMessage: "I drafted it.", stepsTaken: 1, toolResultTokensUsed: 1, wallTimeMs: 1 }),
        }),
      },
      usageLimitPolicy: noLimitPolicy(),
      auditService: auditService(),
      prompt: "system",
      workspaceRouteKeyResolver,
      tools: [tool("propose_directive", "workspace.agents.manage")],
    });

    const events = [];
    for await (const event of service.runTurn({
      workspaceId,
      accountId,
      operatorUserId,
      conversationId: conversation.id,
      message: "Draft it",
      pageContext: { view: "agent", agentId, conversationId: null, selection: null, entities: [] },
      permissions: new Set(["workspace.agents.manage"]),
    })) events.push(event);

    expect(events).toContainEqual({ event: "proposal", data: { proposalId: proposal.id, targetType: "directive", targetLabel: "Avoid competitors", summary: "Draft directive" } });
    const message = (await repository.listMessages({ conversationId: conversation.id })).find((item) => item.role === "copilot");
    expect(message?.proposals).toEqual([expect.objectContaining({ id: proposal.id, status: "pending" })]);
  });

  it("creates draft-only directive and setting proposals, validating setting values before persistence", async () => {
    const createProposal = vi.fn(async (input: Parameters<MemoryProposalRepository["createProposal"]>[0]) => ({
      id: randomUUID(), ...input, messageId: null, status: "pending" as const, appliedRef: null, createdAt: new Date(), updatedAt: new Date(),
    }));
    const descriptors = createProposalTools({
      proposalRepository: { createProposal },
      proposalEvidence: unmeasured(),
      proposalAdapters: [
        {
          targetType: "directive",
          readVersionToken: vi.fn(async () => "directive-version"),
          preview: vi.fn(),
          applyIfVersionMatches: vi.fn(),
          draft: vi.fn(async () => ({ payload: { name: "Avoid competitors" }, targetLabel: "Avoid competitors", summary: "Draft directive" })),
        },
        {
          targetType: "agent_setting",
          readVersionToken: vi.fn(async () => "agent-version"),
          preview: vi.fn(),
          applyIfVersionMatches: vi.fn(),
          validatePayload: vi.fn(async (_workspaceId, targetRef, payload) => ({ targetRef, payload })),
        },
        { targetType: "routine", readVersionToken: vi.fn(), preview: vi.fn(), applyIfVersionMatches: vi.fn(), draft: vi.fn() },
      ],
      auditService: auditService(),
    });
    const context = { workspaceId, accountId, operatorUserId, copilotConversationId: "conversation-1", pageContext: { view: "agent" as const, agentId, conversationId: null, selection: null, entities: [] } };

    expect(descriptors.map(({ name, shape }) => ({ name, shape }))).toEqual([
      { name: "propose_directive", shape: "propose" },
      { name: "propose_routine", shape: "propose" },
      { name: "propose_agent_setting", shape: "propose" },
    ]);

    await descriptors.find((descriptor) => descriptor.name === "propose_directive")?.createTool(context).invoke({ directiveId, intent: "Do not recommend competitors" }, {} as never);
    await descriptors.find((descriptor) => descriptor.name === "propose_agent_setting")?.createTool(context).invoke({ settingKey: "retrievalEnabled", value: false }, {} as never);

    expect(createProposal).toHaveBeenCalledTimes(2);
    expect(createProposal.mock.calls[0]?.[0]).toMatchObject({ targetType: "directive", targetRef: { agentId, directiveId }, versionToken: "directive-version" });
    expect(createProposal.mock.calls[1]?.[0]).toMatchObject({ targetType: "agent_setting", targetRef: { agentId, settingKey: "retrievalEnabled" }, versionToken: "agent-version" });
  });

  it("creates a pending routine proposal from the authored assist draft", async () => {
    const createProposal = vi.fn(async (input: Parameters<MemoryProposalRepository["createProposal"]>[0]) => ({
      id: randomUUID(), ...input, messageId: null, status: "pending" as const, appliedRef: null, createdAt: new Date(), updatedAt: new Date(),
    }));
    const payload = { name: "Return intake", steps: [] };
    const routineDraft = vi.fn(async () => ({ payload, targetLabel: "Return intake", summary: "Draft routine Return intake has 2 open validation diagnostics." }));
    const descriptors = createProposalTools({
      proposalRepository: { createProposal },
      proposalEvidence: unmeasured(),
      proposalAdapters: [
        { targetType: "directive", readVersionToken: vi.fn(), preview: vi.fn(), applyIfVersionMatches: vi.fn(), draft: vi.fn() },
        { targetType: "agent_setting", readVersionToken: vi.fn(), preview: vi.fn(), applyIfVersionMatches: vi.fn(), validatePayload: vi.fn() },
        { targetType: "routine", readVersionToken: vi.fn(async () => "agent-version"), preview: vi.fn(), applyIfVersionMatches: vi.fn(), draft: routineDraft },
      ],
      auditService: auditService(),
    });
    const context = { workspaceId, accountId, operatorUserId, copilotConversationId: "conversation-1", pageContext: { view: "agent" as const, agentId, conversationId: null, selection: null, entities: [] } };

    const routineTool = descriptors.find((descriptor) => descriptor.name === "propose_routine");
    const result = await routineTool?.createTool(context).invoke({ intent: "Draft a return-intake flow" }, {} as never);

    expect(result).toEqual(expect.objectContaining({ targetType: "routine", targetLabel: "Return intake" }));
    expect(routineDraft).toHaveBeenCalledWith(workspaceId, { agentId, routineId: null }, "Draft a return-intake flow");
    expect(createProposal).toHaveBeenCalledWith(expect.objectContaining({
      targetType: "routine",
      targetRef: { agentId, routineId: null },
      payload,
      versionToken: "agent-version",
    }));
  });

  it("applies only pending proposals through their adapter, recording a stale result without a write", async () => {
    const repository = new MemoryProposalRepository();
    const proposal = await repository.createProposal({ workspaceId, operatorUserId, conversationId: "conversation-1", targetType: "directive", targetRef: { agentId, directiveId }, payload: { name: "Updated" }, versionToken: "outdated", evidence: null });
    const applyIfVersionMatches = vi.fn(async () => ({ outcome: "stale" as const }));
    const audit = auditService();
    const service = new OperatorCopilotService({
      repository,
      capabilityRunner: { runStreaming: vi.fn() },
      usageLimitPolicy: noLimitPolicy(),
      auditService: audit,
      prompt: "system",
      workspaceRouteKeyResolver,
      tools: [],
      proposalAdapters: [{ targetType: "directive", readVersionToken: vi.fn(async () => "new"), preview: vi.fn(), applyIfVersionMatches }],
    });

    expect(await service.applyProposal({ workspaceId, accountId, operatorUserId, proposalId: proposal.id })).toEqual({ status: "stale" });
    expect(applyIfVersionMatches).toHaveBeenCalledOnce();
    expect((await repository.findProposal({ id: proposal.id, workspaceId, operatorUserId }))?.status).toBe("stale");
    expect(audit.record).toHaveBeenCalledWith(expect.objectContaining({ eventType: "copilot.proposal.apply_failed", metadata: expect.objectContaining({ outcome: "stale" }) }));
  });

  it("finalizes an unexpected apply exception as failed so the proposal is not stranded", async () => {
    const repository = new MemoryProposalRepository();
    const proposal = await repository.createProposal({ workspaceId, operatorUserId, conversationId: "conversation-1", targetType: "directive", targetRef: { agentId, directiveId }, payload: { name: "Updated" }, versionToken: "current", evidence: null });
    const audit = auditService();
    const service = new OperatorCopilotService({
      repository,
      capabilityRunner: { runStreaming: vi.fn() },
      usageLimitPolicy: noLimitPolicy(),
      auditService: audit,
      prompt: "system",
      workspaceRouteKeyResolver,
      tools: [],
      proposalAdapters: [{ targetType: "directive", readVersionToken: vi.fn(), preview: vi.fn(), applyIfVersionMatches: vi.fn(async () => { throw new Error("target unavailable"); }) }],
    });

    expect(await service.applyProposal({ workspaceId, accountId, operatorUserId, proposalId: proposal.id })).toEqual({ status: "failed" });
    expect((await repository.findProposal({ id: proposal.id, workspaceId, operatorUserId }))?.status).toBe("failed");
    expect(audit.record).toHaveBeenCalledWith(expect.objectContaining({ eventType: "copilot.proposal.apply_failed", metadata: expect.objectContaining({ outcome: "failed" }) }));
  });

  it("persists adapter failure reasons so failed proposals still explain themselves after reload", async () => {
    const repository = new MemoryProposalRepository();
    const proposal = await repository.createProposal({ workspaceId, operatorUserId, conversationId: "conversation-1", targetType: "directive", targetRef: { agentId, directiveId }, payload: { name: "Updated" }, versionToken: "current", evidence: null });
    const message = await repository.createMessage({ conversationId: "conversation-1", role: "copilot", content: "Drafted", outcome: "completed", activity: [] });
    await repository.attachProposalsToMessage({ proposalIds: [proposal.id], conversationId: "conversation-1", messageId: message.id });
    const service = new OperatorCopilotService({
      repository,
      capabilityRunner: { runStreaming: vi.fn() },
      usageLimitPolicy: noLimitPolicy(),
      auditService: auditService(),
      prompt: "system",
      workspaceRouteKeyResolver,
      tools: [],
      proposalAdapters: [{ targetType: "directive", readVersionToken: vi.fn(), preview: vi.fn(), applyIfVersionMatches: vi.fn(async () => ({ outcome: "failed" as const, reason: "Directive validation failed." })) }],
    });

    expect(await service.applyProposal({ workspaceId, accountId, operatorUserId, proposalId: proposal.id })).toEqual({ status: "failed", reason: "Directive validation failed." });
    expect((await repository.findProposal({ id: proposal.id, workspaceId, operatorUserId }))?.reason).toBe("Directive validation failed.");
    expect((await repository.listMessages({ conversationId: "conversation-1" }))[0]?.proposals?.[0]?.reason).toBe("Directive validation failed.");
  });

  it("emits routine proposal SSE events", async () => {
    const repository = new MemoryProposalRepository();
    const conversation = await repository.createConversation({ workspaceId, operatorUserId, title: "Draft routine" });
    const proposal = await repository.createProposal({ workspaceId, operatorUserId, conversationId: conversation.id, targetType: "routine", targetRef: { agentId, routineId: null }, payload: { name: "Return intake" }, versionToken: "version-1", evidence: null });
    const service = new OperatorCopilotService({
      repository,
      capabilityRunner: {
        runStreaming: () => ({
          events: (async function* () {
            yield { kind: "tool_call_completed" as const, stepIndex: 0, toolName: "propose_routine", callId: "draft-routine", output: { proposalId: proposal.id, targetType: "routine", targetLabel: "Return intake", summary: "Draft routine" }, resultTokens: 1, latencyMs: 1, at: 1 };
          })(),
          result: Promise.resolve({ terminatedReason: "completed" as const, finalMessage: "I drafted it.", stepsTaken: 1, toolResultTokensUsed: 1, wallTimeMs: 1 }),
        }),
      },
      usageLimitPolicy: noLimitPolicy(), auditService: auditService(), prompt: "system", workspaceRouteKeyResolver, tools: [tool("propose_routine", "workspace.agents.manage")],
    });

    const events = [];
    for await (const event of service.runTurn({ workspaceId, accountId, operatorUserId, conversationId: conversation.id, message: "Draft it", pageContext: { view: "agent", agentId, conversationId: null, selection: null, entities: [] }, permissions: new Set(["workspace.agents.manage"]) })) events.push(event);

    expect(events).toContainEqual({ event: "proposal", data: { proposalId: proposal.id, targetType: "routine", targetLabel: "Return intake", summary: "Draft routine" } });
  });
});

const tool = (name: string, requiredPermission: "workspace.agents.manage") => ({
  name,
  shape: "propose" as const,
  uiLabel: "Drafting a directive",
  description: "Draft",
  requiredPermissions: [requiredPermission] as const,
  contributingModule: "operatorCopilot",
  dashboardSubject: { type: "proposal" },
  inputSchema: z.object({}),
  outputSchema: z.object({}),
  createTool: () => ({ name, description: "Draft", inputSchema: z.object({}), outputSchema: z.object({}), invoke: vi.fn() }),
});

const auditService = () => ({ record: vi.fn(async () => {}), getLatestSuccessfulChatAnswerMetadata: vi.fn(), updateChatAnswerSuggestions: vi.fn() });
const noLimitPolicy = () => ({ reserveAnswer: vi.fn(async () => ({ commit: vi.fn(async () => {}), release: vi.fn(async () => {}) })), reserveDocument: vi.fn(), reserveIndexedStorage: vi.fn(), reserveMonthlyIndexedContent: vi.fn() });

class MemoryProposalRepository implements CopilotRepositoryPort {
  conversations: CopilotConversation[] = [];
  messages: CopilotMessage[] = [];
  proposals: CopilotProposal[] = [];

  async createConversation(input: { workspaceId: string; operatorUserId: string; title: string | null }): Promise<CopilotConversation> { const createdAt = new Date(); const conversation = { id: randomUUID(), ...input, status: "idle" as const, createdAt, updatedAt: createdAt }; this.conversations.push(conversation); return conversation; }
  async findConversation(input: { id: string; workspaceId: string; operatorUserId: string }): Promise<CopilotConversation | null> { return this.conversations.find((item) => item.id === input.id && item.workspaceId === input.workspaceId && item.operatorUserId === input.operatorUserId) ?? null; }
  async listConversations(input: { workspaceId: string; operatorUserId: string }): Promise<ReadonlyArray<CopilotConversation>> { return this.conversations.filter((item) => item.workspaceId === input.workspaceId && item.operatorUserId === input.operatorUserId); }
  async deleteConversation(input: { id: string; workspaceId: string; operatorUserId: string }): Promise<boolean> { const found = await this.findConversation(input); if (!found) return false; this.conversations = this.conversations.filter((item) => item.id !== found.id); return true; }
  async createMessage(input: Omit<CopilotMessage, "id" | "createdAt">): Promise<CopilotMessage> { const message = { ...input, id: randomUUID(), createdAt: new Date() }; this.messages.push(message); return message; }
  async listMessages(input: { conversationId: string }): Promise<ReadonlyArray<CopilotMessage>> { return this.messages.filter((item) => item.conversationId === input.conversationId).map((message) => ({ ...message, proposals: this.proposals.filter((proposal) => proposal.messageId === message.id).map(presentProposal) })); }
  async acquireTurn(input: { id: string; workspaceId: string; operatorUserId: string }): Promise<CopilotConversation | "running" | null> { const conversation = await this.findConversation(input); if (!conversation || conversation.status === "running") return conversation ? "running" : null; const next = { ...conversation, status: "running" as const }; this.conversations[this.conversations.indexOf(conversation)] = next; return next; }
  async finishTurn(input: { id: string; workspaceId: string; operatorUserId: string }): Promise<void> { const conversation = await this.findConversation(input); if (conversation) this.conversations[this.conversations.indexOf(conversation)] = { ...conversation, status: "idle" }; }
  async createProposal(input: Omit<CopilotProposal, "id" | "messageId" | "status" | "appliedRef" | "createdAt" | "updatedAt">): Promise<CopilotProposal> { const createdAt = new Date(); const proposal = { ...input, id: randomUUID(), messageId: null, status: "pending" as const, reason: null, appliedRef: null, createdAt, updatedAt: createdAt }; this.proposals.push(proposal); return proposal; }
  async findProposal(input: { id: string; workspaceId: string; operatorUserId: string }): Promise<CopilotProposal | null> { return this.proposals.find((item) => item.id === input.id && item.workspaceId === input.workspaceId && item.operatorUserId === input.operatorUserId) ?? null; }
  async attachProposalsToMessage(input: { proposalIds: ReadonlyArray<string>; messageId: string; conversationId: string }): Promise<void> { this.proposals = this.proposals.map((proposal) => input.proposalIds.includes(proposal.id) && proposal.conversationId === input.conversationId ? { ...proposal, messageId: input.messageId } : proposal); }
  async updateProposalOutcome(input: { id: string; workspaceId: string; operatorUserId: string; status: CopilotProposal["status"]; appliedRef?: unknown | null; reason?: string | null }): Promise<CopilotProposal | null> { const proposal = await this.findProposal(input); if (!proposal) return null; const next = { ...proposal, status: input.status, reason: input.reason ?? null, appliedRef: input.appliedRef ?? null, updatedAt: new Date() }; this.proposals[this.proposals.indexOf(proposal)] = next; return next; }
  async claimProposalApply(input: { id: string; workspaceId: string; operatorUserId: string }): Promise<CopilotProposal | null> { const proposal = await this.findProposal(input); return proposal?.status === "pending" ? proposal : null; }
}

const presentProposal = (proposal: CopilotProposal) => ({ id: proposal.id, targetType: proposal.targetType, targetLabel: proposal.targetType === "directive" || proposal.targetType === "routine" ? String((proposal.payload as { name?: unknown }).name ?? "Routine") : String((proposal.targetRef as { settingKey: string }).settingKey), summary: proposal.targetType === "directive" ? "Draft directive" : proposal.targetType === "routine" ? "Draft routine" : "Draft setting change", status: proposal.status, reason: proposal.reason ?? null });

describe("directive proposal adapter payload mapping", () => {
  it("strips draft-only presentation fields before calling directive management", async () => {
    const { createDirectiveCopilotProposalAdapter } = await import("../../../src/app/composition/copilotProposalAdapters.js");
    const create = vi.fn(async () => ({ directive: { id: "directive-1" }, coherence: null }));
    const adapter = createDirectiveCopilotProposalAdapter({
      authoredDirectiveService: { list: vi.fn(async () => []), create, update: vi.fn() } as never,
      directiveAuthorService: { draft: vi.fn() } as never,
      agentService: { get: vi.fn(async () => ({ updatedAt: new Date(0) })) } as never,
    });

    const result = await adapter.applyIfVersionMatches(
      "workspace-1",
      { agentId: "6a6a6a6a-1111-2222-3333-444444444444", directiveId: null },
      {
        name: "shipping-damage-remediation",
        condition: { kind: "contextual", description: "Order arrived damaged." },
        action: "Ask for a photo, then offer replacement or refund.",
        tags: [],
        rationale: "Coach explanation the strict input schema must never see.",
      },
      String(new Date(0).getTime()),
    );

    expect(result).toEqual({ outcome: "applied", appliedRef: { directiveId: "directive-1" } });
    const [, , input] = create.mock.calls[0] as unknown as [string, string, Record<string, unknown>];
    expect(input.rationale).toBeUndefined();
    expect(input.name).toBe("shipping-damage-remediation");
  });
});

describe("routine proposal adapter", () => {
  it("keeps authored assist payload intact, creates a draft, and guards it against agent changes", async () => {
    const { createRoutineCopilotProposalAdapter } = await import("../../../src/app/composition/copilotProposalAdapters.js");
    const payload = routineDraftPayload();
    const draft = vi.fn(async () => ({ draft: payload, validation: { ok: false, diagnostics: [{ code: "missing_transition" }] } }));
    const createDraft = vi.fn(async () => ({ routine: { id: "routine-1", status: "draft" } }));
    const updatedAt = new Date(0);
    const agentService = { get: vi.fn(async () => ({ updatedAt })) };
    const adapter = createRoutineCopilotProposalAdapter({
      agentService: agentService as never,
      routineDraftAssistService: { draft } as never,
      routineDefinitionService: { createDraft } as never,
    });
    const targetRef = { agentId: "6a6a6a6a-1111-2222-3333-444444444444", routineId: null };
    const summary = "Draft routine Return intake has 1 open validation diagnostic.";
    const storedPayload = { ...payload, rationale: summary };

    expect(await adapter.draft("workspace-1", targetRef, "Draft a return intake routine")).toEqual({
      payload: storedPayload,
      targetLabel: "Return intake",
      summary,
    });
    expect(await adapter.preview("workspace-1", targetRef, storedPayload)).toEqual({ targetLabel: "Return intake", current: null, proposed: payload });
    expect(await adapter.applyIfVersionMatches("workspace-1", targetRef, storedPayload, updatedAt.toISOString())).toEqual({
      outcome: "applied",
      appliedRef: { agentId: targetRef.agentId, routineId: "routine-1" },
    });
    expect(createDraft).toHaveBeenCalledWith("workspace-1", targetRef.agentId, payload);

    updatedAt.setTime(updatedAt.getTime() + 1);
    expect(await adapter.applyIfVersionMatches("workspace-1", targetRef, storedPayload, new Date(0).toISOString())).toEqual({ outcome: "stale" });
    expect(createDraft).toHaveBeenCalledOnce();
  });
});

describe("proposal card presentation", () => {
  it("keeps a routine proposal's drafted summary across a reload", async () => {
    const { presentProposalCard } = await import("../../../src/db/repositories/copilotRepository.js");
    const base = {
      id: "proposal-1", workspaceId: "workspace-1", operatorUserId: "user-1", conversationId: "conversation-1", messageId: "message-1",
      targetType: "routine" as const, targetRef: { agentId: "agent-1", routineId: null }, versionToken: "v1", evidence: null,
      status: "pending" as const, reason: null, appliedRef: null, createdAt: new Date(0), updatedAt: new Date(0),
    };
    const summary = "Draft routine Return intake has 1 open validation diagnostic.";

    expect(presentProposalCard({ ...base, payload: { name: "Return intake", rationale: summary } })).toMatchObject({ targetLabel: "Return intake", summary });
    expect(presentProposalCard({ ...base, payload: { name: "Return intake" } })).toMatchObject({ targetLabel: "Return intake", summary: "Return intake" });
  });
});

const routineDraftPayload = () => ({
  name: "Return intake",
  activation: { triggerDescription: "When a customer requests a return", gateRef: null, priority: 10, reentryMode: "once_per_conversation" },
  slots: [{ stableSlotId: "slot_reason", key: "reason", type: "text", required: true, description: null, ordinal: 0 }],
  steps: [{ stableStepId: "step_collect_reason", kind: "chat", instruction: "Ask for {{slot.reason}}.", toolRef: null, ordinal: 0, metadata: {} }],
  transitions: [{ fromStep: "step_collect_reason", toRef: "terminal_complete", guardKind: "default", guardText: null, outcomeStatus: null, counterLimit: null, ordinal: 0 }],
  terminals: [{ stableStepId: "terminal_complete", kind: "complete", instruction: "Complete return intake for {{slot.reason}}.", ordinal: 1 }],
});

describe("proposal card evidence", () => {
  const card = async (evidence: CopilotProposal["evidence"]) => {
    const { presentProposalCard } = await import("../../../src/db/repositories/copilotRepository.js");
    return presentProposalCard({
      id: "proposal-1", workspaceId: "workspace-1", operatorUserId: "user-1", conversationId: "conversation-1", messageId: "message-1",
      targetType: "directive", targetRef: { agentId: "agent-1", directiveId: null }, payload: { name: "Refund window", rationale: "State it" },
      versionToken: "v1", evidence, status: "pending", reason: null, appliedRef: null, createdAt: new Date(0), updatedAt: new Date(0),
    });
  };

  it("states what a measured proposal was verified against, regressions included", async () => {
    expect(await card({ cases: [
      { caseId: "case-1", caseName: "Refund window", runId: "run-1", before: "failing", after: "pass", stale: false },
      { caseId: "case-2", caseName: "Shipping", runId: "run-2", before: "passing", after: "fail", stale: false },
    ] })).toMatchObject({ evidence: { total: 2, improved: 1, regressed: 1 } });
  });

  it("leaves an unmeasured proposal without an evidence section rather than an empty one", async () => {
    // A zero-case section would read as "verified against nothing", which is not what happened.
    expect(await card(null)).not.toHaveProperty("evidence");
  });
});

describe("proposals carrying replay evidence", () => {
  const evidenceId = randomUUID();
  const caseId = randomUUID();
  const runId = randomUUID();
  const capturedAt = new Date("2026-08-25T10:00:00.000Z");
  const agentUpdatedAt = new Date("2026-08-25T09:00:00.000Z");

  const measured = (overrides: Record<string, unknown> = {}) => ({
    id: evidenceId,
    workspaceId,
    operatorUserId,
    conversationId: "conversation-1",
    agentId,
    caseId,
    caseName: "Refund window",
    runId,
    baselineCapturedAt: capturedAt,
    recordedStatus: "failing" as const,
    verdict: "pass" as const,
    // A directive proposal can only cite a replay that had directives under test.
    overrides: { agentConfigOverride: { authoredDirectives: [{ action: "State the refund window" }] } },
    createdAt: new Date(),
    ...overrides,
  });

  const harness = (options: { records?: ReadonlyArray<ReturnType<typeof measured>>; updatedAt?: Date } = {}) => {
    const createProposal = vi.fn(async (input: Parameters<MemoryProposalRepository["createProposal"]>[0]) => ({
      id: randomUUID(), ...input, messageId: null, status: "pending" as const, appliedRef: null, createdAt: new Date(), updatedAt: new Date(),
    }));
    const descriptors = createDirectiveProposalCopilotTools({
      proposalRepository: { createProposal },
      proposalEvidence: {
        evidence: { record: vi.fn(), findMany: vi.fn(async () => options.records ?? [measured()]) },
        agentVersion: { get: vi.fn(async () => ({ updatedAt: options.updatedAt ?? agentUpdatedAt })) },
      },
      proposalAdapters: [
        {
          targetType: "directive" as const,
          readVersionToken: vi.fn(async () => "directive-version"),
          draft: vi.fn(async () => ({ payload: { name: "Refund window" }, targetLabel: "Refund window", summary: "State the refund window" })),
          preview: vi.fn(),
          applyIfVersionMatches: vi.fn(),
        },
      ],
      auditService: { record: vi.fn(async () => undefined) },
    } as never);
    const descriptor = descriptors.find((candidate) => candidate.name === "propose_directive")!;
    return { descriptor, createProposal };
  };

  const context = { workspaceId, accountId, operatorUserId, copilotConversationId: "conversation-1", pageContext: { view: "other" as const, agentId, conversationId: null, selection: null, entities: [] } };

  it("stores the measurement on the proposal and reports it to the operator", async () => {
    const { descriptor, createProposal } = harness();

    const result = await descriptor.createTool(context).invoke({ intent: "State the refund window", evidenceIds: [evidenceId] }, {} as never);

    expect(createProposal).toHaveBeenCalledWith(expect.objectContaining({
      evidence: { cases: [{ caseId, caseName: "Refund window", runId, before: "failing", after: "pass", stale: false }] },
    }));
    expect(result).toMatchObject({ evidence: { total: 1, improved: 1, regressed: 0, stale: 0 } });
  });

  it("marks the measurement stale when the agent moved between the replay and the draft", async () => {
    const { descriptor, createProposal } = harness({ updatedAt: new Date("2026-08-25T12:00:00.000Z") });

    const result = await descriptor.createTool(context).invoke({ intent: "State the refund window", evidenceIds: [evidenceId] }, {} as never);

    expect(createProposal).toHaveBeenCalledWith(expect.objectContaining({
      evidence: { cases: [expect.objectContaining({ stale: true })] },
    }));
    expect(result).toMatchObject({ evidence: { stale: 1 } });
  });

  it("drafts an unmeasured proposal with no evidence rather than an empty measurement", async () => {
    const { descriptor, createProposal } = harness();

    const result = await descriptor.createTool(context).invoke({ intent: "State the refund window" }, {} as never);

    expect(createProposal).toHaveBeenCalledWith(expect.objectContaining({ evidence: null }));
    expect(result).not.toHaveProperty("evidence");
  });

  it("refuses to attach a measurement taken on another agent", async () => {
    const { descriptor, createProposal } = harness({ records: [measured({ agentId: randomUUID() })] });

    await expect(descriptor.createTool(context).invoke({ intent: "State it", evidenceIds: [evidenceId] }, {} as never))
      .rejects.toThrow(/different agent/i);
    expect(createProposal).not.toHaveBeenCalled();
  });
});
