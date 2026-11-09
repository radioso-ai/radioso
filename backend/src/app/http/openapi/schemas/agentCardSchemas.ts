import { z } from "zod";
import type { OpenAPIRegistry } from "@asteasolutions/zod-to-openapi";

import {
  a2aAgentCardSchema,
  aiCatalogSchema,
  mcpServerCardSchema,
} from "../../../../modules/agentDiscovery/public.js";
import type { OpenApiSchemaCatalog } from "../openApiRegistry.js";

/**
 * The three public discovery documents. Their shapes are owned by the discovery module and
 * published here so a caller — and the generated SDK — sees the same document the renderer
 * produces. Two of them follow external specifications; the schemas are registered, not
 * redefined, so there is one source of truth per document.
 */
export const registerAgentCardSchemas = (registry: OpenAPIRegistry, schemas: OpenApiSchemaCatalog) => {
  const A2aAgentCardSchema = registry.register(
    "A2aAgentCard",
    a2aAgentCardSchema.openapi({
      description: "An A2A v1.0 Agent Card for one agent: who it is, the JSON-RPC interface an A2A client sends messages to, how a caller authenticates, an `ask_agent` skill plus one skill per exposed routine, and under `capabilities.extensions` the Radioso converse extension, which names the agent's MCP endpoint and each routine's input schema. `securityRequirements` is absent while the agent accepts callers with no credential.",
    }),
  );

  const McpServerCardSchema = registry.register(
    "McpServerCard",
    mcpServerCardSchema.openapi({
      description: "The MCP server card for one agent, in the published MCP server document shape. `$schema` is omitted until the server-card extension publishes one.",
    }),
  );

  const AiCatalogSchema = registry.register(
    "AiCatalog",
    aiCatalogSchema.openapi({
      description: "The catalog entry for one agent: the index a customer's own origin points at.",
    }),
  );

  const AgentPublicIdParamsSchema = z.object({
    publicId: z.string().min(1).max(64),
  });

  Object.assign(schemas, {
    A2aAgentCardSchema,
    McpServerCardSchema,
    AiCatalogSchema,
    AgentPublicIdParamsSchema,
  });
};
