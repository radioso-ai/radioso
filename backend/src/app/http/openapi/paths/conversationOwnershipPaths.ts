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

const takeOverConversationRequestSchema = z.object({
  reason: z.string().trim().min(1).max(500).optional(),
}).strict();

const replyToConversationRequestSchema = z.object({
  message: z.string().trim().min(1).max(50_000),
  expectedVersion: z.number().int().nonnegative(),
}).strict();

const transferConversationOwnershipRequestSchema = z.object({
  toUserId: z.string().uuid().describe(
    "The teammate to hand the conversation to. Pass your own user id to take a conversation another teammate holds.",
  ),
  expectedVersion: z.number().int().nonnegative(),
}).strict();

const handBackConversationRequestSchema = z.object({
  expectedVersion: z.number().int().nonnegative(),
}).strict();

export const registerConversationOwnershipPaths = (
  registry: OpenAPIRegistry,
  schemas: OpenApiSchemas,
  security: OpenApiSecurity,
) => {
  const bearerSecurity = [{ [security.bearerAuthScheme.name]: [] }];

  registry.registerPath({
    method: "get",
    path: "/api/v1/conversations/operators",
    tags: ["Conversation Ownership"],
    summary: "List the teammates who can own a conversation",
    description:
      "Returns the active teammates who hold conversation takeover permission on the workspace, labelled by display name, else email. These are the valid transfer targets.",
    operationId: "listConversationOperators",
    security: bearerSecurity,
    responses: {
      200: {
        description: "Teammates returned",
        content: json(schemas.ConversationOperatorsResponseSchema),
      },
      401: errorResponse("Authentication required", schemas),
      403: errorResponse("Workspace conversation takeover permission required", schemas),
    },
  });

  registry.registerPath({
    method: "get",
    path: "/api/v1/conversations/recently-closed",
    tags: ["Conversation Ownership"],
    summary: "List the Inbox items closed most recently",
    description:
      "Returns the workspace's most recently closed Inbox items, newest first: handoffs handed back to the agent, approvals decided, and negative feedback resolved or dismissed. Each item names the teammate who closed it, labelled by display name, else email. Dashboard test chats are left out.",
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

  registry.registerPath({
    method: "post",
    path: "/api/v1/conversations/{conversationId}/takeover",
    tags: ["Conversation Ownership"],
    summary: "Take human ownership of a conversation",
    description:
      "Claims a conversation the AI owns or that waits for a teammate. A conversation another teammate holds returns 409; take it from them by transferring it to yourself.",
    operationId: "takeOverConversation",
    security: bearerSecurity,
    request: {
      params: schemas.conversationParamsSchema,
      body: {
        required: true,
        content: json(takeOverConversationRequestSchema),
      },
    },
    responses: {
      200: {
        description: "Conversation ownership returned",
        content: json(schemas.ConversationOwnershipResponseSchema),
      },
      400: errorResponse("Request validation failed", schemas),
      401: errorResponse("Authentication required", schemas),
      403: errorResponse("Workspace conversation takeover permission required", schemas),
      404: errorResponse("Conversation not found", schemas),
      409: errorResponse("Conversation ownership changed", schemas),
    },
  });

  registry.registerPath({
    method: "post",
    path: "/api/v1/conversations/{conversationId}/reply",
    tags: ["Conversation Ownership"],
    summary: "Reply to a conversation as a human operator",
    description:
      "Only the teammate who owns the conversation replies. A reply to a conversation the AI owns, or one waiting for a teammate, claims it for you first. A conversation another teammate holds, or an `expectedVersion` that is no longer current, returns 409 with the current ownership.",
    operationId: "replyToConversation",
    security: bearerSecurity,
    request: {
      params: schemas.conversationParamsSchema,
      body: {
        required: true,
        content: json(replyToConversationRequestSchema),
      },
    },
    responses: {
      201: {
        description: "Human reply message created",
        content: json(schemas.HumanReplyMessageResponseSchema),
      },
      400: errorResponse("Request validation failed", schemas),
      401: errorResponse("Authentication required", schemas),
      403: errorResponse("Workspace conversation takeover permission required", schemas),
      404: errorResponse("Conversation not found", schemas),
      409: errorResponse("Conversation ownership changed", schemas),
    },
  });

  registry.registerPath({
    method: "post",
    path: "/api/v1/conversations/{conversationId}/transfer",
    tags: ["Conversation Ownership"],
    summary: "Transfer human ownership of a conversation",
    description:
      "Hands a human-owned conversation to another teammate, or to yourself to take it from the teammate holding it. The receiving teammate gets an email with a link to the conversation unless they made the transfer. A target who is not a teammate able to own conversations on the workspace returns 404 with code `transfer_target_unavailable`; a conversation that is not in the workspace returns 404 with code `not_found`.",
    operationId: "transferConversationOwnership",
    security: bearerSecurity,
    request: {
      params: schemas.conversationParamsSchema,
      body: {
        required: true,
        content: json(transferConversationOwnershipRequestSchema),
      },
    },
    responses: {
      200: {
        description: "Conversation ownership returned",
        content: json(schemas.ConversationOwnershipResponseSchema),
      },
      400: errorResponse("Request validation failed", schemas),
      401: errorResponse("Authentication required", schemas),
      403: errorResponse("Workspace conversation takeover permission required", schemas),
      404: errorResponse("Conversation not found (`not_found`), or transfer target unavailable (`transfer_target_unavailable`)", schemas),
      409: errorResponse("Conversation ownership changed", schemas),
    },
  });

  registry.registerPath({
    method: "post",
    path: "/api/v1/conversations/{conversationId}/handback",
    tags: ["Conversation Ownership"],
    summary: "Return a human-owned conversation to AI ownership",
    description:
      "Only the teammate who owns the conversation hands it back; anyone may while it waits unclaimed. A conversation another teammate holds, or an `expectedVersion` that is no longer current, returns 409 with the current ownership.",
    operationId: "handBackConversation",
    security: bearerSecurity,
    request: {
      params: schemas.conversationParamsSchema,
      body: {
        required: true,
        content: json(handBackConversationRequestSchema),
      },
    },
    responses: {
      200: {
        description: "Conversation ownership returned",
        content: json(schemas.ConversationOwnershipResponseSchema),
      },
      400: errorResponse("Request validation failed", schemas),
      401: errorResponse("Authentication required", schemas),
      403: errorResponse("Workspace conversation takeover permission required", schemas),
      404: errorResponse("Conversation not found", schemas),
      409: errorResponse("Conversation ownership changed", schemas),
    },
  });
};
