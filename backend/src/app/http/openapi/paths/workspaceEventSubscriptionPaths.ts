import { z } from "zod";
import type { OpenAPIRegistry } from "@asteasolutions/zod-to-openapi";

import { eventSubscriptionParamsSchema } from "../../routes/workspaceEventSubscriptionRoutes.js";
import type { OpenApiSchemas, OpenApiSecurity } from "../openApiRegistry.js";
import { registerWorkspaceEventSubscriptionSchemas } from "../schemas/workspaceEventSubscriptionSchemas.js";

const PERMISSION_NOTE = "Requires `workspace.event_subscriptions.manage`.";

/**
 * Event subscriptions (#1852): the CRUD a Zapier REST hook or an n8n trigger node drives, and the
 * push each subscription receives, published as an OpenAPI webhook.
 */
export const registerWorkspaceEventSubscriptionPaths = (
  registry: OpenAPIRegistry,
  schemas: OpenApiSchemas,
  security: OpenApiSecurity,
  workspaceEventSchema: z.ZodTypeAny,
) => {
  const subscriptions = registerWorkspaceEventSubscriptionSchemas(registry);
  const sec = [{ [security.bearerAuthScheme.name]: [] }];
  const json = (schema: z.ZodTypeAny) => ({ "application/json": { schema } });
  const errorResponse = (description: string) => ({ description, content: json(schemas.ErrorResponseSchema) });
  const tags = ["Workspace Events"];

  registry.registerPath({
    method: "post",
    path: "/api/v1/workspace/event-subscriptions",
    tags,
    summary: "Subscribe a URL to workspace events",
    description: [
      "Each event of `eventTypes` recorded from now on is POSTed to `targetUrl`, one event per request, in the order `GET /api/v1/workspace/events` lists them.",
      "The response carries `signingSecret` once; verify every push's `X-Radioso-Signature` with it.",
      "The target must be https on a host that resolves to a public address. A target that answers `410 Gone` is unsubscribed.",
      `Each type also needs the permission that reads it from the event log. A workspace holds at most 25 subscriptions. ${PERMISSION_NOTE}`,
    ].join(" "),
    operationId: "createEventSubscription",
    security: sec,
    request: { body: { content: json(subscriptions.CreateEventSubscriptionRequestSchema) } },
    responses: {
      201: { description: "Subscribed. `signingSecret` is shown only here.", content: json(subscriptions.EventSubscriptionCreatedSchema) },
      400: errorResponse("An invalid body, or `invalid_target_url`: not https, or not a public host"),
      401: errorResponse("Authentication required"),
      403: errorResponse("Subscription permission required, or `event_type_not_permitted` for a type the caller may not read"),
      409: errorResponse("`event_subscription_limit_reached`: the workspace already holds 25 subscriptions"),
      503: errorResponse("`encryption_not_configured`: the deployment has no key to store the secret"),
    },
  });

  registry.registerPath({
    method: "get",
    path: "/api/v1/workspace/event-subscriptions",
    tags,
    summary: "List event subscriptions",
    description: `The workspace's subscriptions, newest first, active and disabled. Target URLs are never returned; \`targetHost\` names where events go. ${PERMISSION_NOTE}`,
    operationId: "listEventSubscriptions",
    security: sec,
    responses: {
      200: { description: "The workspace's subscriptions", content: json(subscriptions.EventSubscriptionListSchema) },
      401: errorResponse("Authentication required"),
      403: errorResponse("Subscription permission required"),
    },
  });

  registry.registerPath({
    method: "get",
    path: "/api/v1/workspace/event-subscriptions/{subscriptionId}",
    tags,
    summary: "Get an event subscription",
    description: `One subscription, to check it still exists and is \`active\`. Treat \`404\` or \`disabled\` as gone and subscribe again. ${PERMISSION_NOTE}`,
    operationId: "getEventSubscription",
    security: sec,
    request: { params: eventSubscriptionParamsSchema },
    responses: {
      200: { description: "The subscription", content: json(subscriptions.EventSubscriptionResponseSchema) },
      401: errorResponse("Authentication required"),
      403: errorResponse("Subscription permission required"),
      404: errorResponse("No such subscription in this workspace"),
    },
  });

  registry.registerPath({
    method: "delete",
    path: "/api/v1/workspace/event-subscriptions/{subscriptionId}",
    tags,
    summary: "Delete an event subscription",
    description: `Stops pushes to its target. A push already in flight may still arrive. ${PERMISSION_NOTE}`,
    operationId: "deleteEventSubscription",
    security: sec,
    request: { params: eventSubscriptionParamsSchema },
    responses: {
      204: { description: "Deleted" },
      401: errorResponse("Authentication required"),
      403: errorResponse("Subscription permission required"),
      404: errorResponse("No such subscription in this workspace"),
    },
  });

  registry.registerWebhook({
    method: "post",
    path: "workspaceEvent",
    tags,
    summary: "A workspace event pushed to a subscription",
    description: [
      "Radioso POSTs one event per request to the subscription's target, in log order. The body is the same envelope `GET /api/v1/workspace/events` lists.",
      "Verify `X-Radioso-Signature` before trusting the body: `sha256=` and the hex HMAC-SHA256, keyed by the subscription's `signingSecret`, of `{X-Radioso-Timestamp}.{raw body}`.",
      "Delivery is at-least-once: deduplicate on `Idempotency-Key`, which is the event's `id`.",
      "Answer 2xx within 10 seconds to accept it. `410 Gone` deletes the subscription. Any other answer, a timeout or a redirect to another origin is a failure: the event is retried after 30 seconds, doubling to at most an hour, and newer events wait behind it. A subscription failing for 24 hours, after at least 5 attempts, is disabled.",
    ].join(" "),
    operationId: "receiveWorkspaceEvent",
    request: {
      headers: z.object({
        "X-Radioso-Signature": z.string().describe("`sha256=<hex HMAC-SHA256 of \"{timestamp}.{raw body}\" keyed by the signing secret>`"),
        "X-Radioso-Timestamp": z.string().describe("Unix seconds when the request was signed. Refuse one far from your clock to block replays."),
        "Idempotency-Key": z.string().uuid().describe("The event's `id`. The same event always carries the same key."),
      }),
      body: { content: json(workspaceEventSchema) },
    },
    responses: {
      200: { description: "Accepted: any 2xx moves the subscription past this event" },
      410: { description: "Gone: the subscription is deleted and receives nothing more" },
    },
  });
};
