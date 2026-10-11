import { z } from "zod";
import type { OpenAPIRegistry } from "@asteasolutions/zod-to-openapi";

import { listDeliveryFailuresQuerySchema, resolveDeliveryFailureRequestSchema } from "../../routes/deliveryFailureRoutes.js";

/** Replies that may not have reached the customer (specs/1403-email-channel/contracts/openapi-additions.md §2). */
export const registerDeliveryFailureSchemas = (registry: OpenAPIRegistry) => {
  const DeliveryFailureSchema = registry.register("DeliveryFailure", z.object({
    id: z.string().uuid(),
    conversationId: z.string().uuid(),
    messageId: z.string().uuid().nullable().openapi({ description: "Null for a failure that names no message." }),
    provider: z.string().openapi({ description: "The delivering channel's provider." }),
    kind: z.enum(["bounced", "failed", "uncertain", "halted"]).openapi({
      description: "`bounced`: bounced or suppressed. `failed`: refused or failed. `uncertain`: the outcome is unknown and nothing will send it again on its own. `halted`: it never went out, because the authority to send it was gone.",
    }),
    detailCode: z.string().nullable().openapi({ description: "The provider's code, sanitized; never its bounce message." }),
    openedAt: z.string().datetime(),
    clearedAt: z.string().datetime().nullable(),
    clearReason: z.enum(["acknowledged", "later_delivery", "provider_evidence", "operator_resolved"]).nullable(),
  }));
  const DeliveryFailurePageSchema = registry.register("DeliveryFailurePage", z.object({
    items: z.array(DeliveryFailureSchema),
    nextCursor: z.string().nullable().openapi({ description: "Pass back as `cursor` for the next page; null on the last one." }),
  }));

  return {
    DeliveryFailureSchema,
    DeliveryFailurePageSchema,
    ResolveDeliveryFailureRequestSchema: registry.register("ResolveDeliveryFailureRequest", resolveDeliveryFailureRequestSchema),
    ListDeliveryFailuresQuerySchema: listDeliveryFailuresQuerySchema,
  };
};
