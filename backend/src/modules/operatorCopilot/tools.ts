import { z } from "zod";

import type { AgentService } from "../agents/public.js";
import { routineToPortableDocument, type RoutineDefinitionService } from "../routines/public.js";
import type { ChatHistoryService } from "../chat/services/chatHistoryService.js";
import type { DocumentSearchService } from "../documents/services/documentSearchService.js";
import type { CopilotToolDescriptor } from "./contracts.js";

const idSchema = z.string().uuid();
const unknownRecord = z.record(z.unknown());

export const createUs1CopilotTools = (deps: {
  readonly agentService: Pick<AgentService, "get">;
  readonly routineDefinitionService: Pick<RoutineDefinitionService, "get">;
  readonly chatHistoryService: Pick<ChatHistoryService, "getConversation" | "listConversations">;
  readonly documentSearchService: Pick<DocumentSearchService, "search">;
}): ReadonlyArray<CopilotToolDescriptor> => [
  {
    name: "agent_configuration", uiLabel: "Reading agent configuration", contributingModule: "agents", requiredPermission: "workspace.agents.read",
    description: "Read the selected agent's current configuration. Use this for workspace-specific settings and behavior.",
    inputSchema: z.object({ agentId: idSchema.optional() }), outputSchema: z.object({ agent: unknownRecord }),
    createTool: (context) => ({ name: "agent_configuration", description: "Read the selected agent's current configuration.", inputSchema: z.object({ agentId: idSchema.optional() }), outputSchema: z.object({ agent: unknownRecord }), invoke: async ({ agentId }) => ({ agent: await deps.agentService.get(context.workspaceId, agentId ?? requiredPageAgent(context.pageContext.agentId)) as Record<string, unknown> }) }),
  },
  {
    name: "routine_definition", uiLabel: "Reading routine", contributingModule: "routines", requiredPermission: "workspace.agents.read",
    description: "Read an agent routine in portable Markdown form.",
    inputSchema: z.object({ agentId: idSchema.optional(), routineId: idSchema }), outputSchema: z.object({ routine: unknownRecord }),
    createTool: (context) => ({ name: "routine_definition", description: "Read an agent routine in portable Markdown form.", inputSchema: z.object({ agentId: idSchema.optional(), routineId: idSchema }), outputSchema: z.object({ routine: unknownRecord }), invoke: async ({ agentId, routineId }) => ({ routine: routineToPortableDocument(await deps.routineDefinitionService.get(context.workspaceId, agentId ?? requiredPageAgent(context.pageContext.agentId), routineId)) as unknown as Record<string, unknown> }) }),
  },
  {
    name: "conversation_trace", uiLabel: "Reading conversation trace", contributingModule: "chat", requiredPermission: "workspace.history.read",
    description: "Read a customer conversation transcript and its retained turn trace envelope.",
    inputSchema: z.object({ conversationId: idSchema.optional() }), outputSchema: z.object({ conversation: unknownRecord }),
    createTool: (context) => ({ name: "conversation_trace", description: "Read a customer conversation transcript and its retained turn trace envelope.", inputSchema: z.object({ conversationId: idSchema.optional() }), outputSchema: z.object({ conversation: unknownRecord }), invoke: async ({ conversationId }) => ({ conversation: await deps.chatHistoryService.getConversation(context.workspaceId, conversationId ?? requiredPageConversation(context.pageContext.conversationId), { limit: 100 }, { includeTurnFailureDebug: false }) as unknown as Record<string, unknown> }) }),
  },
  {
    name: "conversation_history_search", uiLabel: "Searching conversations", contributingModule: "chat", requiredPermission: "workspace.history.read",
    description: "List recent customer conversations in this workspace for investigation.",
    inputSchema: z.object({ limit: z.number().int().min(1).max(50).optional() }), outputSchema: z.object({ conversations: z.array(unknownRecord) }),
    createTool: (context) => ({ name: "conversation_history_search", description: "List recent customer conversations in this workspace for investigation.", inputSchema: z.object({ limit: z.number().int().min(1).max(50).optional() }), outputSchema: z.object({ conversations: z.array(unknownRecord) }), invoke: async ({ limit }) => ({ conversations: (await deps.chatHistoryService.listConversations(context.workspaceId, { limit: limit ?? 20 })).conversations as unknown as Record<string, unknown>[] }) }),
  },
  {
    name: "document_search", uiLabel: "Searching documents", contributingModule: "documents", requiredPermission: "workspace.documents.read",
    description: "Search workspace documents and return matching document metadata and evidence.",
    inputSchema: z.object({ query: z.string().min(1).max(1000) }), outputSchema: z.object({ results: z.array(unknownRecord) }),
    createTool: (context) => ({ name: "document_search", description: "Search workspace documents and return matching document metadata and evidence.", inputSchema: z.object({ query: z.string().min(1).max(1000) }), outputSchema: z.object({ results: z.array(unknownRecord) }), invoke: async ({ query }) => ({ results: (await deps.documentSearchService.search({ workspaceId: context.workspaceId, query, executionSurface: "operator_copilot" })).results as unknown as Record<string, unknown>[] }) }),
  },
];

const requiredPageAgent = (agentId: string | null): string => { if (!agentId) throw new Error("No agent context is available"); return agentId; };
const requiredPageConversation = (conversationId: string | null): string => { if (!conversationId) throw new Error("No conversation context is available"); return conversationId; };
