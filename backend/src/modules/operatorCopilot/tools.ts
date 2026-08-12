import { z } from "zod";

import type { AgentService } from "../agents/public.js";
import { routineToPortableDocument, type RoutineDefinitionService } from "../routines/public.js";
import type {
  CopilotAgentSettingProposalAdapter,
  CopilotAuditPort,
  CopilotDirectiveProposalAdapter,
  CopilotProposal,
  CopilotToolDescriptor,
} from "./contracts.js";
import type { CopilotRepositoryPort } from "./service.js";
import { boundConversationPayload, boundPayload } from "./boundedPayload.js";

const idSchema = z.string().uuid();
const unknownRecord = z.record(z.unknown());
const optionalAgentInput = z.object({ agentId: idSchema.optional() });

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

export const createUs1CopilotTools = (deps: {
  readonly agentService: Pick<AgentService, "get">;
  readonly routineDefinitionService: Pick<RoutineDefinitionService, "get">;
  readonly chatHistoryService: CopilotConversationHistoryPort;
  readonly documentSearchService: CopilotDocumentSearchPort;
}): ReadonlyArray<CopilotToolDescriptor> => [
  {
    name: "agent_configuration", uiLabel: "Reading agent configuration", contributingModule: "agents", requiredPermission: "workspace.agents.read",
    description: "Read the selected agent's current configuration. Use this for workspace-specific settings and behavior.",
    inputSchema: optionalAgentInput, outputSchema: z.object({ agent: unknownRecord }),
    createTool: (context) => ({ name: "agent_configuration", description: "Read the selected agent's current configuration.", inputSchema: optionalAgentInput, outputSchema: z.object({ agent: unknownRecord }), invoke: async ({ agentId }) => ({ agent: await deps.agentService.get(context.workspaceId, agentId ?? requiredPageAgent(context.pageContext.agentId)) as Record<string, unknown> }) }),
    describeEntity: ({ agentId }, context) => entity("agent", agentId ?? context?.pageContext.agentId),
  },
  {
    name: "routine_definition", uiLabel: "Reading routine", contributingModule: "routines", requiredPermission: "workspace.agents.read",
    description: "Read an agent routine in portable Markdown form.",
    inputSchema: z.object({ agentId: idSchema.optional(), routineId: idSchema }), outputSchema: z.object({ routine: unknownRecord }),
    createTool: (context) => ({ name: "routine_definition", description: "Read an agent routine in portable Markdown form.", inputSchema: z.object({ agentId: idSchema.optional(), routineId: idSchema }), outputSchema: z.object({ routine: unknownRecord }), invoke: async ({ agentId, routineId }) => ({ routine: routineToPortableDocument(await deps.routineDefinitionService.get(context.workspaceId, agentId ?? requiredPageAgent(context.pageContext.agentId), routineId)) as unknown as Record<string, unknown> }) }),
    describeEntity: ({ routineId }) => ({ type: "routine", id: routineId }),
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
    description: "Search workspace documents and return matching document metadata and evidence.",
    inputSchema: z.object({ query: z.string().min(1).max(1000) }), outputSchema: z.object({ results: z.array(unknownRecord) }),
    createTool: (context) => ({ name: "document_search", description: "Search workspace documents and return matching document metadata and evidence.", inputSchema: z.object({ query: z.string().min(1).max(1000) }), outputSchema: z.object({ results: z.array(unknownRecord) }), invoke: async ({ query }) => ({ results: boundPayload({ results: (await deps.documentSearchService.search({ workspaceId: context.workspaceId, query, executionSurface: "operator_copilot" })).results as Record<string, unknown>[] }).results as Record<string, unknown>[] }) }),
  },
];

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

const proposalOutputSchema = z.object({
  proposalId: z.string().uuid(),
  targetType: z.enum(["directive", "agent_setting"]),
  targetLabel: z.string(),
  summary: z.string(),
});

export const createUs3CopilotTools = (deps: {
  readonly proposalRepository: Pick<CopilotRepositoryPort, "createProposal">;
  readonly proposalAdapters: ReadonlyArray<CopilotDirectiveProposalAdapter | CopilotAgentSettingProposalAdapter>;
  readonly auditService: CopilotAuditPort;
}): ReadonlyArray<CopilotToolDescriptor> => {
  const directiveAdapter = proposalAdapter(deps.proposalAdapters, "directive");
  const settingAdapter = proposalAdapter(deps.proposalAdapters, "agent_setting");
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

const proposalAdapter = <TType extends "directive" | "agent_setting">(
  adapters: ReadonlyArray<CopilotDirectiveProposalAdapter | CopilotAgentSettingProposalAdapter>,
  targetType: TType,
): Extract<CopilotDirectiveProposalAdapter | CopilotAgentSettingProposalAdapter, { targetType: TType }> => {
  const adapter = adapters.find((candidate) => candidate.targetType === targetType);
  if (!adapter) throw new Error(`No copilot proposal adapter registered for ${targetType}`);
  return adapter as Extract<CopilotDirectiveProposalAdapter | CopilotAgentSettingProposalAdapter, { targetType: TType }>;
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
