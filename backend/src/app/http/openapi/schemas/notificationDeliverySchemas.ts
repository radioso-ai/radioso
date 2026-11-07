import { z } from "zod";
import type { OpenAPIRegistry } from "@asteasolutions/zod-to-openapi";

import { listNotificationDeliveriesQuerySchema } from "../../routes/notificationDeliveryRoutes.js";

/** What happened to each address of each notice: the delivery log behind the agent's recent notifications. */
export const registerNotificationDeliverySchemas = (registry: OpenAPIRegistry) => {
  const NotificationDeliverySchema = registry.register("NotificationDelivery", z.object({
    id: z.string().uuid(),
    agentId: z.string().uuid().nullable().openapi({ description: "Null when the notice names no agent, or its agent was deleted." }),
    conversationId: z.string().uuid().openapi({ description: "The conversation that raised the notice." }),
    kind: z.enum(["contact_request", "approval", "handoff", "completion"]).openapi({
      description: "What raised the notice: a contact request, an approval, or a routine ending's hand-off or completion.",
    }),
    recipientEmail: z.string().openapi({ description: "The normalized address the notice was meant for." }),
    outcome: z.enum([
      "sent",
      "skipped_unconfirmed",
      "skipped_revoked",
      "skipped_suppressed",
      "skipped_cap",
      "not_dispatched",
      "failed",
    ]).openapi({
      description: "`sent`: the mail provider accepted it. `skipped_unconfirmed`: the address has not confirmed. `skipped_revoked`: its owner stopped notifications. `skipped_suppressed`: an earlier mail bounced or was reported as spam. `skipped_cap`: a daily or per-conversation limit stopped it. `not_dispatched`: the deployment records mail without sending it. `failed`: the mail was attempted and did not go out, or the address's state could not be read.",
    }),
    createdAt: z.string().datetime().openapi({ description: "When the notice was first handled." }),
    updatedAt: z.string().datetime().openapi({ description: "When its latest attempt settled." }),
  }));
  const NotificationDeliveryPageSchema = registry.register("NotificationDeliveryPage", z.object({
    items: z.array(NotificationDeliverySchema),
    nextCursor: z.string().nullable().openapi({ description: "Pass back as `cursor` for the next page; null on the last one." }),
  }));

  return {
    NotificationDeliverySchema,
    NotificationDeliveryPageSchema,
    ListNotificationDeliveriesQuerySchema: listNotificationDeliveriesQuerySchema,
  };
};
