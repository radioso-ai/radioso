import { vi } from "vitest";

import { validateAgentInput } from "../../../src/modules/agents/public.js";
import { createAgentSkillsCopilotTools } from "../../../src/modules/operatorCopilot/tools/agentSkills.js";
import { createAgentConfigurationCopilotTools } from "../../../src/modules/operatorCopilot/tools/agents.js";
import { createChatCopilotTools } from "../../../src/modules/operatorCopilot/tools/chat.js";
import { createDocumentSearchCopilotTools, createDocumentStatusCopilotTools } from "../../../src/modules/operatorCopilot/tools/documents.js";
import { createRoutineDefinitionCopilotTools } from "../../../src/modules/operatorCopilot/tools/routines.js";
import type { RoutineDefinition } from "../../../src/modules/routines/public.js";

export const pageContext = (agentId: string | null) => ({
  view: "agent" as const,
  agentId,
  conversationId: null,
  selection: null,
  entities: [],
});

export const context = (agentId: string | null) => ({
  workspaceId: "workspace-1",
  accountId: "account-1",
  operatorUserId: "operator-1",
  pageContext: pageContext(agentId),
});

export const routine = (overrides: Partial<RoutineDefinition> = {}): RoutineDefinition => ({
  id: "11111111-1111-4111-8111-111111111111",
  agentId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
  lineageId: "33333333-3333-4333-8333-333333333333",
  version: 1,
  status: "draft",
  name: "support-intake",
  activation: {
    triggerDescription: "When the user needs support",
    gateRef: null,
    priority: 7,
    reentryMode: "always",
  },
  slots: [],
  steps: [{
    stableStepId: "collect_topic",
    kind: "chat",
    instruction: "Ask how we can help.",
    toolRef: null,
    actionType: null,
    ordinal: 0,
    metadata: { outlineLabel: "collect_topic" },
  }],
  transitions: [{
    fromStep: "collect_topic",
    toRef: "done",
    guardKind: "default",
    guardText: null,
    outcomeStatus: null,
    counterLimit: null,
    ordinal: 0,
  }],
  terminals: [{ stableStepId: "done", kind: "complete", instruction: null, ordinal: 0 }],
  createdAt: new Date("2026-08-01T10:00:00.000Z"),
  updatedAt: new Date("2026-08-01T10:00:00.000Z"),
  ...overrides,
});

export const authoredDirective = (overrides: Record<string, unknown> = {}) => ({
  id: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
  agentId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
  name: "Do not guess",
  condition: { kind: "always" as const },
  action: "Say when the available evidence is insufficient.",
  priority: 100,
  requiredCapabilities: [],
  dependsOn: [],
  excludes: [],
  routes: [],
  tags: [],
  description: null,
  binding: null,
  lifecycle: null,
  metadata: {},
  createdAt: new Date("2026-08-01T10:00:00.000Z"),
  updatedAt: new Date("2026-08-01T10:00:00.000Z"),
  ...overrides,
});

export const resolvedAgent = (directives = [authoredDirective()]) => ({
  id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
  workspaceId: "workspace-1",
  ...validateAgentInput({
    name: "Support",
    customInstruction: "Answer from the workspace knowledge base.",
    surfaceSettings: {
      anonymousChat: { enabled: true, token: "raw-anonymous-token" },
      websiteEmbed: {
        enabled: true,
        token: "raw-embed-token",
        allowedOrigins: ["https://private.example.com"],
      },
    },
  }),
  authoredDirectives: directives,
  createdAt: new Date("2026-08-01T10:00:00.000Z"),
  updatedAt: new Date("2026-08-01T10:00:00.000Z"),
});

export const dependencies = (routineDefinitions: RoutineDefinition[] = [
  routine(),
  routine({ id: "22222222-2222-4222-8222-222222222222", name: "book-a-demo" }),
], agent = resolvedAgent()) => {
  const listAgents = vi.fn(async () => [{
    id: agent.id,
    name: agent.name,
    isDefault: true,
    assistantBootstrapActive: false,
    customInstruction: "must not leak through the summary",
  }] as never);
  const resolveAgent = vi.fn(async () => agent);
  const listRoutines = vi.fn(async () => routineDefinitions);
  const getRoutine = vi.fn(async (_workspaceId: string, _agentId: string, routineId: string) =>
    routineDefinitions.find((definition) => definition.id === routineId) ?? routine({ id: routineId }));
  const validateRoutine = vi.fn(async () => ({ ok: true, diagnostics: [] as Array<{ code: string; location: string; message: string }> }));
  const getConversation = vi.fn();
  const getConversationTurn = vi.fn();
  const listConversations = vi.fn();
  return {
    listAgents,
    resolveAgent,
    listRoutines,
    getRoutine,
    validateRoutine,
    getConversation,
    getConversationTurn,
    listConversations,
    descriptors: [
      ...createAgentConfigurationCopilotTools({ agentService: { listExisting: listAgents, resolve: resolveAgent } }),
      ...createRoutineDefinitionCopilotTools({ agentLookup: { listExisting: listAgents }, routineDefinitionService: { list: listRoutines, get: getRoutine, validate: validateRoutine } }),
      ...createChatCopilotTools({ chatHistoryService: { getConversation, getConversationTurn, listConversations } }),
      ...createDocumentSearchCopilotTools({ documentSearchService: { search: vi.fn() } }),
    ],
  };
};

export const documentSkillsContext = {
  workspaceId: "workspace-1",
  accountId: "account-1",
  operatorUserId: "operator-1",
  pageContext: { view: "documents" as const, agentId: "agent-1", conversationId: null, selection: null, entities: [] },
};

export const documentStatusPorts = () => {
  const summarizeWorkspace = vi.fn(async () => ({
    documentCount: 12,
    readyDocumentCount: 9,
    pendingDocumentCount: 2,
    failedDocumentCount: 1,
    sampleDocumentCount: 0,
    sampleDocumentSlugs: [],
  }));
  const listByStatuses = vi.fn(async () => [
    {
      id: "document-1",
      title: "Refund policy",
      status: "failed",
      ragStatus: "pending" as const,
      failureReason: "Parser timed out",
      createdAt: new Date("2026-08-01T10:00:00.000Z"),
      updatedAt: new Date("2026-08-02T10:00:00.000Z"),
      metadata: { customerEmail: "person@example.com" },
      sourceId: "source-1",
      sourceKind: "inline_text" as const,
      retrievalEnabled: true,
      retrievalExpiresAt: null,
    },
  ]);
  const listByWorkspaceIdWithDocumentCounts = vi.fn(async () => [
    {
      id: "source-1",
      kind: "website" as const,
      name: "Help center",
      lastSyncStatus: "failed",
      lastSyncedAt: new Date("2026-08-02T09:00:00.000Z"),
      documentCount: 4,
      config: { crawlerApiKey: "sk-secret-value" },
      metadata: { seedUrl: "https://help.example.com" },
    },
  ]);
  return { summarizeWorkspace, listByStatuses, listByWorkspaceIdWithDocumentCounts };
};

export const agentSkillPorts = () => {
  const get = vi.fn(async (_workspaceId: string, agentId: string) => ({ id: agentId, name: "Support" }) as never);
  const list = vi.fn(async () => [
    {
      id: "skill-1",
      name: "notify_ops",
      capability: "notify",
      target: { kind: "webhook_destination", id: "target-1" },
      config: { boundPayload: { customerEmail: "person@example.com" }, delivery: { token: "shhh-secret" } },
      invocationMode: "routine_named",
      enabled: true,
    },
  ]);
  const registryList = vi.fn(() => [
    {
      id: "notify",
      targetKind: "webhook_destination",
      requiresTarget: true,
      enumerateTargets: vi.fn(async () => [{ id: "target-1", label: "Ops webhook", status: "active" }]),
    },
    {
      id: "mcp_tool",
      targetKind: "mcp_connection",
      requiresTarget: true,
      enumerateTargets: vi.fn(async () => []),
    },
    {
      id: "retrieve",
      targetKind: "workspace",
      requiresTarget: false,
      enumerateTargets: vi.fn(async () => []),
    },
  ]);
  return { get, list, registryList };
};

export const buildDescriptors = (
  documents = documentStatusPorts(),
  skills = agentSkillPorts(),
) => [
  ...createDocumentStatusCopilotTools({
    documentStatusService: {
      summarizeWorkspace: documents.summarizeWorkspace,
      listByStatuses: documents.listByStatuses,
    },
    documentSourceStatusService: {
      listByWorkspaceIdWithDocumentCounts: documents.listByWorkspaceIdWithDocumentCounts,
    },
  }),
  ...createAgentSkillsCopilotTools({
    agentService: { get: skills.get },
    agentSkillsService: { list: skills.list },
    skillCapabilityRegistry: { list: skills.registryList },
  }),
];
