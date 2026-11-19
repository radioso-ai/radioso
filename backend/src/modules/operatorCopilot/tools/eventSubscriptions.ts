import { z } from "zod";

import { eventSubscriptionViewSchema, type EventSubscriptionView } from "../../workspaceEventLog/public.js";
import type { CopilotToolDescriptor } from "../contracts.js";
import { boundPayload } from "../payloadCompaction.js";

const inputSchema = z.object({}).strict();

/** The published subscription view, with the creator named by kind only. */
const subscriptionSchema = eventSubscriptionViewSchema.extend({
  createdBy: z.object({ kind: eventSubscriptionViewSchema.shape.createdBy.shape.kind }).strict(),
});

const outputSchema = z.object({ subscriptions: z.array(subscriptionSchema) }).strict();

type CopilotEventSubscription = z.infer<typeof subscriptionSchema>;

export interface CopilotEventSubscriptionsPort {
  list(workspaceId: string): Promise<readonly EventSubscriptionView[]>;
}

export interface EventSubscriptionsCopilotToolDependencies {
  readonly eventSubscriptions: CopilotEventSubscriptionsPort;
}

/**
 * The fields Ray reads, named one by one, so a field added to the view reaches the model only when
 * it is added here. The creator is a kind: which token or person made it is the operator's to look
 * up in Settings.
 */
const forRay = (subscription: EventSubscriptionView): CopilotEventSubscription => ({
  id: subscription.id,
  label: subscription.label,
  targetHost: subscription.targetHost,
  eventTypes: subscription.eventTypes,
  status: subscription.status,
  disabledReason: subscription.disabledReason,
  createdAt: subscription.createdAt,
  createdBy: { kind: subscription.createdBy.kind },
  lastDelivery: subscription.lastDelivery
    ? { at: subscription.lastDelivery.at, outcome: subscription.lastDelivery.outcome, statusCode: subscription.lastDelivery.statusCode }
    : null,
  failingSince: subscription.failingSince,
});

const DESCRIPTION = "Read the workspace's event subscriptions: the URLs a receiver subscribed over the API to receive workspace events (conversations started, contact requests, handoffs, routine completions, pending decisions) as signed pushes. Each gives the client label (zapier, n8n or custom), the target's host (never its URL), the event types, whether a service account, a personal token or a teammate created it, the last delivery's time, outcome and HTTP status, when the current run of failures began, and the status: active, or disabled with delivery_failing (its target failed for a day) or creator_revoked (the token or teammate that created it may no longer read those events). Use it when an operator asks why an automation stopped receiving events. A disabled subscription receives nothing until its client subscribes the same URL again; a target that answered 410 Gone was removed and is not listed.";

// The target URL and signing secret never reach this surface: a hook URL can itself be a bearer
// capability, and the service's view carries the host only.
export const createEventSubscriptionsCopilotTools = (
  deps: EventSubscriptionsCopilotToolDependencies,
): ReadonlyArray<CopilotToolDescriptor> => [
  {
    name: "list_event_subscriptions", shape: "read", verificationCost: () => 0, uiLabel: "Reading event subscriptions", contributingModule: "workspaceEventLog", dashboardSubject: { type: "workspace_settings" }, requiredPermissions: ["workspace.event_subscriptions.manage"],
    description: DESCRIPTION,
    inputSchema, outputSchema,
    createTool: (context) => ({
      name: "list_event_subscriptions", description: DESCRIPTION, inputSchema, outputSchema,
      invoke: async () => boundPayload({ subscriptions: (await deps.eventSubscriptions.list(context.workspaceId)).map(forRay) }),
    }),
  },
];
