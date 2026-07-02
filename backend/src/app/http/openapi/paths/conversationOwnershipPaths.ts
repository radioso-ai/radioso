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
  toAccountId: z.string().uuid(),
  expectedVersion: z.number().int().nonnegative(),
}).strict();

const handBackConversationRequestSchema = z.object({
  expectedVersion: z.number().int().nonnegative(),
}).strict();

const forkConversationResponseSchema = z.object({
  conversationId: z.string().uuid(),
}).strict();

export const registerConversationOwnershipPaths = (
  registry: OpenAPIRegistry,
  schemas: OpenApiSchemas,
  security: OpenApiSecurity,
) => {
  const bearerSecurity = [{ [security.bearerAuthScheme.name]: [] }];

  registry.registerPath({
    method: "post",
    path: "/api/v1/conversations/{conversationId}/takeover",
    tags: ["Conversation Ownership"],
    summary: "Take human ownership of a conversation",
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
      404: errorResponse("Conversation not found", schemas),
      409: errorResponse("Conversation ownership changed", schemas),
    },
  });

  registry.registerPath({
    method: "post",
    path: "/api/v1/conversations/{conversationId}/handback",
    tags: ["Conversation Ownership"],
    summary: "Return a human-owned conversation to AI ownership",
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

  registry.registerPath({
    method: "post",
    path: "/api/v1/conversations/{conversationId}/fork",
    tags: ["Conversation Ownership"],
    summary: "Fork a conversation into a dashboard test session",
    description:
      "Copies the conversation's user and assistant message thread into a new conversation tagged " +
      "as an authenticated_chat test session (same agent and workspace), leaving the original untouched.",
    operationId: "forkConversation",
    security: bearerSecurity,
    request: {
      params: schemas.conversationParamsSchema,
    },
    responses: {
      200: {
        description: "Forked test-session conversation created",
        content: json(forkConversationResponseSchema),
      },
      401: errorResponse("Authentication required", schemas),
      404: errorResponse("Conversation not found", schemas),
    },
  });
};
