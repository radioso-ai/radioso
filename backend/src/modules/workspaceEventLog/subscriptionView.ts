import { z } from "zod";

import { WORKSPACE_EVENT_TYPES } from "../../shared/domain/workspaceEventLog.js";
import {
  EVENT_DELIVERY_OUTCOMES,
  EVENT_SUBSCRIPTION_CREATOR_KINDS,
  EVENT_SUBSCRIPTION_DISABLED_REASONS,
  EVENT_SUBSCRIPTION_LABELS,
  EVENT_SUBSCRIPTION_STATUSES,
  type StoredEventSubscription,
} from "../../shared/domain/workspaceEventSubscriptions.js";

/**
 * A subscription as the API, Settings and Ray show it: where events go by host, never the target
 * URL or the secret. The OpenAPI document publishes this schema as `EventSubscription`.
 */
export const eventSubscriptionViewSchema = z.object({
  id: z.string().uuid(),
  label: z.enum(EVENT_SUBSCRIPTION_LABELS).describe("Which client registered it."),
  targetHost: z.string().describe("The host events are POSTed to. The full target URL is never returned after create."),
  eventTypes: z.array(z.enum(WORKSPACE_EVENT_TYPES)),
  status: z.enum(EVENT_SUBSCRIPTION_STATUSES)
    .describe("`disabled` receives nothing more until its client subscribes the same URL again."),
  disabledReason: z.enum(EVENT_SUBSCRIPTION_DISABLED_REASONS).nullable()
    .describe("`delivery_failing` after a day of failed deliveries; `creator_revoked` once the credential or teammate that created it may no longer read its types."),
  createdAt: z.string().datetime(),
  createdBy: z.object({
    kind: z.enum(EVENT_SUBSCRIPTION_CREATOR_KINDS),
    label: z.string().nullable().describe("The service account's or token's name, or the teammate's display name, as it reads now. Null for a teammate without a display name."),
  }).strict(),
  lastDelivery: z.object({
    at: z.string().datetime(),
    outcome: z.enum(EVENT_DELIVERY_OUTCOMES),
    statusCode: z.number().int().nullable().describe("The target's HTTP status, or null when no response came back (a timeout, a refused or unresolvable host)."),
  }).strict().nullable(),
  failingSince: z.string().datetime().nullable().describe("When the current run of failed deliveries began; null while delivering."),
}).strict();

export type EventSubscriptionView = z.infer<typeof eventSubscriptionViewSchema>;

export const presentEventSubscription = (subscription: StoredEventSubscription): EventSubscriptionView => ({
  id: subscription.id,
  label: subscription.label,
  targetHost: subscription.targetHost,
  eventTypes: subscription.eventTypes,
  status: subscription.status,
  disabledReason: subscription.disabledReason,
  createdAt: subscription.createdAt.toISOString(),
  createdBy: { kind: subscription.createdBy.kind, label: subscription.createdBy.label },
  lastDelivery: subscription.lastDelivery
    ? { at: subscription.lastDelivery.at.toISOString(), outcome: subscription.lastDelivery.outcome, statusCode: subscription.lastDelivery.statusCode }
    : null,
  failingSince: subscription.failingSince?.toISOString() ?? null,
});
