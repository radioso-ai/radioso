import { randomUUID } from "node:crypto";

import { describe, expect, it, vi } from "vitest";
import { z } from "zod";

vi.mock("../../../src/modules/routines/public.js", async (importOriginal) => ({
  ...await importOriginal<typeof import("../../../src/modules/routines/public.js")>(),
  routineToPortableDocument: vi.fn(),
}));

import {
  OperatorCopilotService,
  copilotProposalTargetTypes,
  CopilotAuthorizationError,
  type CopilotConversation,
  type CopilotMessage,
  type CopilotProposal,
  type CopilotProposalApplyClaimGuard,
  type CopilotProposalClaim,
  type CopilotProposalTargetType,
  type CopilotRepositoryPort,
} from "../../../src/modules/operatorCopilot/public.js";
import { createAgentSettingProposalCopilotTools } from "../../../src/modules/operatorCopilot/tools/agents.js";
import { createAgentSkillConfigProposalCopilotTools } from "../../../src/modules/operatorCopilot/tools/agentSkills.js";
import { createDirectiveProposalCopilotTools } from "../../../src/modules/operatorCopilot/tools/directives.js";
import { createRoutineProposalCopilotTools } from "../../../src/modules/operatorCopilot/tools/routines.js";
import { conflict } from "../../../src/shared/domain/errors.js";

const workspaceId = randomUUID();
const accountId = randomUUID();
const operatorUserId = randomUUID();
const agentId = randomUUID();
const directiveId = randomUUID();
const workspaceRouteKeyResolver = { resolveWorkspaceKey: async () => "workspace" };
const currentAuthorization = { hasAllPermissions: async () => true };

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
    const audit = auditService();
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
      auditService: audit,
      prompt: "system",
      workspaceRouteKeyResolver,
      currentAuthorization,
      tools: [tool("propose_directive", "workspace.agents.manage")],
    });

    const events = [];
    for await (const event of service.runTurn({
      surface: "dashboard", workspaceId,
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

  // Regression for the isProposalOutput/narrowTargetType drift: a target type accepted by the
  // repository and the tool catalog but missing from the service's own output guard is silently
  // dropped — the DB row exists, but the operator never sees a card. Every registered target type
  // must round-trip through proposalFromTrace into a persisted card, not just the ones a hand
  // written OR-chain happened to list.
  it.each(copilotProposalTargetTypes)("emits a proposal event and card for a %s draft, not just a subset of target types", async (targetType: CopilotProposalTargetType) => {
    const repository = new MemoryProposalRepository();
    const conversation = await repository.createConversation({ workspaceId, operatorUserId, title: "Draft it" });
    const proposal = await repository.createProposal({
      workspaceId,
      operatorUserId,
      conversationId: conversation.id,
      targetType,
      targetRef: { agentId },
      payload: { name: "Example" },
      versionToken: "version-1",
      evidence: null,
    });
    const service = new OperatorCopilotService({
      repository,
      capabilityRunner: {
        runStreaming: () => ({
          events: (async function* () {
            yield { kind: "tool_call_invoked" as const, stepIndex: 0, toolName: "propose_x", callId: "draft-1", at: 1 };
            yield {
              kind: "tool_call_completed" as const,
              stepIndex: 0,
              toolName: "propose_x",
              callId: "draft-1",
              output: { proposalId: proposal.id, targetType, targetLabel: "Example", summary: "Draft change" },
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
      currentAuthorization,
      tools: [tool("propose_x", "workspace.agents.manage")],
    });

    const events = [];
    for await (const event of service.runTurn({
      surface: "dashboard", workspaceId,
      accountId,
      operatorUserId,
      conversationId: conversation.id,
      message: "Draft it",
      pageContext: { view: "agent", agentId, conversationId: null, selection: null, entities: [] },
      permissions: new Set(["workspace.agents.manage"]),
    })) events.push(event);

    expect(events).toContainEqual({ event: "proposal", data: { proposalId: proposal.id, targetType, targetLabel: "Example", summary: "Draft change" } });
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
          validatePayload: vi.fn(async (_workspaceId, targetRef, payload) => ({ targetRef, payload, versionToken: "agent-version" })),
        },
        { targetType: "routine", readVersionToken: vi.fn(), preview: vi.fn(), applyIfVersionMatches: vi.fn(), draft: vi.fn(), draftEdit: vi.fn(), draftLifecycle: vi.fn() },
      ],
      auditService: auditService(),
    });
    const context = { workspaceId, accountId, operatorUserId, copilotConversationId: "conversation-1", currentAuthorization, pageContext: { view: "agent" as const, agentId, conversationId: null, selection: null, entities: [] } };

    expect(descriptors.map(({ name, shape }) => ({ name, shape }))).toEqual([
      { name: "propose_directive", shape: "propose" },
      { name: "propose_directive_removal", shape: "propose" },
      { name: "propose_directive_enablement", shape: "propose" },
      { name: "propose_routine", shape: "propose" },
      { name: "propose_routine_edit", shape: "propose" },
      { name: "propose_routine_lifecycle", shape: "propose" },
      { name: "propose_agent_setting", shape: "propose" },
    ]);

    await descriptors.find((descriptor) => descriptor.name === "propose_directive")?.createTool(context).invoke({ directiveId, intent: "Do not recommend competitors" }, {} as never);
    await descriptors.find((descriptor) => descriptor.name === "propose_agent_setting")?.createTool(context).invoke({ settingKey: "retrievalEnabled", value: false }, {} as never);

    expect(createProposal).toHaveBeenCalledTimes(2);
    expect(createProposal.mock.calls[0]?.[0]).toMatchObject({ targetType: "directive", targetRef: { agentId, directiveId }, versionToken: "directive-version" });
    expect(createProposal.mock.calls[1]?.[0]).toMatchObject({ targetType: "agent_setting", targetRef: { agentId, settingKey: "retrievalEnabled" }, versionToken: "agent-version" });
  });

  it("creates a reversible directive enablement proposal after reading its version first", async () => {
    const createProposal = vi.fn(async (input: Parameters<MemoryProposalRepository["createProposal"]>[0]) => ({
      id: randomUUID(), ...input, messageId: null, status: "pending" as const, appliedRef: null, createdAt: new Date(), updatedAt: new Date(),
    }));
    const readVersionToken = vi.fn(async () => "directive-version");
    const preview = vi.fn(async () => ({
      targetLabel: "Avoid competitors",
      current: { id: directiveId, name: "Avoid competitors", enabled: true },
      proposed: { id: directiveId, name: "Avoid competitors", enabled: false },
    }));
    const descriptors = createDirectiveProposalCopilotTools({
      proposalRepository: { createProposal },
      proposalEvidence: unmeasured(),
      proposalAdapters: [{ targetType: "directive", readVersionToken, preview, applyIfVersionMatches: vi.fn(), draft: vi.fn() }],
      auditService: auditService(),
    });
    const context = { workspaceId, accountId, operatorUserId, copilotConversationId: "conversation-1", currentAuthorization, pageContext: { view: "agent" as const, agentId, conversationId: null, selection: null, entities: [] } };

    const result = await descriptors.find((descriptor) => descriptor.name === "propose_directive_enablement")?.createTool(context).invoke({ directiveId, agentId, enabled: false }, {} as never);

    expect(readVersionToken).toHaveBeenCalledBefore(preview);
    expect(createProposal).toHaveBeenCalledWith(expect.objectContaining({
      targetType: "directive",
      targetRef: { agentId, directiveId },
      versionToken: "directive-version",
      payload: { op: "set_enabled", enabled: false, name: "Avoid competitors", rationale: expect.any(String) },
    }));
    expect(result).toMatchObject({ targetType: "directive", targetLabel: "Avoid competitors" });
    expect(result).not.toHaveProperty("removal");
  });

  it("refuses directive enablement proposals that match the directive's current state", async () => {
    const createProposal = vi.fn();
    const preview = vi.fn()
      .mockResolvedValueOnce({
        targetLabel: "Avoid competitors",
        current: { id: directiveId, name: "Avoid competitors", enabled: true },
        proposed: { id: directiveId, name: "Avoid competitors", enabled: true },
      })
      .mockResolvedValueOnce({
        targetLabel: "Avoid competitors",
        current: { id: directiveId, name: "Avoid competitors", enabled: false },
        proposed: { id: directiveId, name: "Avoid competitors", enabled: false },
      });
    const descriptors = createDirectiveProposalCopilotTools({
      proposalRepository: { createProposal },
      proposalEvidence: unmeasured(),
      proposalAdapters: [{ targetType: "directive", readVersionToken: vi.fn(async () => "directive-version"), preview, applyIfVersionMatches: vi.fn(), draft: vi.fn() }],
      auditService: auditService(),
    });
    const context = { workspaceId, accountId, operatorUserId, copilotConversationId: "conversation-1", currentAuthorization, pageContext: { view: "agent" as const, agentId, conversationId: null, selection: null, entities: [] } };
    const tool = descriptors.find((descriptor) => descriptor.name === "propose_directive_enablement")?.createTool(context);

    await expect(tool?.invoke({ directiveId, agentId, enabled: true }, {} as never))
      .rejects.toThrow(/already enabled/i);
    await expect(tool?.invoke({ directiveId, agentId, enabled: false }, {} as never))
      .rejects.toThrow(/already disabled/i);
    expect(createProposal).not.toHaveBeenCalled();
  });

  it("creates a pending removal proposal for an existing directive, drafting nothing", async () => {
    const createProposal = vi.fn(async (input: Parameters<MemoryProposalRepository["createProposal"]>[0]) => ({
      id: randomUUID(), ...input, messageId: null, status: "pending" as const, appliedRef: null, createdAt: new Date(), updatedAt: new Date(),
    }));
    const draft = vi.fn();
    const descriptors = createDirectiveProposalCopilotTools({
      proposalRepository: { createProposal },
      proposalEvidence: unmeasured(),
      proposalAdapters: [
        {
          targetType: "directive",
          readVersionToken: vi.fn(async () => "directive-version"),
          preview: vi.fn(async () => ({ targetLabel: "Avoid competitors", current: { id: directiveId, name: "Avoid competitors" }, proposed: "This directive will be permanently removed." })),
          applyIfVersionMatches: vi.fn(),
          draft,
        },
      ],
      auditService: auditService(),
    });
    const context = { workspaceId, accountId, operatorUserId, copilotConversationId: "conversation-1", currentAuthorization, pageContext: { view: "agent" as const, agentId, conversationId: null, selection: null, entities: [] } };

    const result = await descriptors.find((descriptor) => descriptor.name === "propose_directive_removal")?.createTool(context).invoke({ directiveId, agentId }, {} as never);

    expect(draft).not.toHaveBeenCalled();
    expect(createProposal).toHaveBeenCalledWith(expect.objectContaining({
      targetType: "directive",
      targetRef: { agentId, directiveId },
      versionToken: "directive-version",
      payload: expect.objectContaining({ op: "remove" }),
    }));
    expect(result).toMatchObject({ targetType: "directive", targetLabel: "Avoid competitors" });
    expect((result as { summary: string }).summary).toMatch(/permanently|cannot be undone/i);
    // Finding 1 (issue triage, next-ray-epic-issue): the operator-facing card must carry a
    // structural removal signal of its own, not just a summary sentence Ray happened to phrase
    // as irreversible - so the confirmation dialog can state plainly that Apply deletes the
    // directive without parsing prose.
    expect((result as { removal?: boolean }).removal).toBe(true);
  });

  it("fails clearly when asked to remove a directive that does not exist for the resolved agent", async () => {
    const createProposal = vi.fn();
    const descriptors = createDirectiveProposalCopilotTools({
      proposalRepository: { createProposal },
      proposalEvidence: unmeasured(),
      proposalAdapters: [
        {
          targetType: "directive",
          readVersionToken: vi.fn(async () => { throw new Error("Directive no longer exists"); }),
          preview: vi.fn(),
          applyIfVersionMatches: vi.fn(),
          draft: vi.fn(),
        },
      ],
      auditService: auditService(),
    });
    const context = { workspaceId, accountId, operatorUserId, copilotConversationId: "conversation-1", currentAuthorization, pageContext: { view: "agent" as const, agentId, conversationId: null, selection: null, entities: [] } };

    await expect(descriptors.find((descriptor) => descriptor.name === "propose_directive_removal")?.createTool(context).invoke({ directiveId, agentId }, {} as never))
      .rejects.toThrow(/no longer exists/i);
    expect(createProposal).not.toHaveBeenCalled();
  });

  it("creates a pending routine proposal from the authored assist draft", async () => {
    const createProposal = vi.fn(async (input: Parameters<MemoryProposalRepository["createProposal"]>[0]) => ({
      id: randomUUID(), ...input, messageId: null, status: "pending" as const, appliedRef: null, createdAt: new Date(), updatedAt: new Date(),
    }));
    const payload = { name: "Return intake", steps: [] };
    const routineDraft = vi.fn(async () => ({ payload, targetLabel: "Return intake", summary: "Draft routine Return intake has 2 open validation diagnostics.", diagnostics: [] }));
    const descriptors = createProposalTools({
      proposalRepository: { createProposal },
      proposalEvidence: unmeasured(),
      proposalAdapters: [
        { targetType: "directive", readVersionToken: vi.fn(), preview: vi.fn(), applyIfVersionMatches: vi.fn(), draft: vi.fn() },
        { targetType: "agent_setting", readVersionToken: vi.fn(), preview: vi.fn(), applyIfVersionMatches: vi.fn(), validatePayload: vi.fn() },
        { targetType: "routine", readVersionToken: vi.fn(async () => "agent-version"), preview: vi.fn(), applyIfVersionMatches: vi.fn(), draft: routineDraft, draftEdit: vi.fn(), draftLifecycle: vi.fn() },
      ],
      auditService: auditService(),
    });
    const context = { workspaceId, accountId, operatorUserId, copilotConversationId: "conversation-1", currentAuthorization, pageContext: { view: "agent" as const, agentId, conversationId: null, selection: null, entities: [] } };

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

  it("does not persist a drafted proposal after manage authority is revoked", async () => {
    const createProposal = vi.fn(async (input: Parameters<MemoryProposalRepository["createProposal"]>[0]) => ({
      id: randomUUID(),
      ...input,
      messageId: null,
      status: "pending" as const,
      appliedRef: null,
      createdAt: new Date(),
      updatedAt: new Date(),
    }));
    const draft = vi.fn(async () => ({ payload: { name: "Avoid competitors" }, targetLabel: "Avoid competitors", summary: "Draft directive" }));
    const [descriptor] = createDirectiveProposalCopilotTools({
      proposalRepository: { createProposal },
      proposalEvidence: unmeasured(),
      proposalAdapters: [{ targetType: "directive", readVersionToken: vi.fn(async () => "directive-version"), preview: vi.fn(), applyIfVersionMatches: vi.fn(), draft }],
      auditService: auditService(),
    });
    const authorization = vi.fn()
      .mockResolvedValueOnce(true)
      .mockResolvedValueOnce(true)
      .mockResolvedValueOnce(true)
      .mockResolvedValueOnce(false);
    const context = {
      workspaceId,
      accountId,
      operatorUserId,
      copilotConversationId: "conversation-1",
      currentAuthorization: { hasAllPermissions: authorization },
      pageContext: { view: "agent" as const, agentId, conversationId: null, selection: null, entities: [] },
    };

    await expect(descriptor!.createTool(context).invoke({ intent: "Do not recommend competitors" }, {} as never))
      .rejects.toThrow(/authorization/i);

    expect(draft).toHaveBeenCalledOnce();
    expect(createProposal).not.toHaveBeenCalled();
  });

  it("does not persist an agent setting proposal after manage authority is revoked", async () => {
    const createProposal = vi.fn();
    const validatePayload = vi.fn(async (_workspaceId, targetRef, payload) => ({ targetRef, payload, versionToken: "agent-version" }));
    const [descriptor] = createAgentSettingProposalCopilotTools({
      proposalRepository: { createProposal },
      proposalEvidence: unmeasured(),
      proposalAdapters: [{ targetType: "agent_setting", validatePayload, readVersionToken: vi.fn(async () => "agent-version"), preview: vi.fn(), applyIfVersionMatches: vi.fn() }],
      auditService: auditService(),
    });
    const authorization = vi.fn()
      .mockResolvedValueOnce(true)
      .mockResolvedValueOnce(true)
      .mockResolvedValueOnce(true)
      .mockResolvedValueOnce(false);

    await expect(descriptor!.createTool({
      workspaceId,
      accountId,
      operatorUserId,
      copilotConversationId: "conversation-1",
      currentAuthorization: { hasAllPermissions: authorization },
      pageContext: { view: "agent", agentId, conversationId: null, selection: null, entities: [] },
    }).invoke({ settingKey: "retrievalEnabled", value: false }, {} as never)).rejects.toThrow(/authorization/i);

    expect(validatePayload).toHaveBeenCalledOnce();
    expect(createProposal).not.toHaveBeenCalled();
  });

  it("does not persist a routine edit after the shared proposal tail sees a revocation", async () => {
    const createProposal = vi.fn();
    const draftEdit = vi.fn(async () => ({
      payload: { kind: "edit", name: "Support intake", changes: {} },
      targetLabel: "Support intake",
      summary: "Edit the intake.",
      diagnostics: [],
    }));
    const descriptors = createRoutineProposalCopilotTools({
      proposalRepository: { createProposal },
      proposalEvidence: unmeasured(),
      proposalAdapters: [{ targetType: "routine", readVersionToken: vi.fn(async () => "routine-version"), draftEdit, draftLifecycle: vi.fn(), draft: vi.fn(), preview: vi.fn(), applyIfVersionMatches: vi.fn() }],
      auditService: auditService(),
    });
    const authorization = vi.fn()
      .mockResolvedValueOnce(true)
      .mockResolvedValueOnce(true)
      .mockResolvedValueOnce(true)
      .mockResolvedValueOnce(false);
    const routineEdit = descriptors.find((candidate) => candidate.name === "propose_routine_edit")!;

    await expect(routineEdit.createTool({
      workspaceId,
      accountId,
      operatorUserId,
      copilotConversationId: "conversation-1",
      currentAuthorization: { hasAllPermissions: authorization },
      pageContext: { view: "agent", agentId, conversationId: null, selection: null, entities: [] },
    }).invoke({ routineId: "cccccccc-cccc-4ccc-8ccc-cccccccccccc", changes: { name: "Returns intake" } }, {} as never)).rejects.toThrow(/authorization/i);

    expect(draftEdit).toHaveBeenCalledOnce();
    expect(createProposal).not.toHaveBeenCalled();
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
      currentAuthorization,
      tools: [],
      proposalAdapters: [{ targetType: "directive", readVersionToken: vi.fn(async () => "new"), preview: vi.fn(), applyIfVersionMatches }],
    });

    expect(await service.applyProposal({ surface: "dashboard", workspaceId, accountId, operatorUserId, proposalId: proposal.id })).toEqual({ status: "stale" });
    expect(applyIfVersionMatches).toHaveBeenCalledOnce();
    expect((await repository.findProposal({ id: proposal.id, workspaceId, operatorUserId }))?.status).toBe("stale");
    expect(audit.record).toHaveBeenCalledWith(expect.objectContaining({ eventType: "copilot.proposal.apply_failed", metadata: expect.objectContaining({ outcome: "stale" }) }));
  });

  it("does not claim or mutate a pending proposal after current manage authority is revoked", async () => {
    const repository = new MemoryProposalRepository();
    const proposal = await repository.createProposal({ workspaceId, operatorUserId, conversationId: "conversation-1", targetType: "directive", targetRef: { agentId, directiveId }, payload: { name: "Updated" }, versionToken: "current", evidence: null });
    const applyIfVersionMatches = vi.fn(async () => ({ outcome: "applied" as const, appliedRef: { directiveId } }));
    const audit = auditService();
    const service = new OperatorCopilotService({
      repository,
      capabilityRunner: { runStreaming: vi.fn() },
      usageLimitPolicy: noLimitPolicy(),
      auditService: audit,
      prompt: "system",
      workspaceRouteKeyResolver,
      tools: [],
      currentAuthorization: { hasAllPermissions: vi.fn(async () => false) },
      proposalAdapters: [{ targetType: "directive", readVersionToken: vi.fn(), preview: vi.fn(), applyIfVersionMatches }],
    });

    await expect(service.applyProposal({ surface: "dashboard", workspaceId, accountId, operatorUserId, proposalId: proposal.id })).rejects.toBeInstanceOf(CopilotAuthorizationError);
    expect(applyIfVersionMatches).not.toHaveBeenCalled();
    expect((await repository.findProposal({ id: proposal.id, workspaceId, operatorUserId }))?.status).toBe("pending");
    expect(audit.record).toHaveBeenCalledWith(expect.objectContaining({
      eventType: "copilot.proposal.apply_denied",
      metadata: { proposalId: proposal.id, outcome: "authorization_denied", operatorUserId, surface: "dashboard" },
    }));
  });

  it("releases the apply claim when authority is revoked after it is claimed", async () => {
    const repository = new MemoryProposalRepository();
    const proposal = await repository.createProposal({ workspaceId, operatorUserId, conversationId: "conversation-1", targetType: "directive", targetRef: { agentId, directiveId }, payload: { name: "Updated" }, versionToken: "current", evidence: null });
    const applyIfVersionMatches = vi.fn(async () => ({ outcome: "applied" as const, appliedRef: { directiveId } }));
    const service = new OperatorCopilotService({
      repository,
      capabilityRunner: { runStreaming: vi.fn() },
      usageLimitPolicy: noLimitPolicy(),
      auditService: auditService(),
      prompt: "system",
      workspaceRouteKeyResolver,
      tools: [],
      currentAuthorization: { hasAllPermissions: vi.fn().mockResolvedValueOnce(true).mockResolvedValueOnce(false).mockResolvedValue(true) },
      proposalAdapters: [{ targetType: "directive", readVersionToken: vi.fn(), preview: vi.fn(), applyIfVersionMatches }],
    });

    await expect(service.applyProposal({ surface: "dashboard", workspaceId, accountId, operatorUserId, proposalId: proposal.id }))
      .rejects.toBeInstanceOf(CopilotAuthorizationError);
    expect(repository.hasApplyClaim(proposal.id)).toBe(false);

    await expect(service.applyProposal({ surface: "dashboard", workspaceId, accountId, operatorUserId, proposalId: proposal.id }))
      .resolves.toEqual({ status: "applied", appliedRef: { directiveId } });
    expect(applyIfVersionMatches).toHaveBeenCalledOnce();
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
      currentAuthorization,
      tools: [],
      proposalAdapters: [{ targetType: "directive", readVersionToken: vi.fn(), preview: vi.fn(), applyIfVersionMatches: vi.fn(async () => { throw new Error("target unavailable"); }) }],
    });

    expect(await service.applyProposal({ surface: "dashboard", workspaceId, accountId, operatorUserId, proposalId: proposal.id })).toEqual({ status: "failed" });
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
      currentAuthorization,
      tools: [],
      proposalAdapters: [{ targetType: "directive", readVersionToken: vi.fn(), preview: vi.fn(), applyIfVersionMatches: vi.fn(async () => ({ outcome: "failed" as const, reason: "Directive validation failed." })) }],
    });

    expect(await service.applyProposal({ surface: "dashboard", workspaceId, accountId, operatorUserId, proposalId: proposal.id })).toEqual({ status: "failed", reason: "Directive validation failed." });
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
      usageLimitPolicy: noLimitPolicy(), auditService: auditService(), prompt: "system", workspaceRouteKeyResolver, currentAuthorization, tools: [tool("propose_routine", "workspace.agents.manage")],
    });

    const events = [];
    for await (const event of service.runTurn({ surface: "dashboard", workspaceId, accountId, operatorUserId, conversationId: conversation.id, message: "Draft it", pageContext: { view: "agent", agentId, conversationId: null, selection: null, entities: [] }, permissions: new Set(["workspace.agents.manage"]) })) events.push(event);

    expect(events).toContainEqual({ event: "proposal", data: { proposalId: proposal.id, targetType: "routine", targetLabel: "Return intake", summary: "Draft routine" } });
  });
});

const tool = (name: string, requiredPermission: "workspace.agents.manage") => ({
  name,
  shape: "propose" as const,
  verificationCost: () => 0,
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
  private readonly applyClaims = new Map<string, Date>();

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
  async updateProposalOutcome(input: { id: string; workspaceId: string; operatorUserId: string; status: CopilotProposal["status"]; appliedRef?: unknown | null; reason?: string | null; applyClaimGuard: CopilotProposalApplyClaimGuard }): Promise<CopilotProposal | null> {
    const proposal = await this.findProposal(input);
    if (!proposal || proposal.status !== "pending") return null;
    if (!this.satisfiesClaimGuard(proposal.id, input.applyClaimGuard)) return null;
    const next = { ...proposal, status: input.status, reason: input.reason ?? null, appliedRef: input.appliedRef ?? null, updatedAt: new Date() };
    this.proposals[this.proposals.indexOf(proposal)] = next;
    this.applyClaims.delete(proposal.id);
    return next;
  }
  async claimProposalApply(input: { id: string; workspaceId: string; operatorUserId: string; claimTtlSeconds: number }): Promise<CopilotProposalClaim | null> {
    const proposal = await this.findProposal(input);
    if (!proposal || proposal.status !== "pending") return null;
    if (!this.isClaimFree(proposal.id, input.claimTtlSeconds)) return null;
    const claimedAt = new Date();
    const previousAttemptStartedAt = this.applyClaims.get(proposal.id) ?? null;
    this.applyClaims.set(proposal.id, claimedAt);
    return { proposal, claimedAt, previousAttemptStartedAt };
  }
  async releaseProposalApplyClaim(input: { id: string; workspaceId: string; operatorUserId: string; claimedAt: Date }): Promise<boolean> {
    const proposal = await this.findProposal(input);
    if (!proposal || proposal.status !== "pending") return false;
    const claimedAt = this.applyClaims.get(proposal.id);
    if (!claimedAt || claimedAt.getTime() !== input.claimedAt.getTime()) return false;
    this.applyClaims.delete(proposal.id);
    return true;
  }
  hasApplyClaim(id: string): boolean { return this.applyClaims.has(id); }
  private isClaimFree(proposalId: string, claimTtlSeconds: number): boolean {
    const claimedAt = this.applyClaims.get(proposalId);
    return !claimedAt || Date.now() - claimedAt.getTime() >= claimTtlSeconds * 1000;
  }
  private satisfiesClaimGuard(proposalId: string, guard: CopilotProposalApplyClaimGuard): boolean {
    if (guard.state === "free") return this.isClaimFree(proposalId, guard.claimTtlSeconds);
    const claimedAt = this.applyClaims.get(proposalId);
    return claimedAt !== undefined && claimedAt.getTime() === guard.claimedAt.getTime();
  }
}

const presentProposal = (proposal: CopilotProposal) => ({ id: proposal.id, targetType: proposal.targetType, targetLabel: proposal.targetType === "directive" || proposal.targetType === "routine" ? String((proposal.payload as { name?: unknown }).name ?? "Routine") : String((proposal.targetRef as { settingKey: string }).settingKey), summary: proposal.targetType === "directive" ? "Draft directive" : proposal.targetType === "routine" ? "Draft routine" : "Draft setting change", status: proposal.status, reason: proposal.reason ?? null });

describe("directive proposal adapter payload mapping", () => {
  it("strips draft-only presentation fields before calling directive management", async () => {
    const { createDirectiveCopilotProposalAdapter } = await import("../../../src/modules/operatorCopilot/proposalAdapters.js");
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

  it("treats a payload with no operation discriminator as a save, even when it targets an existing directive", async () => {
    // Every proposal persisted before removal support carries a bare directive payload with no
    // `op` field. This is the regression that matters: a live workspace's pending proposals must
    // keep applying as saves, not start being misread as removals.
    const { createDirectiveCopilotProposalAdapter } = await import("../../../src/modules/operatorCopilot/proposalAdapters.js");
    const existing = { id: "6a6a6a6a-1111-2222-3333-444444444445", agentId: "6a6a6a6a-1111-2222-3333-444444444444", name: "Old name", condition: { kind: "always" }, action: "Old action", priority: null, requiredCapabilities: [], dependsOn: [], excludes: [], routes: [], tags: [], description: null, binding: null, lifecycle: null, metadata: {}, createdAt: new Date(0), updatedAt: new Date(0) };
    const update = vi.fn(async () => ({ directive: { id: "6a6a6a6a-1111-2222-3333-444444444445" }, coherence: null }));
    const deleteDirective = vi.fn();
    const adapter = createDirectiveCopilotProposalAdapter({
      authoredDirectiveService: { list: vi.fn(async () => [existing]), create: vi.fn(), update, delete: deleteDirective } as never,
      directiveAuthorService: { draft: vi.fn() } as never,
      agentService: { get: vi.fn(async () => ({ updatedAt: new Date(0) })) } as never,
    });

    const result = await adapter.applyIfVersionMatches(
      "workspace-1",
      { agentId: "6a6a6a6a-1111-2222-3333-444444444444", directiveId: "6a6a6a6a-1111-2222-3333-444444444445" },
      { name: "New name", condition: { kind: "always" }, action: "New action", tags: [] },
      new Date(0).toISOString(),
    );

    expect(result).toEqual({ outcome: "applied", appliedRef: { directiveId: "6a6a6a6a-1111-2222-3333-444444444445" } });
    expect(update).toHaveBeenCalledOnce();
    expect(deleteDirective).not.toHaveBeenCalled();
  });

  it("removes a directive when the version token matches, and never deletes when it is stale", async () => {
    const { createDirectiveCopilotProposalAdapter } = await import("../../../src/modules/operatorCopilot/proposalAdapters.js");
    const currentUpdatedAt = new Date(5);
    // Mirrors AuthoredDirectiveService.delete: the version check is enforced by the delete call
    // itself (via expectedUpdatedAt), not by a read-then-compare the adapter runs beforehand.
    const deleteDirective = vi.fn(async (_workspaceId: string, _agentId: string, _directiveId: string, options?: { expectedUpdatedAt?: Date }) => {
      if (options?.expectedUpdatedAt && options.expectedUpdatedAt.getTime() !== currentUpdatedAt.getTime()) {
        throw conflict("Directive was updated by another writer; reload before saving again");
      }
    });
    const adapter = createDirectiveCopilotProposalAdapter({
      authoredDirectiveService: { list: vi.fn(async () => []), create: vi.fn(), update: vi.fn(), delete: deleteDirective } as never,
      directiveAuthorService: { draft: vi.fn() } as never,
      agentService: { get: vi.fn(async () => ({ updatedAt: currentUpdatedAt })) } as never,
    });
    const targetRef = { agentId: "6a6a6a6a-1111-2222-3333-444444444444", directiveId: "6a6a6a6a-1111-2222-3333-444444444445" };

    // A stale token races an edit made after the proposal drafted. Deleting here would discard
    // whatever changed the directive between drafting and apply, so it must be refused outright.
    expect(await adapter.applyIfVersionMatches("workspace-1", targetRef, { op: "remove" }, new Date(0).toISOString())).toEqual({ outcome: "stale" });

    expect(await adapter.applyIfVersionMatches("workspace-1", targetRef, { op: "remove" }, new Date(5).toISOString())).toEqual({ outcome: "applied", appliedRef: { directiveId: "6a6a6a6a-1111-2222-3333-444444444445" } });
    expect(deleteDirective).toHaveBeenCalledWith("workspace-1", targetRef.agentId, "6a6a6a6a-1111-2222-3333-444444444445", { expectedUpdatedAt: new Date(5) });
  });

  it("previews a removal as the directive in place today, next to a plain removal notice", async () => {
    const { createDirectiveCopilotProposalAdapter } = await import("../../../src/modules/operatorCopilot/proposalAdapters.js");
    const existing = { id: "6a6a6a6a-1111-2222-3333-444444444445", agentId: "6a6a6a6a-1111-2222-3333-444444444444", name: "Avoid competitors", condition: { kind: "always" }, action: "Say nothing about rivals.", priority: null, requiredCapabilities: [], dependsOn: [], excludes: [], routes: [], tags: [], description: null, binding: null, lifecycle: null, metadata: {}, createdAt: new Date(0), updatedAt: new Date(0) };
    const adapter = createDirectiveCopilotProposalAdapter({
      authoredDirectiveService: { list: vi.fn(async () => [existing]), create: vi.fn(), update: vi.fn(), delete: vi.fn() } as never,
      directiveAuthorService: { draft: vi.fn() } as never,
      agentService: { get: vi.fn() } as never,
    });

    const preview = await adapter.preview("workspace-1", { agentId: "6a6a6a6a-1111-2222-3333-444444444444", directiveId: "6a6a6a6a-1111-2222-3333-444444444445" }, { op: "remove" });

    expect(preview.targetLabel).toBe("Avoid competitors");
    expect(preview.current).toEqual(existing);
    // A record-shaped current next to an undefined/null proposed would make the generic diff
    // renderer expand every field of the directive as individually "removed" rather than stating
    // the removal once, legibly.
    expect(preview.proposed).not.toBeNull();
    expect(preview.proposed).not.toBeUndefined();
    expect(typeof preview.proposed).toBe("string");
    expect(preview.proposed as string).toMatch(/remov/i);
  });

  it("previews and applies a set_enabled payload as a one-field partial update", async () => {
    const { createDirectiveCopilotProposalAdapter } = await import("../../../src/modules/operatorCopilot/proposalAdapters.js");
    const existing = {
      id: "6a6a6a6a-1111-2222-3333-444444444445", agentId: "6a6a6a6a-1111-2222-3333-444444444444", name: "Avoid competitors", condition: { kind: "always" }, action: "Say nothing about rivals.", priority: 80,
      requiredCapabilities: ["retrieve"], dependsOn: ["base-rule"], excludes: ["other-rule"], routes: [], tags: ["sales"], description: "Keep the configured text.", binding: { kind: "skill", skillName: "order.lookup" }, lifecycle: { kind: "cooldown", turns: 3 }, enabled: true, metadata: { source: "operator" }, createdAt: new Date(0), updatedAt: new Date(0),
    };
    const update = vi.fn(async () => ({ directive: { ...existing, enabled: false }, coherence: null }));
    const adapter = createDirectiveCopilotProposalAdapter({
      authoredDirectiveService: { list: vi.fn(async () => [existing]), create: vi.fn(), update, delete: vi.fn() } as never,
      directiveAuthorService: { draft: vi.fn() } as never,
      agentService: { get: vi.fn() } as never,
    });
    const targetRef = { agentId: existing.agentId, directiveId: existing.id };

    await expect(adapter.preview("workspace-1", targetRef, { op: "set_enabled", enabled: false })).resolves.toEqual({
      targetLabel: "Avoid competitors",
      current: existing,
      proposed: { ...existing, enabled: false },
    });
    await expect(adapter.applyIfVersionMatches("workspace-1", targetRef, { op: "set_enabled", enabled: false }, new Date(0).toISOString()))
      .resolves.toEqual({ outcome: "applied", appliedRef: { directiveId: existing.id } });
    expect(update).toHaveBeenCalledWith("workspace-1", existing.agentId, existing.id, { enabled: false }, { expectedUpdatedAt: new Date(0) });
  });

  it("previews a set_enabled proposal for a deleted directive as a stale notice", async () => {
    const { createDirectiveCopilotProposalAdapter } = await import("../../../src/modules/operatorCopilot/proposalAdapters.js");
    const adapter = createDirectiveCopilotProposalAdapter({
      authoredDirectiveService: { list: vi.fn(async () => []), create: vi.fn(), update: vi.fn(), delete: vi.fn() } as never,
      directiveAuthorService: { draft: vi.fn() } as never,
      agentService: { get: vi.fn() } as never,
    });

    await expect(adapter.preview(
      "workspace-1",
      { agentId: "6a6a6a6a-1111-2222-3333-444444444444", directiveId: "6a6a6a6a-1111-2222-3333-444444444445" },
      { op: "set_enabled", enabled: false, name: "Avoid competitors" },
    )).resolves.toEqual({
      targetLabel: "Avoid competitors",
      current: null,
      proposed: "This directive no longer exists, so this change cannot be applied.",
    });
  });

  it("maps a stale set_enabled write to stale and preserves the service validation reason on re-enable", async () => {
    const { createDirectiveCopilotProposalAdapter } = await import("../../../src/modules/operatorCopilot/proposalAdapters.js");
    const targetRef = { agentId: "6a6a6a6a-1111-2222-3333-444444444444", directiveId: "6a6a6a6a-1111-2222-3333-444444444445" };
    const update = vi.fn()
      .mockRejectedValueOnce(conflict("Directive was updated by another writer; reload before saving again"))
      .mockResolvedValueOnce({ directive: { id: targetRef.directiveId, enabled: false }, coherence: null })
      .mockRejectedValueOnce(new Error('Directive binding skill "order.lookup" is disabled'));
    const adapter = createDirectiveCopilotProposalAdapter({
      authoredDirectiveService: { list: vi.fn(async () => []), create: vi.fn(), update, delete: vi.fn() } as never,
      directiveAuthorService: { draft: vi.fn() } as never,
      agentService: { get: vi.fn() } as never,
    });

    await expect(adapter.applyIfVersionMatches("workspace-1", targetRef, { op: "set_enabled", enabled: false }, new Date(0).toISOString()))
      .resolves.toEqual({ outcome: "stale" });
    await expect(adapter.applyIfVersionMatches("workspace-1", targetRef, { op: "set_enabled", enabled: false }, new Date(0).toISOString()))
      .resolves.toEqual({ outcome: "applied", appliedRef: { directiveId: targetRef.directiveId } });
    await expect(adapter.applyIfVersionMatches("workspace-1", targetRef, { op: "set_enabled", enabled: true }, new Date(0).toISOString()))
      .resolves.toEqual({ outcome: "failed", reason: 'Directive binding skill "order.lookup" is disabled' });
  });
});

describe("routine proposal adapter", () => {
  it("keeps authored assist payload intact and creates a draft even when an unrelated agent edit lands first", async () => {
    const { createRoutineCopilotProposalAdapter } = await import("../../../src/modules/operatorCopilot/proposalAdapters.js");
    const payload = routineDraftPayload();
    const draft = vi.fn(async () => ({ draft: payload, validation: { ok: false, diagnostics: [{ code: "missing_transition" }] } }));
    const createDraft = vi.fn(async () => ({ routine: { id: "routine-1", status: "draft" } }));
    const agentService = { get: vi.fn(async () => ({ updatedAt: new Date(0) })) };
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
      diagnostics: [{ code: "missing_transition" }],
    });
    const preview = await adapter.preview("workspace-1", targetRef, storedPayload) as { targetLabel: string; current: unknown; proposed: { steps: Record<string, { instruction: string }> } };
    expect(preview.targetLabel).toBe("Return intake");
    expect(preview.current).toBeNull();
    // A new routine previews element by element too, so the card shows one row per step rather
    // than one row holding the whole graph.
    expect(preview.proposed.steps.step_collect_reason!.instruction).toBe("Ask for {{slot.reason}}.");

    // The token was minted against the agent's updatedAt at draft time, and something unrelated
    // to this routine (a different agent-setting proposal, say) has since touched the agent row -
    // createDraft never touches it, so this must not block a legitimate first-time create.
    expect(await adapter.applyIfVersionMatches("workspace-1", targetRef, storedPayload, new Date(1).toISOString())).toEqual({
      outcome: "applied",
      appliedRef: { agentId: targetRef.agentId, routineId: "routine-1" },
    });
    expect(createDraft).toHaveBeenCalledWith("workspace-1", targetRef.agentId, payload);
  });

  it("reports stale, not a duplicate success, when a create apply is retried after the routine already exists", async () => {
    const { createRoutineCopilotProposalAdapter } = await import("../../../src/modules/operatorCopilot/proposalAdapters.js");
    const payload = routineDraftPayload();
    // Mirrors RoutineDefinitionService.createDraft: the first call succeeds, and a second call
    // for the exact same name+version (a crash-recovery replay of the same apply) collides on
    // the routine_definition_agent_id_name_version_key constraint and is turned into a conflict.
    const createDraft = vi.fn()
      .mockResolvedValueOnce({ routine: { id: "routine-1", status: "draft" } })
      .mockRejectedValueOnce(conflict("A routine definition with this name and version already exists for this agent"));
    const agentService = { get: vi.fn(async () => ({ updatedAt: new Date(0) })) };
    const adapter = createRoutineCopilotProposalAdapter({
      agentService: agentService as never,
      routineDraftAssistService: {} as never,
      routineDefinitionService: { createDraft } as never,
    });
    const targetRef = { agentId: "6a6a6a6a-1111-2222-3333-444444444444", routineId: null };
    const token = new Date(0).toISOString();

    expect(await adapter.applyIfVersionMatches("workspace-1", targetRef, payload, token)).toEqual({
      outcome: "applied",
      appliedRef: { agentId: targetRef.agentId, routineId: "routine-1" },
    });
    expect(await adapter.applyIfVersionMatches("workspace-1", targetRef, payload, token)).toEqual({ outcome: "stale" });
    expect(createDraft).toHaveBeenCalledTimes(2);
  });

  it("does not report a create proposal stale after an unrelated agent edit, but does once a routine of that name now exists", async () => {
    const { createRoutineCopilotProposalAdapter } = await import("../../../src/modules/operatorCopilot/proposalAdapters.js");
    const payload = routineDraftPayload();
    const agentService = { get: vi.fn(async () => ({ updatedAt: new Date(0) })) };
    let existingRoutines: Array<{ id: string; name: string; version: number; status: string; updatedAt: Date }> = [];
    const list = vi.fn(async () => existingRoutines);
    const adapter = createRoutineCopilotProposalAdapter({
      agentService: agentService as never,
      routineDraftAssistService: {} as never,
      routineDefinitionService: { list } as never,
    });
    const targetRef = { agentId: "6a6a6a6a-1111-2222-3333-444444444444", routineId: null };

    const token = await adapter.readVersionToken("workspace-1", targetRef, payload);

    // createDraft never touches the agent row - only the routine_definition_agent_id_name_version_key
    // constraint decides whether Apply would still succeed - so an unrelated agent edit (a
    // directive proposal, a setting change, ...) landing between draft and this GET-time recompute
    // must not flip a legitimate create stale.
    agentService.get.mockResolvedValueOnce({ updatedAt: new Date(999) });
    expect(await adapter.readVersionToken("workspace-1", targetRef, payload)).toBe(token);

    // Someone else creates a routine with the exact name (and starting version) this proposal
    // would take - the one thing that would actually make Apply's own createDraft reject it.
    existingRoutines = [{ id: "routine-collider", name: payload.name, version: 1, status: "draft", updatedAt: new Date(1) }];
    expect(await adapter.readVersionToken("workspace-1", targetRef, payload)).not.toBe(token);
  });

  it("keeps duplicate identities visible when previewing a new invalid routine", async () => {
    const { createRoutineCopilotProposalAdapter } = await import("../../../src/modules/operatorCopilot/proposalAdapters.js");
    const payload = routineDraftPayload();
    const duplicated = {
      ...payload,
      slots: [...payload.slots, { ...payload.slots[0]!, stableSlotId: "slot_reason_copy", ordinal: 1 }],
      steps: [...payload.steps, { ...payload.steps[0]!, instruction: "Ask a second time.", ordinal: 1 }],
      terminals: [...payload.terminals, { ...payload.terminals[0]!, instruction: "A second ending.", ordinal: 2 }],
    };
    const adapter = createRoutineCopilotProposalAdapter({
      agentService: {} as never,
      routineDraftAssistService: {} as never,
      routineDefinitionService: {} as never,
    });

    const preview = await adapter.preview("workspace-1", {
      agentId: "6a6a6a6a-1111-2222-3333-444444444444",
      routineId: null,
    }, duplicated) as {
      proposed: {
        slots: Record<string, unknown>;
        steps: Record<string, unknown>;
        terminals: Record<string, unknown>;
      };
    };

    expect(Object.keys(preview.proposed.slots)).toEqual(["reason", "reason #1"]);
    expect(Object.keys(preview.proposed.steps)).toEqual(["step_collect_reason", "step_collect_reason #1"]);
    expect(Object.keys(preview.proposed.terminals)).toEqual(["terminal_complete", "terminal_complete #2"]);
  });
});

describe("agent skill config proposal adapter", () => {
  const agentSkillAgentId = "6a6a6a6a-1111-2222-3333-444444444444";
  const existingSkillId = "6a6a6a6a-1111-2222-3333-444444444445";

  const buildAdapter = async (overrides: {
    agentSkills?: Array<{ id: string; name: string; capability: string; target: { kind: string | null; id: string | null }; config: Record<string, unknown>; invocationMode: string; enabled: boolean; updatedAt: string }>;
    agentUpdatedAt?: Date;
    create?: ReturnType<typeof vi.fn>;
    update?: ReturnType<typeof vi.fn>;
  } = {}) => {
    const { createAgentSkillCopilotProposalAdapter } = await import("../../../src/modules/operatorCopilot/proposalAdapters.js");
    const { createDefaultSkillCapabilityRegistry } = await import("../../../src/modules/skills/public.js");
    const { AgentSkillsService } = await import("../../../src/modules/agentSkills/public.js");
    const list = vi.fn(async () => overrides.agentSkills ?? []);
    const create = overrides.create ?? vi.fn(async () => ({ id: "created-skill-1" }));
    const update = overrides.update ?? vi.fn(async () => ({ id: existingSkillId }));
    const agentService = { get: vi.fn(async () => ({ id: agentSkillAgentId, updatedAt: overrides.agentUpdatedAt ?? new Date(0) })) };
    const capabilities = createDefaultSkillCapabilityRegistry();
    // dryRunValidate is the real module-owned validation (target-kind match, invocation-mode
    // support, capability config schema, name/shape) - these tests exercise it for real rather
    // than re-stating its rules as a mock. It only needs the async name- and default-answer-
    // uniqueness checks answered; none of these tests seed a conflicting name or default-answer
    // skill.
    const validationService = new AgentSkillsService({
      repository: { findByName: vi.fn(async () => null), findDefaultAnswer: vi.fn(async () => null) } as never,
      capabilities,
    });
    const adapter = createAgentSkillCopilotProposalAdapter({
      agentService: agentService as never,
      agentSkillsService: { list, create, update, dryRunValidate: validationService.dryRunValidate.bind(validationService) } as never,
      skillCapabilityRegistry: capabilities,
    });
    return { adapter, list, create, update, agentService };
  };

  it("validates a brand-new retrieve skill and creates it even when an unrelated agent edit lands first", async () => {
    const { adapter, create, agentService } = await buildAdapter();
    const targetRef = { agentId: agentSkillAgentId, skillId: null };

    const validated = await adapter.validatePayload("workspace-1", targetRef, {
      name: "faq_search",
      capability: "retrieve",
      config: { vectorTopK: 40 },
    });
    expect(validated.payload).toMatchObject({ name: "faq_search", capability: "retrieve", invocationMode: "default_answer", enabled: true, config: expect.objectContaining({ vectorTopK: 40 }) });
    // No existing skill blocks this name (or invocation mode) yet, so the token says "open" -
    // not the agent's updatedAt, which create() never touches.
    expect(validated.versionToken).toBe("open");

    // Something unrelated to this skill has since touched the agent row - create never touches
    // it, so this must not block a legitimate first-time create.
    agentService.get.mockResolvedValueOnce({ id: agentSkillAgentId, updatedAt: new Date(1) });
    const applied = await adapter.applyIfVersionMatches("workspace-1", targetRef, validated.payload, validated.versionToken);
    expect(applied).toEqual({ outcome: "applied", appliedRef: { agentId: agentSkillAgentId, skillId: "created-skill-1" } });
    expect(create).toHaveBeenCalledWith("workspace-1", agentSkillAgentId, expect.objectContaining({ name: "faq_search", capability: "retrieve" }));
  });

  it("reports stale, not a duplicate success, when a create apply is retried after the skill already exists", async () => {
    const create = vi.fn()
      .mockResolvedValueOnce({ id: "created-skill-1" })
      // Mirrors AgentSkillsService.create: a second call for the same name (a crash-recovery
      // replay of the same apply) collides on the service's own findByName check.
      .mockRejectedValueOnce(conflict('A skill named "faq_search" already exists for this agent'));
    const { adapter } = await buildAdapter({ create });
    const targetRef = { agentId: agentSkillAgentId, skillId: null };

    const validated = await adapter.validatePayload("workspace-1", targetRef, {
      name: "faq_search",
      capability: "retrieve",
      config: { vectorTopK: 40 },
    });

    expect(await adapter.applyIfVersionMatches("workspace-1", targetRef, validated.payload, validated.versionToken)).toEqual({
      outcome: "applied",
      appliedRef: { agentId: agentSkillAgentId, skillId: "created-skill-1" },
    });
    expect(await adapter.applyIfVersionMatches("workspace-1", targetRef, validated.payload, validated.versionToken)).toEqual({ outcome: "stale" });
    expect(create).toHaveBeenCalledTimes(2);
  });

  it("merges a proposed config onto the existing skill and updates it by id", async () => {
    const existing = {
      id: existingSkillId,
      name: "notify_ops",
      capability: "notify",
      target: { kind: "notify_delivery", id: null },
      config: { delivery: { recipientEmails: ["ops@example.com"], webhook: null }, exposedInputs: { message: true } },
      invocationMode: "routine_named",
      enabled: true,
      updatedAt: new Date(5).toISOString(),
    };
    // Mirrors AgentSkillsService.update: the version check is enforced by the update call itself
    // (via expectedUpdatedAt), not by a read-then-compare the adapter runs beforehand.
    let currentUpdatedAt = new Date(5);
    const update = vi.fn(async (_workspaceId: string, _agentId: string, _skillId: string, _input: unknown, options?: { expectedUpdatedAt?: Date }) => {
      if (options?.expectedUpdatedAt && options.expectedUpdatedAt.getTime() !== currentUpdatedAt.getTime()) {
        throw conflict("Skill was updated by another writer; reload before saving again");
      }
      return { id: existingSkillId };
    });
    const { adapter } = await buildAdapter({ agentSkills: [existing], update });
    const targetRef = { agentId: agentSkillAgentId, skillId: existingSkillId };

    const validated = await adapter.validatePayload("workspace-1", targetRef, { config: { delivery: { recipientEmails: ["ops@example.com", "escalations@example.com"], webhook: null } } });
    expect(validated.payload).toMatchObject({ name: "notify_ops", capability: "notify" });

    const token = await adapter.readVersionToken("workspace-1", targetRef);
    expect(token).toBe(new Date(5).toISOString());

    const applied = await adapter.applyIfVersionMatches("workspace-1", targetRef, validated.payload, token);
    expect(applied).toEqual({ outcome: "applied", appliedRef: { agentId: agentSkillAgentId, skillId: existingSkillId } });
    expect(update).toHaveBeenCalledWith("workspace-1", agentSkillAgentId, existingSkillId, expect.objectContaining({
      replaceConfig: expect.objectContaining({ delivery: expect.objectContaining({ recipientEmails: ["ops@example.com", "escalations@example.com"] }) }),
    }), { expectedUpdatedAt: new Date(5) });

    // A concurrent edit lands after the token was read: the gated update call itself must refuse,
    // not a pre-read the adapter compared beforehand.
    currentUpdatedAt = new Date(6);
    expect(await adapter.applyIfVersionMatches("workspace-1", targetRef, validated.payload, token)).toEqual({ outcome: "stale" });
  });

  it("refuses a proposal with no capability and no existing skill to infer one from", async () => {
    const { adapter } = await buildAdapter();
    await expect(adapter.validatePayload("workspace-1", { agentId: agentSkillAgentId, skillId: null }, { name: "faq_search" }))
      .rejects.toThrow(/capability/i);
  });

  it("refuses a dependent setting proposed while its parent field is off", async () => {
    // retrieve's rerankTopK settings field depends on rerankEnabled.
    const { adapter } = await buildAdapter();
    await expect(adapter.validatePayload("workspace-1", { agentId: agentSkillAgentId, skillId: null }, {
      name: "faq_search",
      capability: "retrieve",
      config: { rerankTopK: 10 },
    })).rejects.toThrow(/depends on "rerankEnabled"/);
  });

  it("accepts a dependent setting when the same proposal also turns its parent on", async () => {
    const { adapter } = await buildAdapter();
    const validated = await adapter.validatePayload("workspace-1", { agentId: agentSkillAgentId, skillId: null }, {
      name: "faq_search",
      capability: "retrieve",
      config: { rerankEnabled: true, rerankTopK: 10 },
    });
    expect(validated.payload).toMatchObject({ config: expect.objectContaining({ rerankEnabled: true, rerankTopK: 10 }) });
  });

  it("refuses a notify skill with neither a recipient email nor a webhook URL, rather than inventing one", async () => {
    const { adapter } = await buildAdapter();
    await expect(adapter.validatePayload("workspace-1", { agentId: agentSkillAgentId, skillId: null }, {
      name: "notify_ops",
      capability: "notify",
      config: {},
    })).rejects.toThrow(/no recipient email and no webhook URL/);
  });

  it("refuses an unsupported skill capability", async () => {
    const { adapter } = await buildAdapter();
    await expect(adapter.validatePayload("workspace-1", { agentId: agentSkillAgentId, skillId: null }, {
      name: "made_up",
      capability: "not_a_real_capability",
      config: {},
    })).rejects.toThrow(/unsupported skill capability/i);
  });

  // AgentSkillsService.update has no name/capability field at all (agentSkillUpdateSchema.strict()
  // omits them) - there is no rename or re-capability path today. A proposal that claims one would
  // preview cleanly and "apply successfully" while persisting nothing changed about the name or
  // capability, so it must be refused before it is ever stored as a proposal.
  it("refuses a proposal that renames an existing skill, since the update service has no rename path", async () => {
    const existing = {
      id: existingSkillId,
      name: "notify_ops",
      capability: "notify",
      target: { kind: "notify_delivery", id: null },
      config: { delivery: { recipientEmails: ["ops@example.com"], webhook: null }, exposedInputs: { message: true } },
      invocationMode: "routine_named",
      enabled: true,
      updatedAt: new Date(5).toISOString(),
    };
    const { adapter, update } = await buildAdapter({ agentSkills: [existing] });

    await expect(adapter.validatePayload("workspace-1", { agentId: agentSkillAgentId, skillId: existingSkillId }, {
      name: "notify_ops_v2",
    })).rejects.toThrow(/rename|new skill/i);
    expect(update).not.toHaveBeenCalled();
  });

  it("refuses a proposal that changes an existing skill's capability, since the update service has no re-capability path", async () => {
    const existing = {
      id: existingSkillId,
      name: "notify_ops",
      capability: "notify",
      target: { kind: "notify_delivery", id: null },
      config: { delivery: { recipientEmails: ["ops@example.com"], webhook: null }, exposedInputs: { message: true } },
      invocationMode: "routine_named",
      enabled: true,
      updatedAt: new Date(5).toISOString(),
    };
    const { adapter, update } = await buildAdapter({ agentSkills: [existing] });

    await expect(adapter.validatePayload("workspace-1", { agentId: agentSkillAgentId, skillId: existingSkillId }, {
      capability: "retrieve",
    })).rejects.toThrow(/capability|new skill/i);
    expect(update).not.toHaveBeenCalled();
  });

  // agentSkillCreateSchema requires name to match /^[a-z][a-z0-9_]*$/u. The copilot's own
  // skillConfigPayloadSchema only checks non-empty, so a proposal like "FAQ Search" previously
  // passed validatePayload, created a pending card, and failed only when the operator clicked
  // Apply. AgentSkillsService.dryRunValidate now runs that same create schema before the proposal
  // is ever persisted, so the rejection carries the service's own generic message plus the
  // flattened field error rather than a copilot-authored one.
  it("refuses a new skill name the create schema's own format rule will reject, before persisting the proposal", async () => {
    const { adapter, create } = await buildAdapter();
    await expect(adapter.validatePayload("workspace-1", { agentId: agentSkillAgentId, skillId: null }, {
      name: "FAQ Search",
      capability: "retrieve",
      config: {},
    })).rejects.toMatchObject({
      statusCode: 400,
      details: { fieldErrors: { name: [expect.stringMatching(/lowercase/i)] } },
    });
    expect(create).not.toHaveBeenCalled();
  });
});

describe("context variable proposal adapter", () => {
  const contextVariableAgentId = "6b6b6b6b-1111-2222-3333-444444444444";
  const existingVariableId = "6b6b6b6b-1111-2222-3333-444444444445";

  const buildAdapter = async (overrides: {
    variable?: { id: string; workspaceId: string; name: string; description: string | null; valueType: string; trustTier: string; sensitivity: string; defaultSurfacing: string; updatedAt: Date } | null;
    // Every workspace variable a create's own name-collision check should see - defaults to just
    // `variable` (an existing-variable test's usual single row), but a create-collision test can
    // seed one under a different id than the variable (if any) the target ref addresses.
    workspaceVariables?: Array<{ id: string; workspaceId: string; name: string; description: string | null; valueType: string; trustTier: string; sensitivity: string; defaultSurfacing: string; updatedAt: Date }>;
    enablements?: Array<{ id: string; agentId: string; variableId: string; source: string; resolverSkillId: string | null; maxAgeSeconds: number | null; resolverTimeoutMs: number | null; surfacing: string; enabled: boolean; updatedAt: Date }>;
    agentUpdatedAt?: Date;
    applyProposal?: ReturnType<typeof vi.fn>;
    agentSkillIds?: string[];
  } = {}) => {
    const [
      { createContextVariableCopilotProposalAdapter },
      { ContextVariableService },
    ] = await Promise.all([
      import("../../../src/modules/operatorCopilot/proposalAdapters.js"),
      import("../../../src/modules/context-variables/public.js"),
    ]);
    const get = vi.fn(async () => overrides.variable ?? null);
    const listByWorkspace = vi.fn(async () => overrides.workspaceVariables ?? (overrides.variable ? [overrides.variable] : []));
    const listByAgent = vi.fn(async () => overrides.enablements ?? []);
    const applyProposal = overrides.applyProposal ?? vi.fn(async () => ({ variableId: overrides.variable?.id ?? "created-variable-1" }));
    const agentService = { get: vi.fn(async () => ({ id: contextVariableAgentId, updatedAt: overrides.agentUpdatedAt ?? new Date(0) })) };
    // Finding 2 (issue triage, next-ray-epic-issue): validatePayload now refuses a disabled
    // resolver skill too, not just one that does not exist - so this fixture's ids must carry an
    // enabled flag the way the real AgentSkillsService.list result does. Every id this helper's
    // callers register is meant to resolve cleanly, so it defaults to enabled: true.
    const agentSkillsService = { list: vi.fn(async () => (overrides.agentSkillIds ?? []).map((id) => ({ id, enabled: true }))) };
    const adapter = createContextVariableCopilotProposalAdapter({
      contextVariables: new ContextVariableService({
        repository: { get, listByWorkspace, listByAgent, applyProposal } as never,
        agentReader: agentService,
        agentSkillsReader: agentSkillsService,
      }),
    });
    return { adapter, get, listByWorkspace, listByAgent, applyProposal, agentService, agentSkillsService };
  };

  it("validates a brand-new variable definition and creates it even when an unrelated agent edit lands first", async () => {
    const applyProposal = vi.fn(async () => ({ variableId: "created-variable-1" }));
    const { adapter, agentService } = await buildAdapter({ applyProposal });
    const targetRef = { agentId: contextVariableAgentId, variableId: null };

    const validated = await adapter.validatePayload("workspace-1", targetRef, {
      name: "loyalty_tier",
      valueType: "string",
      trustTier: "unverified",
      sensitivity: "normal",
      defaultSurfacing: "on_reference",
    });
    expect(validated.payload).toMatchObject({
      name: "loyalty_tier",
      definition: { name: "loyalty_tier", valueType: "string", trustTier: "unverified", sensitivity: "normal", defaultSurfacing: "on_reference" },
      enablement: null,
    });

    // A brand-new variable has no row of its own to gate against; no existing workspace variable
    // blocks this name yet, so the token says "open" - not the agent's updatedAt, which
    // applyProposal's create branch never touches - with a trailing "|" for the empty enablement
    // segment.
    expect(validated.versionToken).toBe("open|");

    // Something unrelated to this variable has since touched the agent row - applyProposal's
    // create branch never touches it, so this must not block a legitimate first-time create.
    agentService.get.mockResolvedValueOnce({ id: contextVariableAgentId, updatedAt: new Date(1) });
    const applied = await adapter.applyIfVersionMatches("workspace-1", targetRef, validated.payload, validated.versionToken);
    expect(applied).toEqual({ outcome: "applied", appliedRef: { agentId: contextVariableAgentId, variableId: "created-variable-1" } });
    expect(applyProposal).toHaveBeenCalledWith(expect.objectContaining({
      workspaceId: "workspace-1",
      agentId: contextVariableAgentId,
      variableId: null,
      definition: expect.objectContaining({ name: "loyalty_tier", valueType: "string" }),
    }));
  });

  it("reports stale, not a duplicate success, when a create apply is retried after the variable already exists", async () => {
    const applyProposal = vi.fn()
      .mockResolvedValueOnce({ variableId: "created-variable-1" })
      // Mirrors ContextVariableRepository.applyProposal: a second call for the same name (a
      // crash-recovery replay of the same apply) collides on the workspace+name uniqueness
      // constraint, which applyProposal turns into a real conflict rather than a raw pg error.
      .mockRejectedValueOnce(conflict('A context variable named "loyalty_tier" already exists for this workspace'));
    const { adapter } = await buildAdapter({ applyProposal });
    const targetRef = { agentId: contextVariableAgentId, variableId: null };

    const validated = await adapter.validatePayload("workspace-1", targetRef, {
      name: "loyalty_tier",
      valueType: "string",
      trustTier: "unverified",
      sensitivity: "normal",
      defaultSurfacing: "on_reference",
    });

    expect(await adapter.applyIfVersionMatches("workspace-1", targetRef, validated.payload, validated.versionToken)).toEqual({
      outcome: "applied",
      appliedRef: { agentId: contextVariableAgentId, variableId: "created-variable-1" },
    });
    expect(await adapter.applyIfVersionMatches("workspace-1", targetRef, validated.payload, validated.versionToken)).toEqual({ outcome: "stale" });
    expect(applyProposal).toHaveBeenCalledTimes(2);
  });

  it("updates an existing variable's definition by id without touching its enablement", async () => {
    const variable = { id: existingVariableId, workspaceId: "workspace-1", name: "loyalty_tier", description: null, valueType: "string", trustTier: "unverified", sensitivity: "normal", defaultSurfacing: "on_reference", updatedAt: new Date(5) };
    const applyProposal = vi.fn(async () => ({ variableId: existingVariableId }));
    const { adapter } = await buildAdapter({ variable, applyProposal });
    const targetRef = { agentId: contextVariableAgentId, variableId: existingVariableId };

    const validated = await adapter.validatePayload("workspace-1", targetRef, { sensitivity: "sensitive" });
    expect(validated.payload).toMatchObject({ name: "loyalty_tier", definition: expect.objectContaining({ sensitivity: "sensitive" }), enablement: null });

    const token = await adapter.readVersionToken("workspace-1", targetRef);
    expect(token).toBe(`${new Date(5).toISOString()}|`);

    const applied = await adapter.applyIfVersionMatches("workspace-1", targetRef, validated.payload, token);
    expect(applied).toEqual({ outcome: "applied", appliedRef: { agentId: contextVariableAgentId, variableId: existingVariableId } });
    expect(applyProposal).toHaveBeenCalledWith(expect.objectContaining({
      variableId: existingVariableId,
      definition: expect.objectContaining({ sensitivity: "sensitive" }),
      expectedVariableUpdatedAt: new Date(5),
      enablement: null,
    }));

    // A concurrent edit is now detected by the write's own predicate, not a pre-read the adapter
    // compares beforehand - simulate that by having the gated mutation itself refuse.
    applyProposal.mockRejectedValueOnce(conflict("Context variable was updated by another writer; reload before saving again"));
    expect(await adapter.applyIfVersionMatches("workspace-1", targetRef, validated.payload, token)).toEqual({ outcome: "stale" });
  });

  it("upserts a per-agent enablement onto an existing variable, independent of its definition", async () => {
    const variable = { id: existingVariableId, workspaceId: "workspace-1", name: "loyalty_tier", description: null, valueType: "string", trustTier: "unverified", sensitivity: "normal", defaultSurfacing: "on_reference", updatedAt: new Date(0) };
    const applyProposal = vi.fn(async () => ({ variableId: existingVariableId }));
    const { adapter } = await buildAdapter({ variable, applyProposal });
    const targetRef = { agentId: contextVariableAgentId, variableId: existingVariableId };

    const validated = await adapter.validatePayload("workspace-1", targetRef, {
      enablement: { source: "pushed", surfacing: "always" },
    });
    expect(validated.payload).toMatchObject({ definition: null, enablement: { source: "pushed", resolverSkillId: null, surfacing: "always", enabled: true } });

    const applied = await adapter.applyIfVersionMatches("workspace-1", targetRef, validated.payload, await adapter.readVersionToken("workspace-1", targetRef));
    expect(applied).toEqual({ outcome: "applied", appliedRef: { agentId: contextVariableAgentId, variableId: existingVariableId } });
    expect(applyProposal).toHaveBeenCalledWith(expect.objectContaining({
      agentId: contextVariableAgentId,
      variableId: existingVariableId,
      definition: null,
      enablement: expect.objectContaining({ source: "pushed", surfacing: "always" }),
      expectedEnablementUpdatedAt: null,
    }));
  });

  // applyProposal upserts all six enablement columns as a full replacement (see
  // ContextVariableEnablementWrite), so an enablement proposal that restates only the fields it
  // means to change must merge against the stored row itself - otherwise every omitted field
  // (staleness/timeout tuning, a deliberate `enabled: false`) silently resets on the next unrelated
  // enablement edit.
  const resolverSkillId = "6b6b6b6b-1111-2222-3333-444444444999";
  const storedResolverEnablement = {
    id: "enablement-1",
    agentId: contextVariableAgentId,
    variableId: existingVariableId,
    source: "resolver",
    resolverSkillId,
    maxAgeSeconds: 3600,
    resolverTimeoutMs: 500,
    surfacing: "on_reference",
    enabled: false,
    updatedAt: new Date(7),
  };
  const variableForMergeTests = { id: existingVariableId, workspaceId: "workspace-1", name: "loyalty_tier", description: null, valueType: "string", trustTier: "unverified", sensitivity: "normal", defaultSurfacing: "on_reference", updatedAt: new Date(0) };

  it("preserves an existing enablement's staleness tuning and disabled state when a proposal restates only source, resolverSkillId, and surfacing", async () => {
    const { adapter } = await buildAdapter({
      variable: variableForMergeTests,
      enablements: [storedResolverEnablement],
      agentSkillIds: [resolverSkillId],
    });
    const targetRef = { agentId: contextVariableAgentId, variableId: existingVariableId };

    const validated = await adapter.validatePayload("workspace-1", targetRef, {
      enablement: { source: "resolver", resolverSkillId, surfacing: "always" },
    });

    expect(validated.payload).toMatchObject({
      enablement: {
        source: "resolver",
        resolverSkillId,
        maxAgeSeconds: 3600,
        resolverTimeoutMs: 500,
        surfacing: "always",
        enabled: false,
      },
    });
  });

  it("clears an explicit null field while still carrying forward an omitted one, and honors an explicit enabled: true", async () => {
    const { adapter } = await buildAdapter({
      variable: variableForMergeTests,
      enablements: [storedResolverEnablement],
      agentSkillIds: [resolverSkillId],
    });
    const targetRef = { agentId: contextVariableAgentId, variableId: existingVariableId };

    const validated = await adapter.validatePayload("workspace-1", targetRef, {
      enablement: { source: "resolver", resolverSkillId, surfacing: "always", maxAgeSeconds: null, enabled: true },
    });

    expect(validated.payload).toMatchObject({
      enablement: {
        source: "resolver",
        resolverSkillId,
        maxAgeSeconds: null,
        // omitted - carried forward from the stored row
        resolverTimeoutMs: 500,
        surfacing: "always",
        enabled: true,
      },
    });
  });

  it("nulls out resolver-only fields, without throwing, when a proposal switches source away from resolver", async () => {
    const { adapter } = await buildAdapter({
      variable: variableForMergeTests,
      enablements: [storedResolverEnablement],
    });
    const targetRef = { agentId: contextVariableAgentId, variableId: existingVariableId };

    const validated = await adapter.validatePayload("workspace-1", targetRef, {
      enablement: { source: "pushed", surfacing: "always" },
    });

    expect(validated.payload).toMatchObject({
      enablement: {
        source: "pushed",
        resolverSkillId: null,
        maxAgeSeconds: null,
        resolverTimeoutMs: null,
        surfacing: "always",
        // enabled still carries forward even though the resolver-only fields do not
        enabled: false,
      },
    });
  });

  it("refuses a proposal that would persist an inherited resolverSkillId naming a since-disabled skill", async () => {
    const { adapter } = await buildAdapter({
      variable: variableForMergeTests,
      enablements: [storedResolverEnablement],
      agentSkillIds: [],
    });
    const targetRef = { agentId: contextVariableAgentId, variableId: existingVariableId };

    await expect(adapter.validatePayload("workspace-1", targetRef, {
      enablement: { source: "resolver", surfacing: "always" },
    })).rejects.toThrow(/does not name a skill on this agent/i);
  });

  it("creates a variable and enables it for the agent from a single proposal", async () => {
    const applyProposal = vi.fn(async () => ({ variableId: "created-variable-2" }));
    const { adapter } = await buildAdapter({ applyProposal, agentSkillIds: ["6b6b6b6b-1111-2222-3333-444444444999"] });
    const targetRef = { agentId: contextVariableAgentId, variableId: null };

    const validated = await adapter.validatePayload("workspace-1", targetRef, {
      name: "loyalty_tier",
      valueType: "string",
      trustTier: "unverified",
      sensitivity: "normal",
      defaultSurfacing: "on_reference",
      enablement: { source: "resolver", resolverSkillId: "6b6b6b6b-1111-2222-3333-444444444999", surfacing: "operator_only" },
    });
    const applied = await adapter.applyIfVersionMatches("workspace-1", targetRef, validated.payload, await adapter.readVersionToken("workspace-1", targetRef, validated.payload));

    expect(applied).toEqual({ outcome: "applied", appliedRef: { agentId: contextVariableAgentId, variableId: "created-variable-2" } });
    expect(applyProposal).toHaveBeenCalledWith(expect.objectContaining({
      variableId: null,
      definition: expect.objectContaining({ name: "loyalty_tier" }),
      enablement: expect.objectContaining({ source: "resolver", resolverSkillId: "6b6b6b6b-1111-2222-3333-444444444999" }),
    }));
  });

  it("refuses a proposal for an existing variable with neither a definition field nor an enablement", async () => {
    const variable = { id: existingVariableId, workspaceId: "workspace-1", name: "loyalty_tier", description: null, valueType: "string", trustTier: "unverified", sensitivity: "normal", defaultSurfacing: "on_reference", updatedAt: new Date(0) };
    const { adapter } = await buildAdapter({ variable });
    await expect(adapter.validatePayload("workspace-1", { agentId: contextVariableAgentId, variableId: existingVariableId }, {}))
      .rejects.toThrow(/definition change|enablement change/i);
  });

  it("refuses a new variable proposal missing a required definition field", async () => {
    const { adapter } = await buildAdapter();
    await expect(adapter.validatePayload("workspace-1", { agentId: contextVariableAgentId, variableId: null }, {
      name: "loyalty_tier",
      trustTier: "unverified",
      sensitivity: "normal",
      defaultSurfacing: "on_reference",
    })).rejects.toThrow(/value type/i);
  });

  it("refuses proposing an enablement for a variable id that does not exist", async () => {
    const { adapter } = await buildAdapter({ variable: null });
    await expect(adapter.validatePayload("workspace-1", { agentId: contextVariableAgentId, variableId: existingVariableId }, {
      enablement: { source: "pushed", surfacing: "always" },
    })).rejects.toThrow(/not found/i);
  });

  it("refuses a browser-sourced enablement", async () => {
    const variable = { id: existingVariableId, workspaceId: "workspace-1", name: "loyalty_tier", description: null, valueType: "string", trustTier: "unverified", sensitivity: "normal", defaultSurfacing: "on_reference", updatedAt: new Date(0) };
    const { adapter } = await buildAdapter({ variable });
    await expect(adapter.validatePayload("workspace-1", { agentId: contextVariableAgentId, variableId: existingVariableId }, {
      enablement: { source: "browser", surfacing: "always" },
    })).rejects.toThrow(/not yet supported/i);
  });

  it("refuses a resolver enablement with no resolverSkillId", async () => {
    const variable = { id: existingVariableId, workspaceId: "workspace-1", name: "loyalty_tier", description: null, valueType: "string", trustTier: "unverified", sensitivity: "normal", defaultSurfacing: "on_reference", updatedAt: new Date(0) };
    const { adapter } = await buildAdapter({ variable });
    await expect(adapter.validatePayload("workspace-1", { agentId: contextVariableAgentId, variableId: existingVariableId }, {
      enablement: { source: "resolver", surfacing: "always" },
    })).rejects.toThrow(/resolverSkillId is required/i);
  });

  it("refuses a non-resolver enablement carrying resolver-only fields", async () => {
    const variable = { id: existingVariableId, workspaceId: "workspace-1", name: "loyalty_tier", description: null, valueType: "string", trustTier: "unverified", sensitivity: "normal", defaultSurfacing: "on_reference", updatedAt: new Date(0) };
    const { adapter } = await buildAdapter({ variable });
    await expect(adapter.validatePayload("workspace-1", { agentId: contextVariableAgentId, variableId: existingVariableId }, {
      enablement: { source: "pushed", surfacing: "always", maxAgeSeconds: 60 },
    })).rejects.toThrow(/only allowed when source is resolver/i);
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

  // Finding 1 (issue triage, next-ray-epic-issue): a removal proposal's card must reload with a
  // structural removal signal (not just its prose summary), the same discriminator
  // (payload.op === "remove") proposalAdapters.ts already uses to pick the removal branch at
  // preview/apply time - so the frontend's Apply confirmation can state plainly that the change
  // is a permanent deletion even after the operator resumes a past conversation.
  it("marks a reloaded directive removal proposal's card with removal: true", async () => {
    const { presentProposalCard } = await import("../../../src/db/repositories/copilotRepository.js");
    const base = {
      id: "proposal-1", workspaceId: "workspace-1", operatorUserId: "user-1", conversationId: "conversation-1", messageId: "message-1",
      targetType: "directive" as const, targetRef: { agentId: "agent-1", directiveId: "directive-1" }, versionToken: "v1", evidence: null,
      status: "pending" as const, reason: null, appliedRef: null, createdAt: new Date(0), updatedAt: new Date(0),
    };

    expect(presentProposalCard({ ...base, payload: { op: "remove", name: "Avoid competitors", rationale: "Permanently remove the directive." } }))
      .toMatchObject({ targetLabel: "Avoid competitors", removal: true });
  });

  it("does not mark an ordinary directive save proposal's card as a removal", async () => {
    const { presentProposalCard } = await import("../../../src/db/repositories/copilotRepository.js");
    const base = {
      id: "proposal-1", workspaceId: "workspace-1", operatorUserId: "user-1", conversationId: "conversation-1", messageId: "message-1",
      targetType: "directive" as const, targetRef: { agentId: "agent-1", directiveId: "directive-1" }, versionToken: "v1", evidence: null,
      status: "pending" as const, reason: null, appliedRef: null, createdAt: new Date(0), updatedAt: new Date(0),
    };

    expect(presentProposalCard({ ...base, payload: { name: "Avoid competitors", action: "Do not recommend competitors", rationale: "State it plainly." } }))
      .not.toHaveProperty("removal");
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

  const context = { workspaceId, accountId, operatorUserId, copilotConversationId: "conversation-1", currentAuthorization, pageContext: { view: "other" as const, agentId, conversationId: null, selection: null, entities: [] } };

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

describe("propose_skill_config replay evidence", () => {
  // Only the retrieve capability's default-answer skill round-trips through a replay override
  // (see skillSettingsEvidenceKey in agentSkills.ts), so that is the pair this suite measures.
  const evidenceId = randomUUID();
  const caseId = randomUUID();
  const runId = randomUUID();
  const capturedAt = new Date("2026-08-25T10:00:00.000Z");
  const agentUpdatedAt = new Date("2026-08-25T09:00:00.000Z");

  // The replay measured the skill switched ON, at the config the proposal below also states.
  const measuredEnabled = () => ({
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
    overrides: { agentConfigOverride: { skillSettings: { "retrieval.answer": { enabled: true, settings: { vectorTopK: 40 } } } } },
    directivesExcluded: [],
    createdAt: new Date(),
  });

  const harness = () => {
    const createProposal = vi.fn(async (input: Record<string, unknown>) => ({
      id: randomUUID(), ...input, messageId: null, status: "pending" as const, appliedRef: null, createdAt: new Date(), updatedAt: new Date(),
    }));
    // A stand-in for the real skill adapter: it just echoes back what the tool validated, the
    // same way the directive-adapter mock above stands in for drafting.
    const validatePayload = vi.fn(async (_workspaceId: string, targetRef: unknown, payload: unknown) => {
      const input = payload as { capability?: string; invocationMode?: string; config?: unknown; enabled?: boolean; rationale?: string };
      return {
        targetRef,
        payload: {
          name: "Default answer",
          capability: input.capability,
          invocationMode: input.invocationMode,
          config: input.config ?? {},
          enabled: input.enabled,
          rationale: input.rationale,
        },
        versionToken: "skill-version",
      };
    });
    const descriptors = createAgentSkillConfigProposalCopilotTools({
      proposalRepository: { createProposal },
      proposalEvidence: {
        evidence: { record: vi.fn(), findMany: vi.fn(async () => [measuredEnabled()]) },
        agentVersion: { get: vi.fn(async () => ({ updatedAt: agentUpdatedAt })) },
      },
      proposalAdapters: [
        { targetType: "agent_skill" as const, readVersionToken: vi.fn(async () => "skill-version"), preview: vi.fn(), applyIfVersionMatches: vi.fn(), validatePayload },
      ],
      auditService: auditService(),
    } as never);
    const descriptor = descriptors.find((candidate) => candidate.name === "propose_skill_config")!;
    return { descriptor, createProposal };
  };

  const context = { workspaceId, accountId, operatorUserId, copilotConversationId: "conversation-1", currentAuthorization, pageContext: { view: "other" as const, agentId, conversationId: null, selection: null, entities: [] } };

  it("refuses a proposal that turns the default-answer skill off, citing a replay that measured it on", async () => {
    // Regression coverage for propose_skill_config actually forwarding `enabled` into the cited
    // change: before that wiring existed, this exact call created the proposal instead of
    // rejecting it, silently dropping the enabled-state check the evidence service enforces.
    const { descriptor, createProposal } = harness();

    await expect(descriptor.createTool(context).invoke({
      agentId,
      capability: "retrieve",
      invocationMode: "default_answer",
      config: { vectorTopK: 40 },
      enabled: false,
      evidenceIds: [evidenceId],
    }, {} as never)).rejects.toThrow(/enabled state/i);

    expect(createProposal).not.toHaveBeenCalled();
  });
});

const storedRoutine = (overrides: Record<string, unknown> = {}) => ({
  id: "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
  agentId,
  lineageId: "dddddddd-dddd-4ddd-8ddd-dddddddddddd",
  version: 1,
  status: "draft",
  name: "support-intake",
  activation: { triggerDescription: "When the user needs support", gateRef: null, priority: 7, reentryMode: "always" },
  slots: [],
  steps: [
    { stableStepId: "collect_topic", kind: "chat", instruction: "Ask how we can help.", toolRef: null, actionType: null, ordinal: 0, metadata: {} },
    { stableStepId: "confirm", kind: "chat", instruction: "Confirm it.", toolRef: null, actionType: null, ordinal: 1, metadata: {} },
  ],
  transitions: [
    { fromStep: "collect_topic", toRef: "confirm", guardKind: "default", guardText: null, outcomeStatus: null, counterLimit: null, ordinal: 0 },
    { fromStep: "confirm", toRef: "done", guardKind: "default", guardText: null, outcomeStatus: null, counterLimit: null, ordinal: 0 },
  ],
  terminals: [{ stableStepId: "done", kind: "complete", instruction: "Thank them.", ordinal: 0 }],
  createdAt: new Date("2026-08-01T10:00:00.000Z"),
  updatedAt: new Date("2026-08-02T10:00:00.000Z"),
  ...overrides,
});

/** A draft revision of the same lineage; a real one carries a routine id, so the fixture does too. */
const pendingRevisionId = "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee";

const routineAdapterPorts = (routine = storedRoutine(), siblings: Array<ReturnType<typeof storedRoutine>> = []) => {
  const current = { value: routine };
  const lineage = { siblings };
  return {
    current,
    lineage,
    list: vi.fn(async () => [current.value, ...lineage.siblings]),
    get: vi.fn(async () => current.value),
    createDraft: vi.fn(async () => ({ routine: { id: "routine-1", status: "draft" } })),
    deleteDraft: vi.fn(async () => {}),
    updateDraft: vi.fn(async (_workspaceId: string, _agentId: string, _routineId: string, _input: unknown) => ({ routine: current.value, validation: { ok: true, diagnostics: [] } })),
    // The real repository returns the lineage's existing draft when there is one, rather than a
    // fresh copy of the published routine.
    revise: vi.fn(async () => lineage.siblings.find((sibling) => sibling.status === "draft")
      ?? { ...current.value, id: "revision-1", status: "draft", version: 2 }),
    publish: vi.fn(async () => ({ routine: { ...current.value, id: "published-1", status: "published" }, validation: { ok: true, diagnostics: [] }, directiveScopeOrphans: [] })),
    archive: vi.fn(async () => ({ ...current.value, status: "archived" })),
    restore: vi.fn(async () => ({
      routine: { ...current.value, status: "published" },
      validation: { ok: true, diagnostics: [] },
    })),
    validate: vi.fn(async () => ({ ok: true, diagnostics: [] as Array<{ code: string; location: string; message: string }> })),
  };
};

const routineAdapter = async (
  ports: ReturnType<typeof routineAdapterPorts>,
  logger = { warn: vi.fn() },
) => {
  const { createRoutineCopilotProposalAdapter } = await import("../../../src/modules/operatorCopilot/proposalAdapters.js");
  return createRoutineCopilotProposalAdapter({
    agentService: { get: vi.fn(async () => ({ updatedAt: new Date("2026-08-01T10:00:00.000Z") })) } as never,
    routineDraftAssistService: { draft: vi.fn() } as never,
    routineDefinitionService: ports as never,
    logger,
  });
};

describe("routine edit and lifecycle proposal tools", () => {
  const proposalTools = (adapter: Record<string, unknown>, createProposal = vi.fn(async (input: Record<string, unknown>) => ({
    id: randomUUID(), ...input, messageId: null, status: "pending" as const, appliedRef: null, createdAt: new Date(), updatedAt: new Date(),
  }))) => ({
    createProposal,
    descriptors: createRoutineProposalCopilotTools({
      proposalRepository: { createProposal },
      proposalEvidence: unmeasured(),
      proposalAdapters: [{ targetType: "routine", ...adapter }],
      auditService: auditService(),
    } as never),
  });

  const toolContext = {
    workspaceId, accountId, operatorUserId, copilotConversationId: "conversation-1",
    currentAuthorization,
    pageContext: { view: "agent" as const, agentId, conversationId: null, selection: null, entities: [] },
  };
  const routineId = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";

  it("targets the routine it edits and guards the edit against the routine it was drafted from", async () => {
    const order: string[] = [];
    const readVersionToken = vi.fn(async () => { order.push("token"); return "routine-version"; });
    const draftEdit = vi.fn(async () => {
      order.push("draft");
      return { payload: { kind: "edit", name: "support-intake", changes: {} }, targetLabel: "support-intake", summary: "Edit routine support-intake: step confirm.", diagnostics: [] };
    });
    const { createProposal, descriptors } = proposalTools({ readVersionToken, draftEdit, preview: vi.fn(), applyIfVersionMatches: vi.fn(), draft: vi.fn(), draftLifecycle: vi.fn() });

    const result = await descriptors.find((descriptor) => descriptor.name === "propose_routine_edit")!
      .createTool(toolContext)
      .invoke({ routineId, changes: { steps: [{ stableStepId: "confirm", instruction: "Read the order number back." }] } }, {} as never);

    // The token must be read before the draft: a token taken afterwards could match a routine
    // revised in between, and the edit would then be applied to content Ray never saw.
    expect(order).toEqual(["token", "draft"]);
    expect(createProposal).toHaveBeenCalledWith(expect.objectContaining({
      targetType: "routine",
      targetRef: { agentId, routineId },
      versionToken: "routine-version",
    }));
    expect(result).toEqual(expect.objectContaining({
      targetType: "routine",
      targetLabel: "support-intake",
      validation: { ok: true, diagnostics: [] },
    }));
  });

  it("refuses to draft an edit for a routine nobody named", async () => {
    const draftEdit = vi.fn();
    const { createProposal, descriptors } = proposalTools({ readVersionToken: vi.fn(), draftEdit, preview: vi.fn(), applyIfVersionMatches: vi.fn(), draft: vi.fn(), draftLifecycle: vi.fn() });

    await expect(descriptors.find((descriptor) => descriptor.name === "propose_routine_edit")!
      .createTool(toolContext)
      .invoke({ changes: { name: "renamed" } }, {} as never)).rejects.toThrow(/routine/i);
    expect(draftEdit).not.toHaveBeenCalled();
    expect(createProposal).not.toHaveBeenCalled();
  });

  it("proposes going live as its own card rather than folding it into a content edit", async () => {
    const draftLifecycle = vi.fn(async () => ({ payload: { kind: "lifecycle", action: "publish", name: "support-intake" }, targetLabel: "support-intake", summary: "Publish routine support-intake.", diagnostics: [] }));
    const { createProposal, descriptors } = proposalTools({ readVersionToken: vi.fn(async () => "routine-version"), draftLifecycle, preview: vi.fn(), applyIfVersionMatches: vi.fn(), draft: vi.fn(), draftEdit: vi.fn() });

    const tool = descriptors.find((descriptor) => descriptor.name === "propose_routine_lifecycle")!;
    await tool.createTool(toolContext).invoke({ routineId, action: "publish" }, {} as never);

    expect(tool.shape).toBe("propose");
    expect(draftLifecycle).toHaveBeenCalledWith(workspaceId, { agentId, routineId }, "publish", undefined);
    expect(createProposal).toHaveBeenCalledWith(expect.objectContaining({
      targetRef: { agentId, routineId },
      payload: { kind: "lifecycle", action: "publish", name: "support-intake" },
    }));
  });
});

describe("routine proposal adapter edits", () => {
  const targetRef = { agentId, routineId: "cccccccc-cccc-4ccc-8ccc-cccccccccccc" };
  const token = new Date("2026-08-02T10:00:00.000Z").toISOString();

  it("guards an edit with the routine's own version, not the agent's", async () => {
    const ports = routineAdapterPorts();
    const adapter = await routineAdapter(ports);

    expect(await adapter.readVersionToken(workspaceId, targetRef)).toBe(token);
  });

  it("edits a draft routine in place, changing only the step it names", async () => {
    const ports = routineAdapterPorts();
    const adapter = await routineAdapter(ports);
    const draft = await adapter.draftEdit!(workspaceId, targetRef, { steps: [{ stableStepId: "confirm", instruction: "Read the order number back." }] });

    expect(draft.summary).toContain("step confirm");
    expect(await adapter.applyIfVersionMatches(workspaceId, targetRef, draft.payload, token)).toEqual({
      outcome: "applied",
      appliedRef: { agentId, routineId: targetRef.routineId },
    });
    const [, , updatedId, input] = ports.updateDraft.mock.calls[0] as unknown as [string, string, string, { steps: Array<{ stableStepId: string; instruction: string }> }];
    expect(updatedId).toBe(targetRef.routineId);
    expect(input.steps).toEqual([
      expect.objectContaining({ stableStepId: "collect_topic", instruction: "Ask how we can help." }),
      expect.objectContaining({ stableStepId: "confirm", instruction: "Read the order number back." }),
    ]);
    expect(ports.revise).not.toHaveBeenCalled();
  });

  it("revises a published routine into a draft and edits that, leaving the live version serving", async () => {
    const ports = routineAdapterPorts(storedRoutine({ status: "published" }));
    const adapter = await routineAdapter(ports);
    const draft = await adapter.draftEdit!(workspaceId, targetRef, { steps: [{ stableStepId: "confirm", instruction: "Read it back." }] });

    expect(await adapter.applyIfVersionMatches(workspaceId, targetRef, draft.payload, token)).toEqual({
      outcome: "applied",
      appliedRef: { agentId, routineId: "revision-1" },
    });
    expect(ports.revise).toHaveBeenCalledWith(workspaceId, agentId, targetRef.routineId);
    expect(ports.updateDraft.mock.calls[0]?.[2]).toBe("revision-1");
  });

  it("declines to write when the routine moved under the proposal", async () => {
    const ports = routineAdapterPorts();
    const adapter = await routineAdapter(ports);
    const draft = await adapter.draftEdit!(workspaceId, targetRef, { name: "support-intake-v2" });
    ports.current.value = storedRoutine({ updatedAt: new Date("2026-08-03T10:00:00.000Z") });

    expect(await adapter.applyIfVersionMatches(workspaceId, targetRef, draft.payload, token)).toEqual({ outcome: "stale" });
    expect(ports.updateDraft).not.toHaveBeenCalled();
  });

  it("refuses an edit that would break the routine, and names what it would break", async () => {
    const ports = routineAdapterPorts();
    ports.validate
      .mockResolvedValueOnce({ ok: true, diagnostics: [] })
      .mockResolvedValueOnce({ ok: false, diagnostics: [{ code: "unknown_slot_reference", location: "steps.confirm", message: "No such information field: order_number." }] });
    const adapter = await routineAdapter(ports);

    await expect(adapter.draftEdit!(workspaceId, targetRef, { steps: [{ stableStepId: "confirm", instruction: "Confirm {{slot.order_number}}." }] }))
      .rejects.toThrow(/order_number/);
  });

  it("lets a rename through when the routine already had a routine-level diagnostic", async () => {
    // Routine-level diagnostics carry the routine's name in their location, so a rename moves them.
    // Comparing raw locations read that as newly introduced and blocked the one edit that renames.
    const ports = routineAdapterPorts();
    ports.validate
      .mockResolvedValueOnce({ ok: false, diagnostics: [{ code: "missing_terminal", location: "routine:support-intake", message: "No ending is reachable." }] })
      .mockResolvedValueOnce({ ok: false, diagnostics: [{ code: "missing_terminal", location: "routine:support-intake-v2", message: "No ending is reachable." }] });
    const adapter = await routineAdapter(ports);

    const draft = await adapter.draftEdit!(workspaceId, targetRef, { name: "support-intake-v2" });

    expect(draft.summary).toContain("name");
  });

  it("keeps an edit that leaves an existing diagnostic exactly as it found it", async () => {
    const ports = routineAdapterPorts();
    const existing = { ok: false, diagnostics: [{ code: "unreachable_step", location: "steps.confirm", message: "Nothing reaches confirm." }] };
    ports.validate.mockResolvedValueOnce(existing).mockResolvedValueOnce(existing);
    const adapter = await routineAdapter(ports);

    const draft = await adapter.draftEdit!(workspaceId, targetRef, { name: "support-intake-v2" });

    expect(draft.diagnostics).toEqual(existing.diagnostics);
  });

  it("previews an edit element by element so a reviewer sees the changed step", async () => {
    const ports = routineAdapterPorts();
    const adapter = await routineAdapter(ports);
    const draft = await adapter.draftEdit!(workspaceId, targetRef, { steps: [{ stableStepId: "confirm", instruction: "Read it back." }] });

    const preview = await adapter.preview(workspaceId, targetRef, draft.payload) as {
      targetLabel: string;
      current: { steps: Record<string, { instruction: string }> };
      proposed: { steps: Record<string, { instruction: string }> };
    };

    expect(preview.targetLabel).toBe("support-intake");
    expect(preview.current.steps.confirm!.instruction).toBe("Confirm it.");
    expect(preview.proposed.steps.confirm!.instruction).toBe("Read it back.");
    expect(preview.proposed.steps.collect_topic).toEqual(preview.current.steps.collect_topic);
  });

  it("says so on the card when an edit no longer applies to the routine", async () => {
    const ports = routineAdapterPorts();
    const adapter = await routineAdapter(ports);
    const draft = await adapter.draftEdit!(workspaceId, targetRef, { steps: [{ stableStepId: "confirm", instruction: "Read it back." }] });
    ports.current.value = storedRoutine({ steps: [storedRoutine().steps[0]] });

    expect(await adapter.preview(workspaceId, targetRef, draft.payload)).toEqual({
      targetLabel: "support-intake",
      current: null,
      proposed: { editNoLongerApplies: expect.stringContaining("confirm") },
    });
  });

  it("sends the operator to the draft revision instead of editing the published version behind it", async () => {
    // revise() hands back the lineage's existing draft rather than a fresh copy, so an edit
    // computed against the published content would overwrite whatever that draft already changed.
    const pending = storedRoutine({
      id: pendingRevisionId, status: "draft", version: 2, name: "support-intake",
      steps: [storedRoutine().steps[0]!, { ...storedRoutine().steps[1]!, instruction: "Half-finished wording." }],
    });
    const adapter = await routineAdapter(routineAdapterPorts(storedRoutine({ status: "published" }), [pending]));

    await expect(adapter.draftEdit!(workspaceId, targetRef, { steps: [{ stableStepId: "confirm", instruction: "Read it back." }] }))
      .rejects.toThrow(/draft revision/i);
  });

  it("edits through a revision nobody has touched rather than treating it as work in progress", async () => {
    // Revising copies the published routine verbatim. A revision created and abandoned — including
    // one left behind by a failed apply — is that copy, so refusing on its existence alone would
    // strand the routine for every later edit.
    const untouched = storedRoutine({ id: pendingRevisionId, status: "draft", version: 2 });
    const ports = routineAdapterPorts(storedRoutine({ status: "published" }), [untouched]);
    const adapter = await routineAdapter(ports);

    const proposalToken = await adapter.readVersionToken(workspaceId, targetRef);
    const draft = await adapter.draftEdit!(workspaceId, targetRef, { steps: [{ stableStepId: "confirm", instruction: "Read it back." }] });

    expect(await adapter.applyIfVersionMatches(workspaceId, targetRef, draft.payload, proposalToken)).toEqual({
      outcome: "applied",
      appliedRef: { agentId, routineId: pendingRevisionId },
    });
  });

  it("declines to write when a draft revision appeared after the card was drafted", async () => {
    const ports = routineAdapterPorts(storedRoutine({ status: "published" }));
    const adapter = await routineAdapter(ports);
    const draft = await adapter.draftEdit!(workspaceId, targetRef, { steps: [{ stableStepId: "confirm", instruction: "Read it back." }] });
    ports.lineage.siblings = [storedRoutine({
      id: pendingRevisionId, status: "draft", version: 2,
      steps: [storedRoutine().steps[0]!, { ...storedRoutine().steps[1]!, instruction: "Someone else's wording." }],
    })];

    expect(await adapter.applyIfVersionMatches(workspaceId, targetRef, draft.payload, token)).toEqual({ outcome: "stale" });
    expect(ports.updateDraft).not.toHaveBeenCalled();
  });

  it("states the version it decided against when it writes", async () => {
    const ports = routineAdapterPorts();
    const adapter = await routineAdapter(ports);
    const draft = await adapter.draftEdit!(workspaceId, targetRef, { name: "support-intake-v2" });

    await adapter.applyIfVersionMatches(workspaceId, targetRef, draft.payload, token);

    expect(ports.updateDraft).toHaveBeenCalledWith(workspaceId, agentId, targetRef.routineId, expect.anything(), {
      expectedUpdatedAt: ports.current.value.updatedAt,
    });
  });

  it("leaves the revision alone when the edit it was created for fails", async () => {
    // The revision is a verbatim copy of the published routine, so a failed edit leaves the same
    // thing an author leaves by revising and walking away — and the next edit reuses it. Racing
    // whoever else may hold that draft to clean it up costs more than the copy does.
    const ports = routineAdapterPorts(storedRoutine({ status: "published" }));
    const adapter = await routineAdapter(ports);
    const draft = await adapter.draftEdit!(workspaceId, targetRef, { name: "support-intake-v2" });
    ports.updateDraft.mockRejectedValueOnce(new Error("name already taken"));

    expect(await adapter.applyIfVersionMatches(workspaceId, targetRef, draft.payload, token)).toEqual({
      outcome: "failed",
      reason: "name already taken",
    });
    expect(ports.deleteDraft).not.toHaveBeenCalled();
  });

  it("refuses to edit an archived routine instead of quietly failing at apply time", async () => {
    const adapter = await routineAdapter(routineAdapterPorts(storedRoutine({ status: "archived" })));

    await expect(adapter.draftEdit!(workspaceId, targetRef, { name: "support-intake-v2" })).rejects.toThrow(/archived/i);
  });
});

describe("routine lifecycle proposal adapter", () => {
  const targetRef = { agentId, routineId: "cccccccc-cccc-4ccc-8ccc-cccccccccccc" };
  const token = new Date("2026-08-02T10:00:00.000Z").toISOString();

  it("marks an archive proposal stale when the draft revision it disclosed changes, is replaced, or disappears", async () => {
    const disclosed = storedRoutine({ id: pendingRevisionId, status: "draft", version: 3 });
    const ports = routineAdapterPorts(storedRoutine({ status: "published" }), [disclosed]);
    const adapter = await routineAdapter(ports);
    const versionToken = await adapter.readVersionToken(workspaceId, targetRef);
    const draft = await adapter.draftLifecycle!(workspaceId, targetRef, "archive");
    const repository = new MemoryProposalRepository();
    const proposal = await repository.createProposal({
      workspaceId,
      operatorUserId,
      conversationId: "conversation-1",
      targetType: "routine",
      targetRef,
      payload: draft.payload,
      versionToken,
      evidence: null,
    });
    const service = new OperatorCopilotService({
      repository,
      capabilityRunner: { runStreaming: vi.fn() },
      usageLimitPolicy: noLimitPolicy(),
      auditService: auditService(),
      prompt: "system",
      workspaceRouteKeyResolver,
      currentAuthorization,
      tools: [],
      proposalAdapters: [adapter],
    });

    ports.lineage.siblings = [{
      ...disclosed,
      updatedAt: new Date("2026-08-04T10:00:00.000Z"),
    }];

    expect((await service.getProposal({ workspaceId, operatorUserId, proposalId: proposal.id }))?.currentVersionMatches)
      .toBe(false);

    ports.lineage.siblings = [{ ...disclosed, id: randomUUID() }];
    expect((await service.getProposal({ workspaceId, operatorUserId, proposalId: proposal.id }))?.currentVersionMatches)
      .toBe(false);

    ports.lineage.siblings = [];
    expect((await service.getProposal({ workspaceId, operatorUserId, proposalId: proposal.id }))?.currentVersionMatches)
      .toBe(false);
  });

  it("publishes the draft and points the card at the version that went live", async () => {
    const ports = routineAdapterPorts();
    const adapter = await routineAdapter(ports);
    const draft = await adapter.draftLifecycle!(workspaceId, targetRef, "publish");

    expect(draft.summary).toContain("Publish");
    expect(await adapter.preview(workspaceId, targetRef, draft.payload)).toEqual({
      targetLabel: "support-intake",
      current: { status: "draft" },
      proposed: { status: "published" },
    });
    expect(await adapter.applyIfVersionMatches(workspaceId, targetRef, draft.payload, token)).toEqual({
      outcome: "applied",
      appliedRef: { agentId, routineId: "published-1" },
    });
  });

  it("publishes only the version the operator reviewed", async () => {
    const ports = routineAdapterPorts();
    const adapter = await routineAdapter(ports);
    const draft = await adapter.draftLifecycle!(workspaceId, targetRef, "publish");

    await adapter.applyIfVersionMatches(workspaceId, targetRef, draft.payload, token);

    expect(ports.publish).toHaveBeenCalledWith(workspaceId, agentId, targetRef.routineId, {
      expectedUpdatedAt: ports.current.value.updatedAt,
    });
  });

  it("says what archiving throws away, on the card and in the summary", async () => {
    // Archiving deletes the lineage's in-progress draft. A card that previews only the status
    // change would destroy unpublished work the operator never saw mentioned.
    const pending = storedRoutine({ id: pendingRevisionId, status: "draft", version: 3 });
    const ports = routineAdapterPorts(storedRoutine({ status: "published" }), [pending]);
    const adapter = await routineAdapter(ports);

    const draft = await adapter.draftLifecycle!(workspaceId, targetRef, "archive");

    expect(draft.summary).toContain("draft revision");
    expect(await adapter.preview(workspaceId, targetRef, draft.payload)).toMatchObject({
      proposed: { status: "archived", discardsDraftRevision: expect.stringContaining("3") },
    });
  });

  it("marks the proposal stale when the disclosed draft has been worked on since", async () => {
    // The id stays the same while an operator edits the draft, so an id-only guard would archive
    // on the strength of a description that no longer matches what would be thrown away.
    const disclosed = storedRoutine({ id: pendingRevisionId, status: "draft", version: 3 });
    const ports = routineAdapterPorts(storedRoutine({ status: "published" }), [disclosed]);
    const adapter = await routineAdapter(ports);
    const proposalToken = await adapter.readVersionToken(workspaceId, targetRef);
    const draft = await adapter.draftLifecycle!(workspaceId, targetRef, "archive");
    ports.lineage.siblings = [storedRoutine({ id: pendingRevisionId, status: "draft", version: 3, updatedAt: new Date("2026-08-04T10:00:00.000Z") })];

    expect(await adapter.applyIfVersionMatches(workspaceId, targetRef, draft.payload, proposalToken)).toEqual({ outcome: "stale" });
    expect(ports.archive).not.toHaveBeenCalled();
  });

  it("marks the proposal stale when a draft appeared that the card never disclosed", async () => {
    const ports = routineAdapterPorts(storedRoutine({ status: "published" }));
    const adapter = await routineAdapter(ports);
    const proposalToken = await adapter.readVersionToken(workspaceId, targetRef);
    const draft = await adapter.draftLifecycle!(workspaceId, targetRef, "archive");
    ports.lineage.siblings = [storedRoutine({ id: pendingRevisionId, status: "draft", version: 3 })];

    expect(await adapter.applyIfVersionMatches(workspaceId, targetRef, draft.payload, proposalToken)).toEqual({ outcome: "stale" });
    expect(ports.archive).not.toHaveBeenCalled();
  });

  it("will not draft a publish for a routine that would be rejected on publish", async () => {
    const ports = routineAdapterPorts();
    ports.validate.mockResolvedValueOnce({ ok: false, diagnostics: [{ code: "missing_terminal", location: "terminals", message: "No ending." }] });
    const adapter = await routineAdapter(ports);

    await expect(adapter.draftLifecycle!(workspaceId, targetRef, "publish")).rejects.toThrow(/No ending/);
  });

  it("reports a publish the service rejects as a failure carrying its diagnostics", async () => {
    const ports = routineAdapterPorts();
    ports.publish.mockResolvedValueOnce({ rejected: true, validation: { ok: false, diagnostics: [{ code: "missing_terminal", location: "terminals", message: "No ending." }] } } as never);
    const adapter = await routineAdapter(ports);
    const draft = await adapter.draftLifecycle!(workspaceId, targetRef, "publish");

    expect(await adapter.applyIfVersionMatches(workspaceId, targetRef, draft.payload, token)).toEqual({
      outcome: "failed",
      reason: expect.stringContaining("No ending"),
    });
  });

  it("will not restore a routine that has gone invalid while it was archived", async () => {
    // Restore puts a routine back in front of customers without publish's gates, so a skill removed
    // or a capability revoked during the archive would otherwise go live unchecked.
    const ports = routineAdapterPorts(storedRoutine({ status: "archived" }));
    ports.validate.mockResolvedValueOnce({ ok: false, diagnostics: [{ code: "unknown_skill", location: "step:confirm", message: "billing.lookup is not available to this agent." }] });
    const adapter = await routineAdapter(ports);

    await expect(adapter.draftLifecycle!(workspaceId, targetRef, "restore")).rejects.toThrow(/billing\.lookup/);
  });

  it("stops a restore that went invalid between the card and the click", async () => {
    const ports = routineAdapterPorts(storedRoutine({ status: "archived" }));
    const adapter = await routineAdapter(ports);
    const draft = await adapter.draftLifecycle!(workspaceId, targetRef, "restore");
    ports.validate.mockResolvedValueOnce({ ok: false, diagnostics: [{ code: "unknown_skill", location: "step:confirm", message: "billing.lookup is not available to this agent." }] });

    expect(await adapter.applyIfVersionMatches(workspaceId, targetRef, draft.payload, token)).toEqual({
      outcome: "failed",
      reason: expect.stringContaining("billing.lookup"),
    });
    expect(ports.restore).not.toHaveBeenCalled();
  });

  it("reports a lifecycle change that committed before its bookkeeping failed as applied", async () => {
    // publish() commits the status change, then persists trigger embeddings, writes a lifecycle
    // audit event, and re-validates. A throw from that tail would mark the card failed for a
    // routine that is already live, and re-applying it fails the status precondition.
    const ports = routineAdapterPorts();
    const logger = { warn: vi.fn() };
    const adapter = await routineAdapter(ports, logger);
    const draft = await adapter.draftLifecycle!(workspaceId, targetRef, "publish");
    const { RoutineDefinitionLifecycleCommittedError } = await import("../../../src/modules/routines/public.js");
    ports.publish.mockRejectedValueOnce(new RoutineDefinitionLifecycleCommittedError(
      "publish",
      targetRef.routineId,
      new Error("trigger embedding provider is down"),
    ));
    // Publishing flips this row in place, so the row the card names is the one that went live.
    ports.current.value = storedRoutine({ status: "published" });

    expect(await adapter.applyIfVersionMatches(workspaceId, targetRef, draft.payload, token)).toEqual({
      outcome: "applied",
      appliedRef: { agentId, routineId: targetRef.routineId },
    });
    expect(logger.warn).toHaveBeenCalledWith(
      {
        err: expect.objectContaining({ message: "trigger embedding provider is down" }),
        workspaceId,
        agentId,
        routineId: targetRef.routineId,
        action: "publish",
      },
      "Routine lifecycle committed but follow-up work failed",
    );
  });

  it("reports a write that refused before it committed as stale, not as somebody else's publish", async () => {
    // A conflict means nothing happened. Reconciling it against the routine would let a publish
    // another writer performed in the same moment be reported as this proposal's.
    const { conflict } = await import("../../../src/shared/domain/errors.js");
    const ports = routineAdapterPorts();
    const adapter = await routineAdapter(ports);
    const draft = await adapter.draftLifecycle!(workspaceId, targetRef, "publish");
    ports.publish.mockRejectedValueOnce(conflict("Routine changed while it was being published"));
    ports.current.value = storedRoutine({ status: "published" });

    expect(await adapter.applyIfVersionMatches(workspaceId, targetRef, draft.payload, token)).toEqual({ outcome: "stale" });
  });

  it("does not credit another writer when publish loses the status-precondition race", async () => {
    const { badRequest } = await import("../../../src/shared/domain/errors.js");
    const ports = routineAdapterPorts();
    const adapter = await routineAdapter(ports);
    const draft = await adapter.draftLifecycle!(workspaceId, targetRef, "publish");
    ports.publish.mockRejectedValueOnce(badRequest("Only draft routine definitions can be published"));
    ports.current.value = storedRoutine({ status: "published" });

    expect(await adapter.applyIfVersionMatches(workspaceId, targetRef, draft.payload, token)).toEqual({
      outcome: "failed",
      reason: "Only draft routine definitions can be published",
    });
  });

  it("does not credit another writer when restore loses the status-precondition race", async () => {
    const { badRequest } = await import("../../../src/shared/domain/errors.js");
    const ports = routineAdapterPorts(storedRoutine({ status: "archived" }));
    const adapter = await routineAdapter(ports);
    const draft = await adapter.draftLifecycle!(workspaceId, targetRef, "restore");
    ports.restore.mockRejectedValueOnce(badRequest("Only archived routine definitions can be restored"));
    ports.current.value = storedRoutine({ status: "published" });

    expect(await adapter.applyIfVersionMatches(workspaceId, targetRef, draft.payload, token)).toEqual({
      outcome: "failed",
      reason: "Only archived routine definitions can be restored",
    });
  });

  it("does not read the version already live as this proposal having landed", async () => {
    // Publishing a revision leaves the previous version published until the flip commits. Accepting
    // any published member of the lineage would mark a failed publish applied and link the old one.
    const ports = routineAdapterPorts();
    const adapter = await routineAdapter(ports);
    const draft = await adapter.draftLifecycle!(workspaceId, targetRef, "publish");
    ports.publish.mockRejectedValueOnce(new Error("routine changed while it was being published"));
    ports.lineage.siblings = [storedRoutine({ id: "previous-version", status: "published", version: 1 })];

    expect(await adapter.applyIfVersionMatches(workspaceId, targetRef, draft.payload, token)).toEqual({
      outcome: "failed",
      reason: "routine changed while it was being published",
    });
  });

  it("still fails when the lifecycle change never landed", async () => {
    const ports = routineAdapterPorts();
    const adapter = await routineAdapter(ports);
    const draft = await adapter.draftLifecycle!(workspaceId, targetRef, "publish");
    ports.publish.mockRejectedValueOnce(new Error("connection reset"));

    expect(await adapter.applyIfVersionMatches(workspaceId, targetRef, draft.payload, token)).toEqual({
      outcome: "failed",
      reason: "connection reset",
    });
  });

  it("refuses a lifecycle move the routine's status cannot take", async () => {
    const adapter = await routineAdapter(routineAdapterPorts());

    await expect(adapter.draftLifecycle!(workspaceId, targetRef, "restore")).rejects.toThrow(/archived/i);
    await expect(adapter.draftLifecycle!(workspaceId, targetRef, "archive")).rejects.toThrow(/published/i);
  });

  it("archives and restores through the service, keeping the card on the same routine", async () => {
    const archivedPorts = routineAdapterPorts(storedRoutine({ status: "published" }));
    const archiveAdapter = await routineAdapter(archivedPorts);
    const archiveDraft = await archiveAdapter.draftLifecycle!(workspaceId, targetRef, "archive");

    expect(await archiveAdapter.applyIfVersionMatches(workspaceId, targetRef, archiveDraft.payload, token)).toEqual({
      outcome: "applied", appliedRef: { agentId, routineId: targetRef.routineId },
    });
    // The disclosed draft (none here) travels into the archive transaction, where a revision
    // created since the card was drafted cannot slip past and be deleted unannounced.
    expect(archivedPorts.archive).toHaveBeenCalledWith(workspaceId, agentId, targetRef.routineId, { expectedDraftRevision: null });

    const restorePorts = routineAdapterPorts(storedRoutine({ status: "archived" }));
    const restoreAdapter = await routineAdapter(restorePorts);
    const restoreDraft = await restoreAdapter.draftLifecycle!(workspaceId, targetRef, "restore");

    expect(await restoreAdapter.applyIfVersionMatches(workspaceId, targetRef, restoreDraft.payload, token)).toEqual({
      outcome: "applied", appliedRef: { agentId, routineId: targetRef.routineId },
    });
    expect(restorePorts.restore).toHaveBeenCalledWith(workspaceId, agentId, targetRef.routineId);
  });
});
