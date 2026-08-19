import { z } from "zod";

import { serializeAgentConfig, type AgentConfig, type AgentService } from "../agents/public.js";
import { builtInAnswerDirectiveViews, type BuiltInDirectiveView } from "../directives/public.js";
import {
  projectRoutineToPortableDocument,
  type RoutineDefinition,
  type RoutineDefinitionService,
} from "../routines/public.js";
import type {
  CopilotAgentSettingProposalAdapter,
  CopilotAuditPort,
  CopilotDirectiveProposalAdapter,
  CopilotRoutineProposalAdapter,
  CopilotProposal,
  CopilotToolDescriptor,
} from "./contracts.js";
import type { CopilotRepositoryPort } from "./service.js";
import { boundConversationPayload, boundPayload } from "./boundedPayload.js";

const idSchema = z.string().uuid();
const unknownRecord = z.record(z.unknown());
const optionalAgentInput = z.object({ agentId: idSchema.optional() });
const agentConfigurationInputSchema = z.object({
  mode: z.enum(["auto", "list", "detail"]).optional(),
  agentId: idSchema.optional(),
  directiveId: idSchema.optional(),
}).strict();
const agentConfigurationOutputSchema = z.discriminatedUnion("mode", [
  z.object({
    mode: z.literal("list"),
    agentCount: z.number().int().nonnegative(),
    agentsTruncated: z.boolean(),
    agents: z.array(unknownRecord),
    agent: z.null(),
  }),
  z.object({
    mode: z.literal("detail"),
    agentCount: z.null(),
    agentsTruncated: z.null(),
    agents: z.array(unknownRecord).max(0),
    agent: unknownRecord,
  }),
]);
const routineDefinitionOutputSchema = z.object({
  routineCount: z.number().int().nonnegative(),
  routinesTruncated: z.boolean(),
  routine: unknownRecord.nullable(),
  routines: z.array(unknownRecord),
});

const copilotAgentListLimit = 40;
const copilotDirectiveListLimit = 40;
const copilotBuiltInDirectiveListLimit = 20;
const copilotBuiltInDirectiveActionCharLimit = 8_000;
const copilotBuiltInDirectiveTotalActionCharBudget = 20_000;
const copilotDirectiveDetailCollectionLimit = 10;
const copilotDirectiveMetadataCharLimit = 4_000;
const copilotDirectiveDetailCharBudget = 24_000;
const copilotRoutineListLimit = 40;
const copilotRoutineContentCharLimit = 20_000;

/**
 * Narrow ports over other modules' public services. The copilot owns these
 * consumer-shaped contracts so it never imports another module's internals.
 */
export interface CopilotConversationHistoryPort {
  getConversation(workspaceId: string, conversationId: string, options: { limit: number }, debug: { includeTurnFailureDebug: boolean }): Promise<unknown>;
  listConversations(workspaceId: string, options: { limit: number }): Promise<{ conversations: ReadonlyArray<unknown> }>;
}

export interface CopilotDocumentSearchPort {
  search(input: { workspaceId: string; query: string; executionSurface: "operator_copilot" }): Promise<{ results: ReadonlyArray<unknown> }>;
}

export interface CopilotEvalResultsPort {
  listWithLatestRun(workspaceId: string): Promise<ReadonlyArray<object>>;
}

export interface CopilotQualitySignalsPort {
  getQualityStats(workspaceId: string, input: { range: "30d"; agentId?: string }): Promise<object>;
  listLowQualityTurns(workspaceId: string, input: { limit: number; agentId?: string }): Promise<{ items: ReadonlyArray<object> }>;
}

export interface CopilotAudiencePulsePort {
  read(input: { accountId: string; userId: string; workspaceId: string }): Promise<object>;
}

export interface CopilotDocumentStatusPort {
  summarizeWorkspace(workspaceId: string): Promise<{
    documentCount: number;
    readyDocumentCount: number;
    pendingDocumentCount: number;
    failedDocumentCount: number;
  }>;
  listByStatuses(workspaceId: string, statuses: ReadonlyArray<string>, input: { limit: number }): Promise<ReadonlyArray<{
    id: string;
    title: string;
    status: string;
    failureReason?: string | null;
    updatedAt: Date;
    sourceId?: string | null;
  }>>;
}

export interface CopilotDocumentSourceStatusPort {
  listByWorkspaceIdWithDocumentCounts(workspaceId: string): Promise<ReadonlyArray<{
    id: string;
    kind: string;
    name: string;
    lastSyncStatus: string | null;
    lastSyncedAt: Date | null;
    documentCount: number;
  }>>;
}

export interface CopilotAgentSkillsPort {
  list(workspaceId: string, agentId: string): Promise<ReadonlyArray<{
    name: string;
    capability: string;
    target: { kind: string | null; id: string | null };
    config: Record<string, unknown>;
    invocationMode: string;
    enabled: boolean;
  }>>;
}

export interface CopilotSkillCapabilityTargetsPort {
  list(): ReadonlyArray<{
    id: string;
    targetKind: string;
    requiresTarget?: boolean;
    enumerateTargets(context: { workspaceId: string; agentId: string }): Promise<ReadonlyArray<{ id: string; label: string; status?: string }>>;
  }>;
}

export const createUs1CopilotTools = (deps: {
  readonly agentService: Pick<AgentService, "listExisting" | "resolve">;
  readonly routineDefinitionService: Pick<RoutineDefinitionService, "list" | "get">;
  readonly chatHistoryService: CopilotConversationHistoryPort;
  readonly documentSearchService: CopilotDocumentSearchPort;
}): ReadonlyArray<CopilotToolDescriptor> => [
  {
    name: "agent_configuration", uiLabel: "Reading agent configuration", contributingModule: "agents", requiredPermission: "workspace.agents.read",
    description: "List workspace agents or read one agent's redacted portable configuration. Use mode list to override page context. A directive id returns that directive in full.",
    inputSchema: agentConfigurationInputSchema, outputSchema: agentConfigurationOutputSchema,
    createTool: (context) => ({
      name: "agent_configuration",
      description: "List workspace agents or read one agent's redacted portable configuration. Use mode list to override page context. A directive id returns that directive in full.",
      inputSchema: agentConfigurationInputSchema,
      outputSchema: agentConfigurationOutputSchema,
      invoke: async ({ mode = "auto", agentId, directiveId }) => {
        if (mode === "list") {
          if (agentId || directiveId) throw new Error("Agent discovery does not accept an agent or directive id");
          const agents = await deps.agentService.listExisting(context.workspaceId);
          return {
            mode: "list" as const,
            agentCount: agents.length,
            agentsTruncated: agents.length > copilotAgentListLimit,
            agents: projectAgentSummaries(agents),
            agent: null,
          };
        }

        const resolvedAgentId = agentId ?? (mode === "detail" || directiveId
          ? requiredPageAgent(context.pageContext.agentId)
          : context.pageContext.agentId);
        if (!resolvedAgentId) {
          const agents = await deps.agentService.listExisting(context.workspaceId);
          return {
            mode: "list" as const,
            agentCount: agents.length,
            agentsTruncated: agents.length > copilotAgentListLimit,
            agents: projectAgentSummaries(agents),
            agent: null,
          };
        }

        const selectedAgent = await deps.agentService.resolve(context.workspaceId, resolvedAgentId);
        return {
          mode: "detail" as const,
          agentCount: null,
          agentsTruncated: null,
          agents: [],
          agent: projectAgentConfiguration(selectedAgent, directiveId),
        };
      },
    }),
    describeEntity: ({ mode, agentId }, context) => mode === "list"
      ? null
      : entity("agent", agentId ?? context?.pageContext.agentId),
  },
  {
    name: "routine_definition", uiLabel: "Reading routine", contributingModule: "routines", requiredPermission: "workspace.agents.read",
    description: "List an agent's routines or read one routine in portable Markdown form.",
    inputSchema: z.object({ agentId: idSchema.optional(), routineId: idSchema.optional() }), outputSchema: routineDefinitionOutputSchema,
    createTool: (context) => ({
      name: "routine_definition",
      description: "List an agent's routines or read one routine in portable Markdown form.",
      inputSchema: z.object({ agentId: idSchema.optional(), routineId: idSchema.optional() }),
      outputSchema: routineDefinitionOutputSchema,
      invoke: async ({ agentId, routineId }) => {
        const resolvedAgentId = agentId ?? requiredPageAgent(context.pageContext.agentId);
        if (routineId) {
          const routine = await deps.routineDefinitionService.get(context.workspaceId, resolvedAgentId, routineId);
          return {
            routineCount: 1,
            routinesTruncated: false,
            routine: projectRoutineDetail(routine),
            routines: [],
          };
        }
        const definitions = await deps.routineDefinitionService.list(context.workspaceId, resolvedAgentId);
        return {
          routineCount: definitions.length,
          routinesTruncated: definitions.length > copilotRoutineListLimit,
          routine: null,
          routines: definitions.slice(0, copilotRoutineListLimit).map(projectRoutineSummary),
        };
      },
    }),
    describeEntity: ({ routineId }) => entity("routine", routineId),
  },
  {
    name: "conversation_trace", uiLabel: "Reading conversation trace", contributingModule: "chat", requiredPermission: "workspace.history.read",
    description: "Read a customer conversation transcript and its retained turn trace envelope.",
    inputSchema: z.object({ conversationId: idSchema.optional() }), outputSchema: z.object({ conversation: unknownRecord }),
    createTool: (context) => ({ name: "conversation_trace", description: "Read a customer conversation transcript and its retained turn trace envelope.", inputSchema: z.object({ conversationId: idSchema.optional() }), outputSchema: z.object({ conversation: unknownRecord }), invoke: async ({ conversationId }) => ({ conversation: boundConversationPayload(await deps.chatHistoryService.getConversation(context.workspaceId, conversationId ?? requiredPageConversation(context.pageContext.conversationId), { limit: 100 }, { includeTurnFailureDebug: false }) as Record<string, unknown>) }) }),
    describeEntity: ({ conversationId }, context) => entity("conversation", conversationId ?? context?.pageContext.conversationId),
  },
  {
    name: "conversation_history_search", uiLabel: "Searching conversations", contributingModule: "chat", requiredPermission: "workspace.history.read",
    description: "List recent customer conversations in this workspace for investigation.",
    inputSchema: z.object({ limit: z.number().int().min(1).max(50).optional() }), outputSchema: z.object({ conversations: z.array(unknownRecord) }),
    createTool: (context) => ({ name: "conversation_history_search", description: "List recent customer conversations in this workspace for investigation.", inputSchema: z.object({ limit: z.number().int().min(1).max(50).optional() }), outputSchema: z.object({ conversations: z.array(unknownRecord) }), invoke: async ({ limit }) => ({ conversations: boundPayload({ conversations: (await deps.chatHistoryService.listConversations(context.workspaceId, { limit: limit ?? 20 })).conversations as Record<string, unknown>[] }).conversations as Record<string, unknown>[] }) }),
  },
  {
    name: "document_search", uiLabel: "Searching documents", contributingModule: "documents", requiredPermission: "workspace.documents.read",
    description: "Search workspace documents and return matching document metadata and quoted evidence snippets — the only document text available to you.",
    inputSchema: z.object({ query: z.string().min(1).max(1000) }), outputSchema: z.object({ results: z.array(unknownRecord) }),
    createTool: (context) => ({ name: "document_search", description: "Search workspace documents and return matching document metadata and quoted evidence snippets — the only document text available to you.", inputSchema: z.object({ query: z.string().min(1).max(1000) }), outputSchema: z.object({ results: z.array(unknownRecord) }), invoke: async ({ query }) => ({ results: boundPayload({ results: (await deps.documentSearchService.search({ workspaceId: context.workspaceId, query, executionSurface: "operator_copilot" })).results as Record<string, unknown>[] }).results as Record<string, unknown>[] }) }),
  },
];

const projectAgentSummaries = (
  agents: Awaited<ReturnType<AgentService["listExisting"]>>,
) => agents.slice(0, copilotAgentListLimit).map((agent) => ({
  id: agent.id,
  name: agent.name,
  isDefault: agent.isDefault,
  assistantBootstrapActive: agent.assistantBootstrapActive,
}));

const projectAgentConfiguration = (
  agent: Awaited<ReturnType<AgentService["resolve"]>>,
  directiveId: string | undefined,
): Record<string, unknown> => {
  const serialized = serializeAgentConfig(agent);
  const { authoredDirectives: portableDirectives, ...portableAgent } = serialized;
  const directives = agent.authoredDirectives ?? [];
  const selectedIndex = directiveId
    ? directives.findIndex((directive) => directive.id === directiveId)
    : -1;
  if (directiveId && selectedIndex < 0) throw new Error("Directive not found");

  const visibleIndexes = Array.from(
    { length: Math.min(directives.length, copilotDirectiveListLimit) },
    (_, index) => index,
  );
  if (selectedIndex >= copilotDirectiveListLimit) {
    visibleIndexes[visibleIndexes.length - 1] = selectedIndex;
  }

  return {
    id: agent.id,
    ...boundPayload(portableAgent as unknown as Record<string, unknown>),
    authoredDirectives: visibleIndexes.map((index) => ({
      id: directives[index]!.id,
      name: directives[index]!.name,
      priority: directives[index]!.priority,
      actionChars: directives[index]!.action.length,
    })),
    directiveCount: directives.length,
    directivesTruncated: directives.length > copilotDirectiveListLimit,
    directiveRefs: visibleIndexes.map((index) => ({
      id: directives[index]!.id,
      name: directives[index]!.name,
    })),
    builtInDirectiveCount: builtInAnswerDirectiveViews.length,
    builtInsTruncated: builtInAnswerDirectiveViews.length > copilotBuiltInDirectiveListLimit,
    builtIns: projectBuiltInDirectives(builtInAnswerDirectiveViews),
    directive: selectedIndex >= 0
      ? projectDirectiveDetail(directives[selectedIndex]!.id, portableDirectives[selectedIndex]!)
      : null,
  };
};

const projectBuiltInDirectives = (
  directives: ReadonlyArray<BuiltInDirectiveView>,
): ReadonlyArray<Record<string, unknown>> => {
  let remainingActionChars = copilotBuiltInDirectiveTotalActionCharBudget;
  return directives.slice(0, copilotBuiltInDirectiveListLimit).map((directive) => {
    const actionTooLarge = directive.action.length > copilotBuiltInDirectiveActionCharLimit;
    const exceedsTotalBudget = directive.action.length > remainingActionChars;
    const omittedReason = actionTooLarge
      ? "content_too_large"
      : exceedsTotalBudget ? "total_budget" : null;
    if (!omittedReason) remainingActionChars -= directive.action.length;
    const boundedIdentity = boundPayload({
      name: directive.name,
      condition: directive.condition,
      priority: directive.priority,
      description: directive.description,
    });
    return {
      ...boundedIdentity,
      action: omittedReason ? null : directive.action,
      actionChars: directive.action.length,
      omittedReason,
    };
  });
};

const directiveCollectionKeys = [
  "requiredCapabilities",
  "dependsOn",
  "excludes",
  "routes",
  "tags",
] as const satisfies ReadonlyArray<keyof AgentConfig["authoredDirectives"][number]>;

const projectDirectiveDetail = (
  id: string,
  directive: AgentConfig["authoredDirectives"][number],
): Record<string, unknown> => {
  const metadataChars = JSON.stringify(directive.metadata).length;
  const metadataOmitted = metadataChars > copilotDirectiveMetadataCharLimit;
  const truncatedCollections = directiveCollectionKeys.filter(
    (key) => directive[key].length > copilotDirectiveDetailCollectionLimit,
  );
  const boundedCollections = Object.fromEntries(directiveCollectionKeys.map((key) => [
    key,
    directive[key].slice(0, copilotDirectiveDetailCollectionLimit),
  ]));
  const projected = {
    id,
    ...directive,
    ...boundedCollections,
    metadata: metadataOmitted ? null : directive.metadata,
    detailBounds: {
      metadataOmittedReason: metadataOmitted ? "content_too_large" : null,
      truncatedCollections,
    },
  };
  const projectedChars = JSON.stringify(projected).length;
  if (projectedChars <= copilotDirectiveDetailCharBudget) return projected;

  const allPopulatedCollections = directiveCollectionKeys.filter((key) => directive[key].length > 0);
  const withoutCollections = {
    ...projected,
    ...Object.fromEntries(directiveCollectionKeys.map((key) => [key, []])),
    metadata: null,
    detailBounds: {
      metadataOmittedReason: "total_budget",
      truncatedCollections: allPopulatedCollections,
      charBudget: copilotDirectiveDetailCharBudget,
      originalChars: projectedChars,
    },
  };
  if (JSON.stringify(withoutCollections).length <= copilotDirectiveDetailCharBudget) return withoutCollections;

  return {
    id,
    name: directive.name,
    priority: directive.priority,
    action: null,
    detailBounds: {
      detailOmittedReason: "content_too_large",
      charBudget: copilotDirectiveDetailCharBudget,
      originalChars: projectedChars,
    },
  };
};

const routineIdentity = (routine: RoutineDefinition) => ({
  id: routine.id,
  name: routine.name,
  status: routine.status,
});

const projectRoutineSummary = (routine: RoutineDefinition): Record<string, unknown> => {
  const projected = projectRoutineToPortableDocument(routine);
  if (!projected.ok) {
    return { ...routineIdentity(routine), portable: projected };
  }
  return {
    ...routineIdentity(routine),
    portable: {
      ok: true,
      grammarVersion: projected.envelope.grammarVersion,
      contentChars: projected.envelope.content.length,
    },
  };
};

const projectRoutineDetail = (routine: RoutineDefinition): Record<string, unknown> => {
  const projected = projectRoutineToPortableDocument(routine);
  if (!projected.ok) {
    return { ...routineIdentity(routine), portable: projected };
  }
  const contentChars = projected.envelope.content.length;
  const contentTooLarge = contentChars > copilotRoutineContentCharLimit;
  return {
    ...routineIdentity(routine),
    portable: {
      ok: true,
      grammarVersion: projected.envelope.grammarVersion,
      content: contentTooLarge ? null : projected.envelope.content,
      contentChars,
      omittedReason: contentTooLarge ? "content_too_large" : null,
    },
  };
};

export const createUs2CopilotTools = (deps: {
  readonly evalResultsService: CopilotEvalResultsPort;
  readonly qualitySignalsService: CopilotQualitySignalsPort;
  readonly audiencePulseService: CopilotAudiencePulsePort;
}): ReadonlyArray<CopilotToolDescriptor> => [
  {
    name: "eval_results", uiLabel: "Reading eval results", contributingModule: "eval", requiredPermission: "workspace.retrieval.query",
    description: "Read recent evaluation cases and their latest outcomes for an agent.",
    inputSchema: z.object({ agentId: idSchema.optional(), limit: z.number().int().min(1).max(50).optional() }), outputSchema: z.object({ cases: z.array(unknownRecord) }),
    createTool: (context) => ({ name: "eval_results", description: "Read recent evaluation cases and their latest outcomes for an agent.", inputSchema: z.object({ agentId: idSchema.optional(), limit: z.number().int().min(1).max(50).optional() }), outputSchema: z.object({ cases: z.array(unknownRecord) }), invoke: async ({ agentId, limit }) => {
      const resolvedAgentId = agentId ?? requiredPageAgent(context.pageContext.agentId);
      const cases = (await deps.evalResultsService.listWithLatestRun(context.workspaceId)).map(asRecord)
        .filter((item) => agentIdForEvalCase(item) === resolvedAgentId)
        .sort((left, right) => newestEvalResultFirst(left, right))
        .slice(0, limit ?? 20);
      return boundPayload({ cases }) as { cases: Record<string, unknown>[] };
    } }),
  },
  {
    name: "quality_signals", uiLabel: "Reading quality signals", contributingModule: "quality", requiredPermission: "workspace.quality.read",
    description: "Read workspace quality and needs-attention signals.",
    inputSchema: optionalAgentInput, outputSchema: z.object({ summary: unknownRecord, needsAttention: z.array(unknownRecord) }),
    createTool: (context) => ({ name: "quality_signals", description: "Read workspace quality and needs-attention signals.", inputSchema: optionalAgentInput, outputSchema: z.object({ summary: unknownRecord, needsAttention: z.array(unknownRecord) }), invoke: async ({ agentId }) => {
      const resolvedAgentId = agentId ?? context.pageContext.agentId ?? undefined;
      const [summary, needsAttention] = await Promise.all([
        deps.qualitySignalsService.getQualityStats(context.workspaceId, { range: "30d", ...(resolvedAgentId ? { agentId: resolvedAgentId } : {}) }),
        deps.qualitySignalsService.listLowQualityTurns(context.workspaceId, { limit: 20, ...(resolvedAgentId ? { agentId: resolvedAgentId } : {}) }),
      ]);
      return boundPayload({ summary: asRecord(summary), needsAttention: needsAttention.items.map(asRecord) }) as { summary: Record<string, unknown>; needsAttention: Record<string, unknown>[] };
    } }),
  },
  {
    name: "audience_topics", uiLabel: "Reading audience topics", contributingModule: "audiencePulse", requiredPermission: "workspace.quality.read",
    description: "Read the latest stored Audience Pulse topic census. This never starts a new analysis.",
    inputSchema: z.object({}), outputSchema: z.object({ result: unknownRecord }),
    createTool: (context) => ({ name: "audience_topics", description: "Read the latest stored Audience Pulse topic census. This never starts a new analysis.", inputSchema: z.object({}), outputSchema: z.object({ result: unknownRecord }), invoke: async () => boundPayload({ result: asRecord(await deps.audiencePulseService.read({ accountId: context.accountId, userId: context.operatorUserId, workspaceId: context.workspaceId })) }) }),
  },
];

const documentAttentionStatuses = ["failed", "queued", "processing"] as const;
const documentAttentionLimit = 25;

const documentStatusOutputSchema = z.object({
  counts: z.object({ total: z.number(), ready: z.number(), pending: z.number(), failed: z.number() }),
  attention: z.array(unknownRecord),
  sources: z.array(unknownRecord),
});
const agentSkillsOutputSchema = z.object({ skills: z.array(unknownRecord), capabilities: z.array(unknownRecord) });

/**
 * Operability readers: how the workspace's knowledge base is processing, and what
 * an agent can actually do. Both project their source records field by field —
 * document content, document metadata values, source credentials, and skill
 * config values never reach the model.
 */
export const createUs4CopilotTools = (deps: {
  readonly agentService: Pick<AgentService, "get">;
  readonly documentStatusService: CopilotDocumentStatusPort;
  readonly documentSourceStatusService: CopilotDocumentSourceStatusPort;
  readonly agentSkillsService: CopilotAgentSkillsPort;
  readonly skillCapabilityRegistry: CopilotSkillCapabilityTargetsPort;
}): ReadonlyArray<CopilotToolDescriptor> => [
  {
    name: "document_status", uiLabel: "Checking document status", contributingModule: "documents", requiredPermission: "workspace.documents.read",
    description: "Read knowledge base processing state: document counts by status, documents needing attention, and document source sync state. Returns titles, statuses, and failure reasons — never document content.",
    inputSchema: z.object({}), outputSchema: documentStatusOutputSchema,
    createTool: (context) => ({
      name: "document_status",
      description: "Read knowledge base processing state: document counts by status, documents needing attention, and document source sync state. Returns titles, statuses, and failure reasons — never document content.",
      inputSchema: z.object({}),
      outputSchema: documentStatusOutputSchema,
      invoke: async () => {
        const [summary, attention, sources] = await Promise.all([
          deps.documentStatusService.summarizeWorkspace(context.workspaceId),
          deps.documentStatusService.listByStatuses(context.workspaceId, documentAttentionStatuses, { limit: documentAttentionLimit }),
          deps.documentSourceStatusService.listByWorkspaceIdWithDocumentCounts(context.workspaceId),
        ]);
        return boundPayload({
          counts: {
            total: summary.documentCount,
            ready: summary.readyDocumentCount,
            pending: summary.pendingDocumentCount,
            failed: summary.failedDocumentCount,
          },
          attention: attention.map((document) => ({
            id: document.id,
            title: document.title,
            status: document.status,
            failureReason: document.failureReason ?? null,
            updatedAt: document.updatedAt.toISOString(),
            sourceId: document.sourceId ?? null,
          })),
          sources: sources.map((source) => ({
            id: source.id,
            kind: source.kind,
            label: source.name,
            lastSyncStatus: source.lastSyncStatus,
            lastSyncedAt: source.lastSyncedAt ? source.lastSyncedAt.toISOString() : null,
            documentCount: source.documentCount,
          })),
        }) as z.infer<typeof documentStatusOutputSchema>;
      },
    }),
  },
  {
    name: "agent_skills", uiLabel: "Reading agent skills", contributingModule: "agentSkills", requiredPermission: "workspace.agents.read",
    description: "Read the skills configured on an agent and which skill capabilities have a usable connection. Returns each skill's setting key names, never their values.",
    inputSchema: optionalAgentInput, outputSchema: agentSkillsOutputSchema,
    createTool: (context) => ({
      name: "agent_skills",
      description: "Read the skills configured on an agent and which skill capabilities have a usable connection. Returns each skill's setting key names, never their values.",
      inputSchema: optionalAgentInput,
      outputSchema: agentSkillsOutputSchema,
      invoke: async ({ agentId }) => {
        const resolvedAgentId = agentId ?? requiredPageAgent(context.pageContext.agentId);
        // Tenancy guard, and it must run first: skill targets (MCP connections,
        // external skills) are agent-scoped, so enumerating them before the agent
        // is proven to belong to this workspace would leak another tenant's
        // connections.
        await deps.agentService.get(context.workspaceId, resolvedAgentId);

        const capabilities = await Promise.all(deps.skillCapabilityRegistry.list().map(async (descriptor) => {
          const targets = await descriptor.enumerateTargets({ workspaceId: context.workspaceId, agentId: resolvedAgentId });
          const requiresTarget = descriptor.requiresTarget ?? true;
          const available = requiresTarget ? targets.length > 0 : true;
          return { id: descriptor.id, targetKind: descriptor.targetKind, requiresTarget, available, targets };
        }));
        const targetsByCapability = new Map(capabilities.map((capability) => [
          capability.id,
          new Map(capability.targets.map((target) => [target.id, target])),
        ]));
        const skills = (await deps.agentSkillsService.list(context.workspaceId, resolvedAgentId)).map((skill) => {
          const target = skill.target.id ? targetsByCapability.get(skill.capability)?.get(skill.target.id) ?? null : null;
          return {
            name: skill.name,
            capability: skill.capability,
            invocationMode: skill.invocationMode,
            enabled: skill.enabled,
            target: { kind: skill.target.kind, id: skill.target.id, label: target?.label ?? null, status: target?.status ?? null },
            // Key names only: skill config carries operator-entered payload
            // bindings, delivery addresses, and credentials.
            configKeys: Object.keys(skill.config).sort(),
          };
        });
        return boundPayload({
          skills,
          capabilities: capabilities.map(({ targets, available, ...capability }) => ({
            ...capability,
            targetCount: targets.length,
            available,
            unavailableReason: available ? null : "no_connection",
          })),
        }) as z.infer<typeof agentSkillsOutputSchema>;
      },
    }),
    describeEntity: ({ agentId }, context) => entity("agent", agentId ?? context?.pageContext.agentId),
  },
];

const proposalOutputSchema = z.object({
  proposalId: z.string().uuid(),
  targetType: z.enum(["directive", "agent_setting", "routine"]),
  targetLabel: z.string(),
  summary: z.string(),
});

export const createUs3CopilotTools = (deps: {
  readonly proposalRepository: Pick<CopilotRepositoryPort, "createProposal">;
  readonly proposalAdapters: ReadonlyArray<CopilotDirectiveProposalAdapter | CopilotAgentSettingProposalAdapter | CopilotRoutineProposalAdapter>;
  readonly auditService: CopilotAuditPort;
}): ReadonlyArray<CopilotToolDescriptor> => {
  const directiveAdapter = proposalAdapter(deps.proposalAdapters, "directive");
  const settingAdapter = proposalAdapter(deps.proposalAdapters, "agent_setting");
  const routineAdapter = proposalAdapter(deps.proposalAdapters, "routine");
  return [
    {
      name: "propose_directive", uiLabel: "Drafting a directive", contributingModule: "directives", requiredPermission: "workspace.agents.manage",
      description: "Draft a directive proposal for the operator to review and apply. This does not change configuration.",
      inputSchema: z.object({ agentId: idSchema.optional(), directiveId: idSchema.optional(), intent: z.string().trim().min(1).max(20_000) }).strict(),
      outputSchema: proposalOutputSchema,
      createTool: (context) => ({
        name: "propose_directive",
        description: "Draft a directive proposal for operator review. It does not change configuration.",
        inputSchema: z.object({ agentId: idSchema.optional(), directiveId: idSchema.optional(), intent: z.string().trim().min(1).max(20_000) }).strict(),
        outputSchema: proposalOutputSchema,
        invoke: async ({ agentId, directiveId, intent }) => {
          const targetRef = { agentId: agentId ?? requiredPageAgent(context.pageContext.agentId), directiveId: directiveId ?? null };
          const draft = await directiveAdapter.draft(context.workspaceId, targetRef, intent);
          const versionToken = await directiveAdapter.readVersionToken(context.workspaceId, targetRef);
          const proposal = await deps.proposalRepository.createProposal({
            workspaceId: context.workspaceId,
            operatorUserId: context.operatorUserId,
            conversationId: requiredCopilotConversation(context),
            targetType: "directive",
            targetRef,
            payload: draft.payload,
            versionToken,
          });
          await recordProposalCreated(deps.auditService, context, proposal);
          return { proposalId: proposal.id, targetType: "directive" as const, targetLabel: draft.targetLabel, summary: draft.summary };
        },
      }),
    },
    {
      name: "propose_routine", uiLabel: "Drafting a routine", contributingModule: "routines", requiredPermission: "workspace.agents.manage",
      description: "Draft a new routine proposal for the operator to review and apply. This does not change configuration.",
      inputSchema: z.object({ agentId: idSchema.optional(), intent: z.string().trim().min(1).max(2_000) }).strict(),
      outputSchema: proposalOutputSchema,
      createTool: (context) => ({
        name: "propose_routine",
        description: "Draft a new routine proposal for operator review. It does not change configuration.",
        inputSchema: z.object({ agentId: idSchema.optional(), intent: z.string().trim().min(1).max(2_000) }).strict(),
        outputSchema: proposalOutputSchema,
        invoke: async ({ agentId, intent }) => {
          const targetRef = { agentId: agentId ?? requiredPageAgent(context.pageContext.agentId), routineId: null };
          const draft = await routineAdapter.draft(context.workspaceId, targetRef, intent);
          const versionToken = await routineAdapter.readVersionToken(context.workspaceId, targetRef);
          const proposal = await deps.proposalRepository.createProposal({
            workspaceId: context.workspaceId,
            operatorUserId: context.operatorUserId,
            conversationId: requiredCopilotConversation(context),
            targetType: "routine",
            targetRef,
            payload: draft.payload,
            versionToken,
          });
          await recordProposalCreated(deps.auditService, context, proposal);
          return { proposalId: proposal.id, targetType: "routine" as const, targetLabel: draft.targetLabel, summary: draft.summary };
        },
      }),
      describeEntity: ({ agentId }, context) => entity("agent", agentId ?? context?.pageContext.agentId),
    },
    {
      name: "propose_agent_setting", uiLabel: "Drafting a setting change", contributingModule: "agents", requiredPermission: "workspace.agents.manage",
      description: "Draft an agent setting change for the operator to review and apply. This does not change configuration.",
      inputSchema: z.object({ agentId: idSchema.optional(), settingKey: z.string().trim().min(1).max(200), value: z.unknown(), rationale: z.string().trim().min(1).max(1_000).optional() }).strict(),
      outputSchema: proposalOutputSchema,
      createTool: (context) => ({
        name: "propose_agent_setting",
        description: "Draft an agent setting change for operator review. It does not change configuration.",
        inputSchema: z.object({ agentId: idSchema.optional(), settingKey: z.string().trim().min(1).max(200), value: z.unknown(), rationale: z.string().trim().min(1).max(1_000).optional() }).strict(),
        outputSchema: proposalOutputSchema,
        invoke: async ({ agentId, settingKey, value, rationale }) => {
          const targetRef = { agentId: agentId ?? requiredPageAgent(context.pageContext.agentId), settingKey };
          const validated = await settingAdapter.validatePayload(context.workspaceId, targetRef, { value, ...(rationale ? { rationale } : {}) });
          const versionToken = await settingAdapter.readVersionToken(context.workspaceId, validated.targetRef);
          const proposal = await deps.proposalRepository.createProposal({
            workspaceId: context.workspaceId,
            operatorUserId: context.operatorUserId,
            conversationId: requiredCopilotConversation(context),
            targetType: "agent_setting",
            targetRef: validated.targetRef,
            payload: validated.payload,
            versionToken,
          });
          await recordProposalCreated(deps.auditService, context, proposal);
          return { proposalId: proposal.id, targetType: "agent_setting" as const, targetLabel: settingKey, summary: rationale ?? settingKey };
        },
      }),
    },
  ];
};

const proposalAdapter = <TType extends "directive" | "agent_setting" | "routine">(
  adapters: ReadonlyArray<CopilotDirectiveProposalAdapter | CopilotAgentSettingProposalAdapter | CopilotRoutineProposalAdapter>,
  targetType: TType,
): Extract<CopilotDirectiveProposalAdapter | CopilotAgentSettingProposalAdapter | CopilotRoutineProposalAdapter, { targetType: TType }> => {
  const adapter = adapters.find((candidate) => candidate.targetType === targetType);
  if (!adapter) throw new Error(`No copilot proposal adapter registered for ${targetType}`);
  return adapter as Extract<CopilotDirectiveProposalAdapter | CopilotAgentSettingProposalAdapter | CopilotRoutineProposalAdapter, { targetType: TType }>;
};

const requiredCopilotConversation = (context: { copilotConversationId?: string }): string => {
  const conversationId = context.copilotConversationId;
  if (!conversationId) throw new Error("Copilot proposal drafting requires a persisted conversation");
  return conversationId;
};

const recordProposalCreated = async (auditService: CopilotAuditPort, context: { accountId: string; workspaceId: string }, proposal: CopilotProposal): Promise<void> => {
  await auditService.record({ accountId: context.accountId, workspaceId: context.workspaceId, eventType: "copilot.proposal.created", eventStatus: "success", metadata: { proposalId: proposal.id, targetType: proposal.targetType } });
};

const entity = (type: string, id: string | null | undefined) => id ? { type, id } : null;
const asRecord = (value: object): Record<string, unknown> => value as Record<string, unknown>;
const requiredPageAgent = (agentId: string | null): string => { if (!agentId) throw new Error("No agent context is available"); return agentId; };
const requiredPageConversation = (conversationId: string | null): string => { if (!conversationId) throw new Error("No conversation context is available"); return conversationId; };
const agentIdForEvalCase = (item: Record<string, unknown>): string | null => {
  const agent = item.agent;
  return agent && typeof agent === "object" && "agentId" in agent && typeof agent.agentId === "string" ? agent.agentId : null;
};
const newestEvalResultFirst = (left: Record<string, unknown>, right: Record<string, unknown>): number => latestEvalTime(right) - latestEvalTime(left);
const latestEvalTime = (item: Record<string, unknown>): number => {
  const latestRun = item.latestRun;
  if (!latestRun || typeof latestRun !== "object") return 0;
  const completedAt = "completedAt" in latestRun ? latestRun.completedAt : undefined;
  const startedAt = "startedAt" in latestRun ? latestRun.startedAt : undefined;
  const timestamp = typeof completedAt === "string" ? completedAt : typeof startedAt === "string" ? startedAt : undefined;
  const value = timestamp ? Date.parse(timestamp) : 0;
  return Number.isFinite(value) ? value : 0;
};
