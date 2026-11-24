import { z } from "zod";
import { contextVariableNameSchema } from "@radioso/routine-definition";
import type { OpenAPIRegistry } from "@asteasolutions/zod-to-openapi";
import type { OpenApiSchemaCatalog } from "../openApiRegistry.js";
import { CONTEXT_VARIABLES_BEHAVIOR } from "../../../../shared/domain/behaviorConfig.js";
import {
  CONTEXT_VALUE_WRITER_KINDS,
  CONTEXT_VARIABLE_SCOPE_TYPES,
  CONTEXT_VARIABLE_SOURCES,
  CONTEXT_VARIABLE_VALUE_TYPES,
  contextVariableOptionInputSchema,
  contextVariableOptionSchema,
} from "../../../../modules/context-variables/public.js";

const optionLimits = CONTEXT_VARIABLES_BEHAVIOR.enumOptions;
const ContextVariableValueTypeSchema = z.enum(CONTEXT_VARIABLE_VALUE_TYPES);
const ContextVariableTrustTierSchema = z.enum(["unverified", "signed"]);
const ContextVariableSensitivitySchema = z.enum(["normal", "sensitive"]);
const ContextVariableSurfacingSchema = z.enum(["always", "on_reference", "operator_only"]);
const ContextVariableSourceSchema = z.enum(CONTEXT_VARIABLE_SOURCES);
// The enable-variable request body never accepts "request": visitor_request (the only
// request-sourced built-in) resolves unconditionally and has no operator-created
// agent_context_variables row, so advertising it as an accepted request value here would
// describe an operation the route always rejects (contextVariableRoutes.ts superRefine).
const AgentContextVariableEnablementRequestSourceSchema = z.enum(["pushed", "browser", "resolver", "classified"]).openapi({
  description: "Where the value comes from. `pushed`: your API writes it. `resolver`: a skill fetches it. `classified`: the AI picks one of an `enum` variable's options from the conversation after each reply, into the `conversation` scope; it never replaces a value your API or a teammate set for this visitor or conversation (`conversation`, `session` or `customer` scope), and an `agent` or `workspace` value is a default that applies until the AI picks one. `classified` takes an `enum` variable that is neither `sensitive` nor `signed`, at most 8 per agent.",
});
const ContextVariableScopeTypeSchema = z.enum(CONTEXT_VARIABLE_SCOPE_TYPES).openapi({
  description: "Where a value is kept. A `conversation` scope id is the conversation's id.",
});
const ContextValueWriterKindSchema = z.enum(CONTEXT_VALUE_WRITER_KINDS);

export const registerContextVariableSchemas = (registry: OpenAPIRegistry, schemas: OpenApiSchemaCatalog) => {
  const JsonValueSchema = z.unknown().openapi({
    description: "A value of the variable's type: a string for `string`, the key of an active option for `enum`, any JSON for `json`, `true` or `false` for `boolean`, a finite number for `number`, and an ISO calendar date such as `2026-11-24` for `date`. The HTTP API rejects values above the serialized size limit.",
  });

  const optionKeyDescription = { description: "What a value stores. It never changes." };
  const ContextVariableOptionSchema = registry.register(
    "ContextVariableOption",
    contextVariableOptionSchema.extend({
      key: contextVariableOptionSchema.shape.key.openapi(optionKeyDescription),
      archived: contextVariableOptionSchema.shape.archived.openapi({
        description: "An archived option is no longer offered or accepted as a new value; values that hold it keep it.",
      }),
    }),
  );

  const ContextVariableOptionInputSchema = registry.register(
    "ContextVariableOptionInput",
    contextVariableOptionInputSchema.extend({
      key: contextVariableOptionInputSchema.shape.key.openapi(optionKeyDescription),
    }),
  );

  const ContextVariableSchema = registry.register(
    "ContextVariable",
    z.object({
      id: z.string().uuid(),
      workspaceId: z.string().uuid(),
      name: z.string(),
      description: z.string().nullable(),
      valueType: ContextVariableValueTypeSchema,
      options: z.array(ContextVariableOptionSchema).nullable().openapi({
        description: "The options of an `enum` variable; null for every other type.",
      }),
      trustTier: ContextVariableTrustTierSchema,
      sensitivity: ContextVariableSensitivitySchema,
      defaultSurfacing: ContextVariableSurfacingSchema,
      createdAt: z.string().datetime(),
      updatedAt: z.string().datetime(),
    }),
  );

  const ContextVariableCreateRequestSchema = registry.register(
    "ContextVariableCreateRequest",
    z.object({
      name: contextVariableNameSchema,
      description: z.string().max(2000).nullable().optional(),
      valueType: ContextVariableValueTypeSchema.openapi({
        description: "The type of every value: `string` (text), `enum` (one of `options`), `json` (any JSON), `boolean`, `number` or `date` (an ISO calendar date, no time). It cannot change while the variable has values.",
      }),
      options: z.array(ContextVariableOptionInputSchema).max(optionLimits.maxOptions).nullable().optional().openapi({
        description: "Required for `enum`, refused for other types. An update lists every existing key: archive an option instead of removing it.",
      }),
      trustTier: ContextVariableTrustTierSchema,
      sensitivity: ContextVariableSensitivitySchema,
      defaultSurfacing: ContextVariableSurfacingSchema,
    }),
  );

  const ContextVariableUpdateRequestSchema = registry.register(
    "ContextVariableUpdateRequest",
    ContextVariableCreateRequestSchema.partial(),
  );

  const ContextVariableResponseSchema = registry.register(
    "ContextVariableResponse",
    z.object({
      contextVariable: ContextVariableSchema,
    }),
  );

  const ContextVariableListResponseSchema = registry.register(
    "ContextVariableListResponse",
    z.object({
      contextVariables: z.array(ContextVariableSchema),
    }),
  );

  const ContextVariableParamsSchema = z.object({
    id: z.string().uuid(),
  });

  const AgentContextVariableParamsSchema = z.object({
    agentId: z.string().uuid(),
    variableId: z.string().uuid(),
  });

  const AgentContextVariableEnablementSchema = registry.register(
    "AgentContextVariableEnablement",
    z.object({
      id: z.string().uuid(),
      agentId: z.string().uuid(),
      variableId: z.string().uuid(),
      source: ContextVariableSourceSchema,
      resolverSkillId: z.string().uuid().nullable(),
      maxAgeSeconds: z.number().int().nullable(),
      resolverTimeoutMs: z.number().int().nullable(),
      surfacing: ContextVariableSurfacingSchema,
      enabled: z.boolean(),
      createdAt: z.string().datetime(),
      updatedAt: z.string().datetime(),
      variable: ContextVariableSchema.optional(),
    }),
  );

  const AgentContextVariableEnablementRequestSchema = registry.register(
    "AgentContextVariableEnablementRequest",
    z.object({
      source: AgentContextVariableEnablementRequestSourceSchema,
      resolverSkillId: z.string().uuid().nullable().optional(),
      maxAgeSeconds: z.number().int().nonnegative().nullable().optional(),
      resolverTimeoutMs: z.number().int().positive().nullable().optional(),
      surfacing: ContextVariableSurfacingSchema,
      enabled: z.boolean().optional(),
    }),
  );

  const AgentContextVariableEnablementResponseSchema = registry.register(
    "AgentContextVariableEnablementResponse",
    z.object({
      enablement: AgentContextVariableEnablementSchema,
    }),
  );

  const AgentContextVariableEnablementListResponseSchema = registry.register(
    "AgentContextVariableEnablementListResponse",
    z.object({
      enablements: z.array(AgentContextVariableEnablementSchema),
    }),
  );

  const ContextVariableScopeSchema = registry.register(
    "ContextVariableScope",
    z.object({
      type: ContextVariableScopeTypeSchema,
      id: z.string(),
    }),
  );

  const ContextVariableValueSchema = registry.register(
    "ContextVariableValue",
    z.object({
      id: z.string().uuid(),
      workspaceId: z.string().uuid(),
      variableId: z.string().uuid(),
      scope: ContextVariableScopeSchema,
      data: JsonValueSchema,
      lastModified: z.string().datetime(),
      writtenBy: z.object({
        kind: ContextValueWriterKindSchema,
        ref: z.string().nullable().openapi({
          description: "What wrote the value: for `api`, the API credential's id, or the teammate's user id for a dashboard session.",
        }),
      }).openapi({ description: "The last writer of the value." }),
    }),
  );

  const ContextVariableValueUpsertRequestSchema = registry.register(
    "ContextVariableValueUpsertRequest",
    z.object({
      scope: ContextVariableScopeSchema,
      data: JsonValueSchema,
    }),
  );

  const ContextVariableValueDeleteRequestSchema = registry.register(
    "ContextVariableValueDeleteRequest",
    z.object({
      scope: ContextVariableScopeSchema,
    }),
  );

  const ContextVariableValueResponseSchema = registry.register(
    "ContextVariableValueResponse",
    z.object({
      value: ContextVariableValueSchema,
    }),
  );

  const ContextVariableValueQuerySchema = z.object({
    scopeType: ContextVariableScopeTypeSchema,
    scopeId: z.string(),
  });

  const ContextVariableSigningKeyResponseSchema = registry.register(
    "ContextVariableSigningKeyResponse",
    z.object({
      signingKey: z.string().regex(/^[0-9a-f]{64}$/),
    }),
  );

  Object.assign(schemas, {
    AgentContextVariableEnablementListResponseSchema,
    AgentContextVariableEnablementRequestSchema,
    AgentContextVariableEnablementResponseSchema,
    AgentContextVariableParamsSchema,
    ContextVariableCreateRequestSchema,
    ContextVariableListResponseSchema,
    ContextVariableParamsSchema,
    ContextVariableResponseSchema,
    ContextVariableSigningKeyResponseSchema,
    ContextVariableUpdateRequestSchema,
    ContextVariableValueDeleteRequestSchema,
    ContextVariableValueQuerySchema,
    ContextVariableValueResponseSchema,
    ContextVariableValueUpsertRequestSchema,
  });
};
