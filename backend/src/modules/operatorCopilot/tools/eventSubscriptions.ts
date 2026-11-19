import { z } from "zod";

import type { EventSubscriptionView } from "../../workspaceEventLog/public.js";
import type { CopilotToolDescriptor } from "../contracts.js";
import { boundPayload } from "../payloadCompaction.js";

const inputSchema = z.object({}).strict();

const outputSchema = z.object({
  subscriptions: z.array(z.object({
    id: z.string().uuid(),
    label: z.enum(["zapier", "n8n", "custom"]),
    targetHost: z.string(),
    eventTypes: z.array(z.string()),
    status: z.enum(["active", "disabled"]),
    disabledReason: z.enum(["delivery_failing", "creator_revoked"]).nullable(),
    createdAt: z.string(),
    createdBy: z.object({ kind: z.enum(["service_account", "personal_token", "teammate"]), label: z.string().nullable() }),
    lastDelivery: z.object({ at: z.string(), outcome: z.enum(["delivered", "failed"]), statusCode: z.number().nullable() }).nullable(),
    failingSince: z.string().nullable(),
  })),
});

export interface CopilotEventSubscriptionsPort {
  list(workspaceId: string): Promise<readonly EventSubscriptionView[]>;
}

export interface EventSubscriptionsCopilotToolDependencies {
  readonly eventSubscriptions: CopilotEventSubscriptionsPort;
}

const DESCRIPTION = "Read the workspace's event subscriptions: the URLs Zapier, n8n or a custom receiver registered to receive workspace events (conversations started, contact requests, handoffs, routine completions, pending decisions) as signed pushes. Each gives the client label, the target's host (never its URL), the event types, which service account, token or teammate created it, the last delivery's time, outcome and HTTP status, when the current run of failures began, and the status: active, or disabled with delivery_failing (its target failed for a day) or creator_revoked (the token or teammate that created it may no longer read those events). Use it when an operator asks why an automation stopped receiving events. A disabled subscription receives nothing until its client subscribes again; a target that answered 410 Gone was removed and is not listed.";

// The target URL and signing secret never reach this surface: a Zapier hook URL is itself a
// bearer capability, and the service's view carries the host only.
export const createEventSubscriptionsCopilotTools = (
  deps: EventSubscriptionsCopilotToolDependencies,
): ReadonlyArray<CopilotToolDescriptor> => [
  {
    name: "list_event_subscriptions", shape: "read", verificationCost: () => 0, uiLabel: "Reading event subscriptions", contributingModule: "workspaceEventLog", dashboardSubject: { type: "workspace_settings" }, requiredPermissions: ["workspace.event_subscriptions.manage"],
    description: DESCRIPTION,
    inputSchema, outputSchema,
    createTool: (context) => ({
      name: "list_event_subscriptions", description: DESCRIPTION, inputSchema, outputSchema,
      invoke: async () => boundPayload({ subscriptions: [...await deps.eventSubscriptions.list(context.workspaceId)] }),
    }),
  },
];
