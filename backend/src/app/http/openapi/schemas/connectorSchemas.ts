import { z } from "zod";
import type { OpenAPIRegistry } from "@asteasolutions/zod-to-openapi";
import type { OpenApiSchemaCatalog } from "../openApiRegistry.js";

export const registerConnectorSchemas = (registry: OpenAPIRegistry, schemas: OpenApiSchemaCatalog) => {
  const ConnectorFieldSchema = registry.register(
    "ConnectorField",
    z.object({
      key: z.string(),
      label: z.string(),
      type: z.string(),
      required: z.boolean(),
      defaultValue: z.string().optional(),
      helpText: z.string().optional(),
    }),
  );

  const ConnectorSummarySchema = registry.register(
    "ConnectorSummary",
    z.object({
      id: z.string(),
      name: z.string(),
      description: z.string(),
      enabled: z.boolean(),
      errorStatus: z.string().nullable(),
      supportsManualSync: z.boolean(),
    }),
  );

  const ConnectorListResponseSchema = registry.register(
    "ConnectorListResponse",
    z.object({
      connectors: z.array(ConnectorSummarySchema),
    }),
  );

  const ConnectorDetailSchema = registry.register(
    "ConnectorDetail",
    ConnectorSummarySchema.extend({
      schema: z.array(ConnectorFieldSchema),
      config: z.record(z.union([z.string(), z.number(), z.boolean()])),
      webhookUrl: z.string().url(),
      syncState: z.object({
        backfillCompletedAt: z.string().nullable(),
        syncRequestedAt: z.string().nullable(),
        syncStartedAt: z.string().nullable(),
        lastRunAt: z.string().nullable(),
        lastModifiedAt: z.string().nullable(),
        lastIngestedCount: z.number().int().nullable(),
        lastError: z.string().nullable(),
      }),
    }),
  );

  const ConnectorSyncResponseSchema = registry.register(
    "ConnectorSyncResponse",
    z.object({
      accepted: z.boolean(),
    }),
  );

  const ConnectorConfigUpdateSchema = registry.register(
    "ConnectorConfigUpdateRequest",
    z.object({
      config: z.record(z.union([z.string(), z.number(), z.boolean()])),
    }),
  );

  const ConnectorValidationIssueSchema = registry.register(
    "ConnectorValidationIssue",
    z.object({
      key: z.string(),
      message: z.string(),
    }),
  );

  const ConnectorValidationErrorSchema = registry.register(
    "ConnectorValidationErrorResponse",
    z.object({
      error: z.literal("Validation failed"),
      fields: z.array(ConnectorValidationIssueSchema),
    }),
  );

  const ConnectorConflictSchema = registry.register(
    "ConnectorConflictResponse",
    z.object({
      error: z.literal("Channel identity conflict"),
      detail: z.string(),
    }),
  );

  const tokenPathParamsSchema = z.object({
    token: z.string().min(1),
  }).openapi("PublicChatTokenParams");

  const connectorIdPathParamsSchema = z.object({
    connectorId: z.string().min(1),
  }).openapi("ConnectorIdParams");

  Object.assign(schemas, {
    ConnectorFieldSchema,
    ConnectorSummarySchema,
    ConnectorListResponseSchema,
    ConnectorDetailSchema,
    ConnectorConfigUpdateSchema,
    ConnectorSyncResponseSchema,
    ConnectorValidationIssueSchema,
    ConnectorValidationErrorSchema,
    ConnectorConflictSchema,
    tokenPathParamsSchema,
    connectorIdPathParamsSchema,
  });
};
