import { z } from "zod";
import type { OpenAPIRegistry } from "@asteasolutions/zod-to-openapi";

import type { OpenApiSchemas, OpenApiSecurity } from "../openApiRegistry.js";
import { registerDeliveryFailureSchemas } from "../schemas/deliveryFailureSchemas.js";

const TAGS = ["Conversation Ownership"];
const FailureParams = z.object({ failureId: z.string().uuid() });

/**
 * Replies that may not have reached the customer, and a teammate's decisions on them. Session-only
 * under `workspace.conversation.takeover`, like taking over and replying.
 */
export const registerDeliveryFailurePaths = (
  registry: OpenAPIRegistry,
  schemas: OpenApiSchemas,
  security: OpenApiSecurity,
) => {
  const failures = registerDeliveryFailureSchemas(registry);
  const sec = [{ [security.bearerAuthScheme.name]: [] }];
  const json = (schema: z.ZodTypeAny) => ({ "application/json": { schema } });
  const errorResponse = (description: string) => ({ description, content: json(schemas.ErrorResponseSchema) });
  const unauthenticated = errorResponse("Authentication required");
  const takeoverRequired = errorResponse("Workspace conversation takeover permission required");
  const notFound = errorResponse("Not a delivery failure of this workspace");

  registry.registerPath({
    method: "get",
    path: "/api/v1/delivery-failures",
    tags: TAGS,
    summary: "List delivery failures",
    description: "Replies that may not have reached the customer, newest first: the open ones, or with `state=all` the cleared ones too.",
    operationId: "listDeliveryFailures",
    security: sec,
    request: { query: failures.ListDeliveryFailuresQuerySchema },
    responses: {
      200: { description: "Delivery failures", content: json(failures.DeliveryFailurePageSchema) },
      400: errorResponse("An invalid query or cursor"),
      401: unauthenticated,
      403: takeoverRequired,
    },
  });

  registry.registerPath({
    method: "post",
    path: "/api/v1/delivery-failures/{failureId}/acknowledge",
    tags: TAGS,
    summary: "Acknowledge a delivery failure",
    description: "Clears the failure as seen by the signed-in teammate. Sends nothing.",
    operationId: "acknowledgeDeliveryFailure",
    security: sec,
    request: { params: FailureParams },
    responses: {
      200: { description: "Failure acknowledged", content: json(failures.DeliveryFailureSchema) },
      400: errorResponse("Invalid failure id"),
      401: unauthenticated,
      403: takeoverRequired,
      404: notFound,
      409: errorResponse("`already_cleared`"),
    },
  });

  registry.registerPath({
    method: "post",
    path: "/api/v1/delivery-failures/{failureId}/resolve",
    tags: TAGS,
    summary: "Resolve a delivery failure",
    description: "An audited decision on a reply whose delivery failed. `marked_sent` settles an `uncertain` send as sent. `resend` sends an `uncertain` or `halted` reply once more, once its channel can send; it is the only way a reply goes out twice.",
    operationId: "resolveDeliveryFailure",
    security: sec,
    request: { params: FailureParams, body: { required: true, content: json(failures.ResolveDeliveryFailureRequestSchema) } },
    responses: {
      200: { description: "Failure resolved", content: json(failures.DeliveryFailureSchema) },
      400: errorResponse("Invalid failure id or decision"),
      401: unauthenticated,
      403: takeoverRequired,
      404: notFound,
      409: errorResponse("`not_resolvable`: the failure is cleared or its kind does not admit the decision; `email_sending_not_verified`: the channel cannot send yet"),
    },
  });
};
