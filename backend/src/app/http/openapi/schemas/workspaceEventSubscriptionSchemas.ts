import { z } from "zod";
import type { OpenAPIRegistry } from "@asteasolutions/zod-to-openapi";

import { createEventSubscriptionBodySchema } from "../../routes/workspaceEventSubscriptionRoutes.js";
import { eventSubscriptionViewSchema } from "../../../../modules/workspaceEventLog/public.js";

/** Event subscriptions (#1852): what create takes and returns, and the subscription as listed. */
export const registerWorkspaceEventSubscriptionSchemas = (registry: OpenAPIRegistry) => {
  const EventSubscriptionSchema = registry.register("EventSubscription", eventSubscriptionViewSchema);
  const EventSubscriptionCreatedSchema = registry.register("EventSubscriptionCreated", z.object({
    subscription: EventSubscriptionSchema,
    signingSecret: z.string().describe("Verifies `X-Radioso-Signature` on every push. Returned only here; store it now. Subscribing the same URL again issues a new one."),
  }));
  return {
    CreateEventSubscriptionRequestSchema: registry.register("CreateEventSubscriptionRequest", createEventSubscriptionBodySchema),
    EventSubscriptionCreatedSchema,
    EventSubscriptionListSchema: registry.register("EventSubscriptionList", z.object({ subscriptions: z.array(EventSubscriptionSchema) })),
    EventSubscriptionResponseSchema: registry.register("EventSubscriptionResponse", z.object({ subscription: EventSubscriptionSchema })),
  };
};
