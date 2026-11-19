import { z } from "zod";
import type { OpenAPIRegistry } from "@asteasolutions/zod-to-openapi";

import { createEventSubscriptionBodySchema } from "../../routes/workspaceEventSubscriptionRoutes.js";
import { WORKSPACE_EVENT_TYPES } from "../../../../shared/domain/workspaceEventLog.js";
import {
  EVENT_DELIVERY_OUTCOMES,
  EVENT_SUBSCRIPTION_CREATOR_KINDS,
  EVENT_SUBSCRIPTION_DISABLED_REASONS,
  EVENT_SUBSCRIPTION_LABELS,
  EVENT_SUBSCRIPTION_STATUSES,
} from "../../../../shared/domain/workspaceEventSubscriptions.js";

/** Event subscriptions (#1852): what create takes and returns, and the subscription as listed. */
export const registerWorkspaceEventSubscriptionSchemas = (registry: OpenAPIRegistry) => {
  const EventSubscriptionSchema = registry.register("EventSubscription", z.object({
    id: z.string().uuid(),
    label: z.enum(EVENT_SUBSCRIPTION_LABELS).describe("Which client registered it."),
    targetHost: z.string().describe("The host events are POSTed to. The full target URL is never returned after create."),
    eventTypes: z.array(z.enum(WORKSPACE_EVENT_TYPES)),
    status: z.enum(EVENT_SUBSCRIPTION_STATUSES).describe("`disabled` receives nothing more. Delete it and subscribe again to start over at the newest events."),
    disabledReason: z.enum(EVENT_SUBSCRIPTION_DISABLED_REASONS).nullable()
      .describe("`delivery_failing` after a day of failed deliveries; `creator_revoked` once the credential or teammate that created it may no longer read its types."),
    createdAt: z.string().datetime(),
    createdBy: z.object({
      kind: z.enum(EVENT_SUBSCRIPTION_CREATOR_KINDS),
      label: z.string().nullable().describe("The service account's or token's name, or the teammate's, as it reads now."),
    }),
    lastDelivery: z.object({
      at: z.string().datetime(),
      outcome: z.enum(EVENT_DELIVERY_OUTCOMES),
      statusCode: z.number().int().nullable().describe("The target's HTTP status, or null when no response came back (timeout, refused address)."),
    }).nullable(),
    failingSince: z.string().datetime().nullable().describe("When the current run of failed deliveries began; null while delivering."),
  }));
  const EventSubscriptionCreatedSchema = registry.register("EventSubscriptionCreated", z.object({
    subscription: EventSubscriptionSchema,
    signingSecret: z.string().describe("Verifies `X-Radioso-Signature` on every push. Returned only here; store it now."),
  }));
  return {
    CreateEventSubscriptionRequestSchema: registry.register("CreateEventSubscriptionRequest", createEventSubscriptionBodySchema),
    EventSubscriptionCreatedSchema,
    EventSubscriptionListSchema: registry.register("EventSubscriptionList", z.object({ subscriptions: z.array(EventSubscriptionSchema) })),
    EventSubscriptionResponseSchema: registry.register("EventSubscriptionResponse", z.object({ subscription: EventSubscriptionSchema })),
  };
};
