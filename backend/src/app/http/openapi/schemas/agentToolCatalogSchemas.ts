import { z } from "zod";
import type { OpenAPIRegistry } from "@asteasolutions/zod-to-openapi";

import { ROUTINE_INVOCATION_MAX_STRING_LENGTH, routineInvocationErrorCodes } from "../../../../modules/routines/public.js";
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
      askAgentDescription: z.string().openapi({
        description: "The description an MCP client should advertise for `ask_agent`, composed from the agent's name, its operator-authored description, and the names of its exposed tools. Assembled from configuration rather than written by a model, so the same settings always produce the same sentence. The tool names come from the published release; the name and description are read from the agent's current settings.",
      }),
    }).openapi({
      description: "The bound agent's tool catalog: exposed routines from its current published release.",
    }),
  );

  const RoutineInvocationErrorSchema = registry.register(
    "RoutineInvocationError",
    z.object({
      path: z.string().openapi({ description: "The slot key the problem is on." }),
      code: z.enum(routineInvocationErrorCodes),
    }).openapi({
      description: `One field-level problem with a tool call's input. \`too_long\` is a string value over ${ROUTINE_INVOCATION_MAX_STRING_LENGTH} characters; \`format\` is an \`email\` or \`date\` slot whose value does not parse as one.`,
    }),
  );

  const RoutineInvocationInvalidDetailsSchema = registry.register(
    "RoutineInvocationInvalidDetails",
    z.object({
      code: z.literal("routine_invocation_invalid"),
      toolName: z.string(),
      errors: z.array(RoutineInvocationErrorSchema),
    }).openapi({
      description: "The `error.details` of a 400 that refused a tool call before any turn state was written: every problem at once, so a caller can fix the whole call in one retry. Values are never echoed back.",
    }),
  );

  Object.assign(schemas, {
    AgentToolInputSchemaSchema,
    AgentToolDescriptorSchema,
    McpConverseToolsResponseSchema,
    RoutineInvocationErrorSchema,
    RoutineInvocationInvalidDetailsSchema,
  });
};
