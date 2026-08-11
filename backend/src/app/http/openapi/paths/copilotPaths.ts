import { z } from "zod";
import type { OpenAPIRegistry } from "@asteasolutions/zod-to-openapi";
import type { OpenApiSecurity } from "../openApiRegistry.js";

const availability = z.object({ available: z.boolean(), reason: z.enum(["ok", "no_llm_capability"]) });
const conversation = z.object({ id: z.string().uuid(), title: z.string().nullable(), status: z.enum(["idle", "running"]), createdAt: z.string(), updatedAt: z.string() });
const turn = z.object({ conversationId: z.string().uuid().nullable(), message: z.string().min(1).max(8000), pageContext: z.object({ view: z.enum(["activity", "history", "agent", "documents", "workbench", "quality", "evals", "other"]).nullable(), agentId: z.string().uuid().nullable(), conversationId: z.string().uuid().nullable() }) });

export const registerCopilotPaths = (registry: OpenAPIRegistry, security: OpenApiSecurity): void => {
  const session = security.workspaceAdminSecurity;
  registry.registerPath({ method: "get", path: "/api/v1/copilot/availability", tags: ["Copilot"], summary: "Check operator copilot availability", description: "Dashboard session only; bearer API tokens are rejected.", operationId: "getCopilotAvailability", security: session, responses: { 200: { description: "Availability", content: { "application/json": { schema: availability } } }, 403: { description: "Forbidden" } } });
  registry.registerPath({ method: "get", path: "/api/v1/copilot/conversations", tags: ["Copilot"], summary: "List an operator's copilot conversations", operationId: "listCopilotConversations", security: session, responses: { 200: { description: "Conversations", content: { "application/json": { schema: z.object({ conversations: z.array(conversation) }) } } } } });
  registry.registerPath({ method: "get", path: "/api/v1/copilot/conversations/{conversationId}", tags: ["Copilot"], summary: "Read a copilot conversation", operationId: "getCopilotConversation", security: session, request: { params: z.object({ conversationId: z.string().uuid() }) }, responses: { 200: { description: "Conversation" }, 404: { description: "Not found" } } });
  registry.registerPath({ method: "delete", path: "/api/v1/copilot/conversations/{conversationId}", tags: ["Copilot"], summary: "Delete a copilot conversation", operationId: "deleteCopilotConversation", security: session, request: { params: z.object({ conversationId: z.string().uuid() }) }, responses: { 204: { description: "Deleted" }, 404: { description: "Not found" } } });
  registry.registerPath({ method: "post", path: "/api/v1/copilot/turns", tags: ["Copilot"], summary: "Start a streaming read-only copilot turn", description: "Returns the fixed copilot SSE event stream. Dashboard session only; bearer API tokens are rejected.", operationId: "createCopilotTurn", security: session, request: { body: { required: true, content: { "application/json": { schema: turn } } } }, responses: { 200: { description: "SSE stream", content: { "text/event-stream": { schema: z.string() } } }, 409: { description: "Conversation already running" }, 503: { description: "No LLM capability" } } });
};
