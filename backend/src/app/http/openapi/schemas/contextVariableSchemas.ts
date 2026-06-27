import { z } from "zod";
import type { OpenAPIRegistry } from "@asteasolutions/zod-to-openapi";
import type { OpenApiSchemaCatalog } from "../openApiRegistry.js";

const ContextVariableValueTypeSchema = z.enum(["string", "json"]);
const ContextVariableTrustTierSchema = z.enum(["unverified", "signed"]);
const ContextVariableSensitivitySchema = z.enum(["normal", "sensitive"]);
const ContextVariableSurfacingSchema = z.enum(["always", "on_reference", "operator_only"]);
const ContextVariableSourceSchema = z.enum(["pushed", "browser", "resolver"]);
const ContextVariableScopeTypeSchema = z.enum(["session", "customer", "agent", "workspace"]);

export const registerContextVariableSchemas = (registry: OpenAPIRegistry, schemas: OpenApiSchemaCatalog) => {
  const JsonValueSchema = z.unknown().openapi({
    description: "Arbitrary JSON value. The HTTP API rejects values above the serialized size limit.",
  });

  const ContextVariableSchema = registry.register(
    "ContextVariable",
    z.object({
      id: z.string().uuid(),
      workspaceId: z.string().uuid(),
      name: z.string(),
      description: z.string().nullable(),
      valueType: ContextVariableValueTypeSchema,
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
      name: z.string().min(1).max(120),
      description: z.string().max(2000).nullable().optional(),
      valueType: ContextVariableValueTypeSchema,
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
      source: ContextVariableSourceSchema,
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
