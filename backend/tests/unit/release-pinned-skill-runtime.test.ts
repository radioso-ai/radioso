import { describe, expect, it, vi } from "vitest";

import { createToolSkillExecutor } from "@radioso/conversation-tools";

import { SkillBackedContextResolver } from "../../src/app/composition/builtIn/contextResolverModule.js";
import { buildConversationScopedSkillLookups } from "../../src/app/composition/conversationSkills.js";
import { createPublishedRoutineRegistrationSource } from "../../src/app/composition/routineDefinitionSource.js";
import { createCompletionExportResolver } from "../../src/app/composition/routineTurnProvider.js";
import { ConversationSkills } from "../../src/modules/agentSkills/conversationSkills.js";
import type { AgentSkillSpine } from "../../src/modules/agentSkills/public.js";
import { applyAgentRevisionSnapshot, type AgentRevision } from "../../src/modules/agents/public.js";
import type { AgentRecord } from "../../src/modules/agents/domain.js";
import { ConfiguredContactDeliveryResolver } from "../../src/modules/chat/services/actions/contactSendActionHandler.js";
import { ConversationAgentWebhookPermissionResolver } from "../../src/modules/chat/services/actions/webhookSendActionHandler.js";
import { McpSkillExecutor } from "../../src/modules/externalSkills/executor/mcpSkillExecutor.js";
import { SdkMcpToolService } from "../../src/modules/externalSkills/toolService/sdkMcpToolService.js";
import { NotifyExecutor } from "../../src/modules/notify/notifyExecutor.js";
import type { RoutineDefinition } from "../../src/modules/routines/public.js";
import { RoutineSkillExecutorDispatcher, StaticRoutineSkillResolver } from "../../src/modules/routines/skillDispatcher.js";
import { SkillExecutorRegistry, type SkillInvocation } from "../../src/modules/skills/public.js";
import { conversationSkillsOf } from "../../src/shared/domain/conversationSkills.js";
import { connectMockMcpServer } from "../support/mockMcpServer.js";

// A skill edit lands in the agent's draft and in the live agent_skills row at once. Every path that
// runs a skill for a conversation must read the row its release froze, so the edit reaches that
// conversation only once it is published.

const workspaceId = "11111111-1111-4111-8111-111111111111";
const agentId = "22222222-2222-4222-8222-222222222222";
const conversationId = "33333333-3333-4333-8333-333333333333";
const noopEmit = { emitStatus: async () => undefined, emitCustom: async () => undefined };

const skill = (overrides: Partial<AgentSkillSpine>): AgentSkillSpine => ({
  id: "44444444-4444-4444-8444-444444444444",
  agentId,
  workspaceId,
  skillName: "lookup_orders",
  kind: "external_mcp",
  invocationMode: "agent_selectable",
  enabled: true,
  targetType: "mcp_connection",
  targetId: "55555555-5555-4555-8555-555555555555",
  config: {},
  createdAt: new Date("2026-11-01T09:00:00.000Z"),
  updatedAt: new Date("2026-11-01T09:00:00.000Z"),
  ...overrides,
});

const conversationSkills = (live: AgentSkillSpine[], release: AgentSkillSpine[] | undefined) => new ConversationSkills({
  live: { listByAgent: async () => live },
  releases: { findConversationRelease: async () => ({ ...(release ? { agentSkills: release } : {}) }) },
});

describe("an MCP skill a released conversation runs", () => {
  it("runs the release's tool binding after the skill was switched off and rebound live", async () => {
    const released = skill({ config: { toolName: "lookup_order", boundParams: { region: "eu" }, exposedParams: { orderNumber: {} } } });
    const calls: Array<{ name: string; args: unknown }> = [];
    const { clientTransport } = await connectMockMcpServer([
      { name: "lookup_order", respond: (args) => { calls.push({ name: "lookup_order", args }); return { content: [{ type: "text", text: "found" }] }; } },
      { name: "delete_order", respond: (args) => { calls.push({ name: "delete_order", args }); return { content: [{ type: "text", text: "gone" }] }; } },
    ]);
    const lookups = buildConversationScopedSkillLookups(conversationSkills([], undefined), {
      // Live: switched off (no enabled row) since the release was published.
      externalSkills: { findEnabledByName: async () => null },
      webhookSkills: { findEnabledByName: async () => null },
      emailSkills: { findEnabledByName: async () => null },
      slackSkills: { findEnabledByName: async () => null },
      agentSkills: { findByName: async () => null },
    });
    const executor = new McpSkillExecutor({
      skills: lookups.externalMcp,
      connections: { findById: async (_workspaceId, id) => ({ id, serverUrl: "https://mcp.acme.example", authMethod: "access_token" }) },
      toolServices: { create: () => new SdkMcpToolService({ transportFactory: () => clientTransport }) },
      toolSkillExecutorFactory: createToolSkillExecutor,
    });

    const result = await executor.dispatch({
      skill: { name: "lookup_orders" },
      collected: { orderNumber: "A-100" },
      context: { workspaceId, agentId, conversationSkills: [released] },
      emit: noopEmit,
    });

    expect(result).toMatchObject({ disposition: "settled", outcome: { status: "completed" } });
    expect(calls).toEqual([{ name: "lookup_order", args: { region: "eu", orderNumber: "A-100" } }]);
  });
});

describe("a notify skill and a contact request a released conversation runs", () => {
  const released = skill({
    skillName: "contact_human",
    kind: "notify",
    invocationMode: "routine_named",
    targetType: "notify_delivery",
    targetId: null,
    config: { delivery: { recipientEmails: ["support@acme.example"], webhook: null } },
  });
  const editedLive = { ...released, enabled: false, config: { delivery: { recipientEmails: ["sales@acme.example"], webhook: null } } };

  it("queues the notice through the release's enabled skill though it was switched off live", async () => {
    const enqueue = vi.fn(async () => ({ id: "action-1", duplicate: false }));
    const lookups = buildConversationScopedSkillLookups(conversationSkills([editedLive], [released]), {
      externalSkills: { findEnabledByName: async () => null },
      webhookSkills: { findEnabledByName: async () => null },
      emailSkills: { findEnabledByName: async () => null },
      slackSkills: { findEnabledByName: async () => null },
      agentSkills: { findByName: async () => editedLive },
    });
    const executor = new NotifyExecutor({ skills: lookups.notify, outbox: { enqueue } });

    const result = await executor.dispatch({
      skill: { name: "contact_human" },
      collected: { message: "Please call me back" },
      context: { workspaceId, agentId, conversationId, sessionId: conversationId, conversationSkills: [released] },
      emit: noopEmit,
    });

    expect(result).toMatchObject({ disposition: "settled", outcome: { status: "delivered" } });
    expect(enqueue).toHaveBeenCalledTimes(1);
  });

  it("delivers a queued request to the release's recipients, not the ones edited live", async () => {
    const resolver = new ConfiguredContactDeliveryResolver(
      { findByIdAndWorkspaceId: async () => ({ agentId }) },
      { findByIdAndWorkspaceId: async () => ({ contactRequestDelivery: { recipientEmails: [], webhook: null } }) },
      { resolve: async () => ({ emails: ["owner@acme.example"], webhook: null }) },
      { findByName: async () => editedLive },
      conversationSkills([editedLive], [released]),
    );

    await expect(resolver.resolve({ workspaceId, conversationId } as never)).resolves.toMatchObject({
      emails: ["support@acme.example"],
      via: "contact_human",
    });
  });

  it("gates the contact routine on the release's contact_human switch", () => {
    const liveAgent = { id: agentId, workspaceId, contactRequestsEnabled: true, contactRequestDelivery: { recipientEmails: ["sales@acme.example"], webhook: null } } as unknown as AgentRecord;
    const revision = {
      id: "66666666-6666-4666-8666-666666666666",
      snapshot: { customInstruction: "", directives: [], routines: [], contextVariableEnablements: [], agentSkills: [{ ...released, enabled: false }] },
      sourceDraftGeneration: 1,
      sourceBasePublishedRevisionId: null,
      createdAt: new Date(),
      publishedAt: new Date(),
      publishedVersion: 1,
    } as AgentRevision;

    expect(applyAgentRevisionSnapshot(liveAgent, revision)).toMatchObject({ contactRequestsEnabled: false });
  });
});

describe("a routine a released conversation runs", () => {
  it("hands the conversation's skills to the executor a routine skill step dispatches", async () => {
    const released = skill({ skillName: "post_ticket", kind: "webhook", invocationMode: "routine_named" });
    const seen: SkillInvocation[] = [];
    const registry = new SkillExecutorRegistry();
    const execution = { kind: "internal" as const, adapter: "release-test", enqueue: false };
    registry.register({ ...execution, executor: { dispatch: async (invocation) => { seen.push(invocation); return { disposition: "settled", outcome: { status: "completed" } }; } } });
    const dispatcher = new RoutineSkillExecutorDispatcher(
      new StaticRoutineSkillResolver([{ name: "post_ticket", execution } as never]),
      registry,
      { workspaceId, conversationSkills: [released] },
    );

    await dispatcher.dispatch({
      skillName: "post_ticket",
      state: { routineId: "r-1", path: ["s-1"], variables: {} },
      turn: { sessionId: conversationId, agent: { id: agentId }, inputEvent: { id: "m-1", kind: "message", content: "" }, history: [], stagedContext: [], steering: [] },
    } as never);

    expect(conversationSkillsOf(seen[0]?.context)).toEqual([released]);
  });
});

describe("a context resolver a released conversation runs", () => {
  it("resolves through the release's resolver skill though it was switched off live", async () => {
    const execution = { kind: "internal" as const, adapter: "resolver-release-test", enqueue: false };
    const released = skill({ skillName: "order_status", kind: "external_mcp", config: { execution } });
    const seen: SkillInvocation[] = [];
    const registry = new SkillExecutorRegistry();
    registry.register({ ...execution, executor: { dispatch: async (invocation) => { seen.push(invocation); return { disposition: "settled", outcome: { status: "completed", outputs: { value: "shipped" } } }; } } });
    const resolver = new SkillBackedContextResolver({
      agentSkills: { findById: async () => ({ ...released, enabled: false }) },
      skillExecutorRegistry: registry,
    });

    const resolved = await resolver.resolve({
      workspaceId,
      agentId,
      resolverSkillId: released.id,
      variableName: "order_status",
      scope: { type: "session", id: conversationId },
      conversationSkills: [released],
    });

    expect(resolved).toEqual({ value: "shipped" });
    expect(conversationSkillsOf(seen[0]?.context)).toEqual([released]);
  });
});

describe("a completion export a released conversation runs", () => {
  const exportSkill = skill({
    skillName: "completion_export",
    kind: "webhook",
    invocationMode: "routine_named",
    targetType: "webhook_destination",
    targetId: "77777777-7777-4777-8777-777777777777",
  });
  const definition: RoutineDefinition = {
    id: "88888888-8888-4888-8888-888888888888",
    agentId,
    lineageId: "99999999-9999-4999-8999-999999999999",
    name: "booking",
    version: 1,
    enabled: true,
    activation: { triggerDescription: "The visitor wants to book.", gateRef: null, priority: 10, reentryMode: "once_per_conversation" },
    slots: [],
    steps: [{ stableStepId: "ask", kind: "chat", instruction: "Ask for the date.", toolRef: null, ordinal: 0, metadata: {} }],
    transitions: [{ fromStep: "ask", toRef: "done", guardKind: "default", guardText: null, ordinal: 0 }],
    terminals: [{ stableStepId: "done", kind: "complete", instruction: "Confirm.", ordinal: 0 }],
    createdAt: new Date("2026-11-01T09:00:00.000Z"),
    updatedAt: new Date("2026-11-01T09:00:00.000Z"),
  };

  it("exports through the release's completion_export skill though it was switched off live", async () => {
    const revision = {
      id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      snapshot: { customInstruction: "", directives: [], routines: [definition], contextVariableEnablements: [], agentSkills: [exportSkill] },
      sourceDraftGeneration: 1,
      sourceBasePublishedRevisionId: null,
      createdAt: new Date(),
      publishedAt: new Date(),
      publishedVersion: 1,
    } as AgentRevision;
    const source = createPublishedRoutineRegistrationSource({ listActiveByAgent: async () => [], listVersionsByAgent: async () => [], findPinnedById: async () => null, findById: async () => null }, {
      revisionReader: { findRevision: async () => revision },
      resolveCompletionExport: createCompletionExportResolver(conversationSkills([{ ...exportSkill, enabled: false }], undefined)),
    });

    const [registration] = await source.load({ agentId, workspaceId, agentRevisionId: revision.id });

    expect(registration?.routine.completionExport).toMatchObject({ enabled: true, destinationRef: exportSkill.targetId });
  });

  it("lets a queued export through while the conversation's release has completion_export on", async () => {
    const resolver = new ConversationAgentWebhookPermissionResolver(
      { findByIdAndWorkspaceId: async () => ({ agentId }) },
      { findByIdAndWorkspaceId: async () => ({ webhookExportsEnabled: false }) },
      { findByName: async () => ({ ...exportSkill, enabled: false }) },
      conversationSkills([{ ...exportSkill, enabled: false }], [exportSkill]),
    );

    await expect(resolver.canSend({ workspaceId, conversationId } as never)).resolves.toEqual({ allowed: true });
  });
});
