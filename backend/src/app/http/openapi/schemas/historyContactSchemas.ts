import { z } from "zod";
import type { OpenAPIRegistry } from "@asteasolutions/zod-to-openapi";

import {
  conversationWindowQuerySchema,
  historyContactParamsSchema,
  historyItemsPageQuerySchema,
} from "../../routes/conversationRouteSchemas.js";
import type { OpenApiSchemaCatalog } from "../openApiRegistry.js";

/**
 * Contact requests: the "someone asked to be contacted" rows the dashboard history view lists
 * and drills into. Kept in its own module rather than grown into assistantHistorySchemas.ts,
 * which is already at its file-size baseline.
 */
export const registerHistoryContactSchemas = (registry: OpenAPIRegistry, schemas: OpenApiSchemaCatalog) => {
  const ContactHistorySummarySchema = registry.register(
    "ContactHistorySummary",
    z.object({
      id: z.string().uuid(),
      sortAt: z.string().datetime(),
      workspaceId: z.string().uuid(),
      conversationId: z.string().uuid(),
      assistantMessageId: z.string().uuid().nullable(),
      sourceChannel: z.string().nullable(),
      sourceOrigin: z.string().nullable(),
      userEmail: z.string(),
      messagePreview: z.string(),
      triggerSource: z.string(),
      triggerReason: z.string().nullable(),
      status: z.enum(["pending", "delivering", "delivered", "failed"]),
      attempts: z.number().int().min(0),
      createdAt: z.string().datetime(),
      updatedAt: z.string().datetime(),
      activitySummary: schemas.ActivitySummarySchema.optional(),
    }),
  );

  const ContactHistoryListResponseSchema = registry.register(
    "ContactHistoryListResponse",
    z.object({
      contacts: z.array(ContactHistorySummarySchema),
      total: z.number().int().min(0),
      nextCursor: z.null(),
      hasMore: z.boolean(),
    }),
  );

  const ContactHistoryDetailSchema = registry.register(
    "ContactHistoryDetail",
    ContactHistorySummarySchema.extend({
      message: z.string(),
      finalDeliveryError: z.string().nullable(),
      activityTrace: schemas.ActivityTraceSchema.optional(),
    }),
  );

  const ContactHistoryDetailResponseSchema = registry.register(
    "ContactHistoryDetailResponse",
    z.object({
      contact: ContactHistoryDetailSchema,
      conversation: schemas.ChatConversationDetailSchema,
    }),
  );

  Object.assign(schemas, {
    historyContactParamsSchema,
    historyItemsPageQuerySchema,
    conversationWindowQuerySchema,
    ContactHistorySummarySchema,
    ContactHistoryListResponseSchema,
    ContactHistoryDetailSchema,
    ContactHistoryDetailResponseSchema,
  });
};
