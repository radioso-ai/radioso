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
      description: "An A2A Agent Card for one agent: who it is, where its MCP endpoint is, how a caller authenticates, and one skill per exposed routine.",
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
