import { z } from "zod";
import type { OpenAPIRegistry } from "@asteasolutions/zod-to-openapi";

import type { OpenApiSchemas, OpenApiSecurity } from "../openApiRegistry.js";

const json = (schema: z.ZodTypeAny) => ({
  "application/json": {
    schema,
  },
});

const errorResponse = (description: string, schemas: OpenApiSchemas) => ({
  description,
  content: json(schemas.ErrorResponseSchema),
});

export const registerConversationActivityPaths = (
  registry: OpenAPIRegistry,
  schemas: OpenApiSchemas,
  security: OpenApiSecurity,
) => {
  const bearerSecurity = [{ [security.bearerAuthScheme.name]: [] }];

  registry.registerPath({
    method: "get",
    path: "/api/v1/conversations/recently-closed",
    tags: ["Conversation Activity"],
    summary: "List the Inbox items closed most recently",
    description:
      "Returns the workspace's most recently closed Inbox items, newest first: handoffs handed back to the agent, approvals decided, and negative feedback resolved or dismissed. Negative feedback is listed only to a caller with Quality access (`workspace.quality.read`). Each item names the teammate who closed it, labelled by display name, else email. Dashboard test chats are left out.",
    operationId: "listRecentlyClosedInboxItems",
    security: bearerSecurity,
    request: {
      query: z.object({
        limit: z.coerce.number().int().min(1).max(50).default(10).describe("How many items to return, 1 to 50."),
      }),
    },
    responses: {
      200: {
        description: "Recently closed items returned",
        content: json(schemas.RecentlyClosedInboxItemsResponseSchema),
      },
      400: errorResponse("Invalid query", schemas),
      401: errorResponse("Authentication required", schemas),
      403: errorResponse("Workspace conversation takeover permission required", schemas),
    },
  });
};
