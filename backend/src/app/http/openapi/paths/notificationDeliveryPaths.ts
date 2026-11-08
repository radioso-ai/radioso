import { z } from "zod";
import type { OpenAPIRegistry } from "@asteasolutions/zod-to-openapi";

import type { OpenApiSchemas, OpenApiSecurity } from "../openApiRegistry.js";
import { registerNotificationDeliverySchemas } from "../schemas/notificationDeliverySchemas.js";

/**
 * What happened to each address of each notice, newest first. Recipient emails are personal data,
 * so the route accepts workspace sessions only.
 */
export const registerNotificationDeliveryPaths = (
  registry: OpenAPIRegistry,
  schemas: OpenApiSchemas,
  security: OpenApiSecurity,
) => {
  const deliveries = registerNotificationDeliverySchemas(registry);
  const sec = [{ [security.bearerAuthScheme.name]: [] }];
  const json = (schema: z.ZodTypeAny) => ({ "application/json": { schema } });
  const errorResponse = (description: string) => ({ description, content: json(schemas.ErrorResponseSchema) });

  registry.registerPath({
    method: "get",
    path: "/api/v1/notification-deliveries",
    tags: ["Agent Skills"],
    summary: "List notification deliveries",
    description: "What happened to each address of each notice, newest first: when it was handled, which kind of notice, which conversation, which address, and whether it was sent or why it was skipped. Recipient emails are personal data, so this route accepts workspace sessions only.",
    operationId: "listNotificationDeliveries",
    security: sec,
    request: { query: deliveries.ListNotificationDeliveriesQuerySchema },
    responses: {
      200: { description: "Notification deliveries", content: json(deliveries.NotificationDeliveryPageSchema) },
      400: errorResponse("An invalid query or cursor"),
      401: errorResponse("Authentication required"),
      403: errorResponse("Agent read permission required"),
    },
  });
};
