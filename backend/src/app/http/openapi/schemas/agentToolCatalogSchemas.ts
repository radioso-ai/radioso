import { z } from "zod";
import type { OpenAPIRegistry } from "@asteasolutions/zod-to-openapi";

import type { OpenApiSchemaCatalog } from "../openApiRegistry.js";

/**
 * The agent tool catalog a calling agent reads: one descriptor per exposed
 * routine, its input schema derived from the routine's declared slots.
 * Published once so the MCP package and the SDK consume the same shape.
 */
export const registerAgentToolCatalogSchemas = (registry: OpenAPIRegistry, schemas: OpenApiSchemaCatalog) => {
  const AgentToolInputPropertySchema = z.object({
    type: z.enum(["string", "number", "boolean"]),
    format: z.enum(["email", "date"]).optional(),
    description: z.string().optional(),
  });

  const AgentToolInputSchemaSchema = registry.register(
    "AgentToolInputSchema",
    z.object({
      type: z.literal("object"),
      properties: z.record(AgentToolInputPropertySchema),
      required: z.array(z.string()),
      additionalProperties: z.literal(false),
    }).openapi({
      description: "JSON Schema for the tool's input: one property per declared routine slot (`text`→string, `number`, `boolean`, `email`→string/format=email, `date`→string/format=date), `required` from the slot.",
    }),
  );

  const AgentToolDescriptorSchema = registry.register(
    "AgentToolDescriptor",
    z.object({
      toolName: z.string(),
      description: z.string(),
      inputSchema: AgentToolInputSchemaSchema,
      routineLineageId: z.string(),
    }).openapi({
      description: "One exposed routine as a calling agent sees it: the name it invokes, the operator-authored description, and the input schema built from the routine's slots.",
    }),
  );

  const McpConverseToolsResponseSchema = registry.register(
    "McpConverseToolsResponse",
    z.object({
      agent: z.object({
        name: z.string(),
        description: z.string().nullable(),
      }),
      tools: z.array(AgentToolDescriptorSchema),
    }).openapi({
      description: "The bound agent's tool catalog: exposed routines from its current published release.",
    }),
  );

  Object.assign(schemas, {
    AgentToolInputSchemaSchema,
    AgentToolDescriptorSchema,
    McpConverseToolsResponseSchema,
  });
};
