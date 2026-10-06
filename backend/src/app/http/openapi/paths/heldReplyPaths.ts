import { z } from "zod";
import type { OpenAPIRegistry } from "@asteasolutions/zod-to-openapi";

import type { OpenApiSchemas, OpenApiSecurity } from "../openApiRegistry.js";
import { registerHeldReplySchemas } from "../schemas/heldReplySchemas.js";

const TAGS = ["Conversation Ownership"];
const ConversationParams = z.object({ conversationId: z.string().uuid() });
const HeldReplyParams = ConversationParams.extend({ heldReplyId: z.string().uuid() });

/**
 * Replies an agent wrote in review that wait for a teammate, and a teammate's decisions on them.
 * Session-only under `workspace.conversation.takeover`, like taking over and replying.
 */
export const registerHeldReplyPaths = (
  registry: OpenAPIRegistry,
  schemas: OpenApiSchemas,
  security: OpenApiSecurity,
) => {
  const heldReplies = registerHeldReplySchemas(registry);
  const sec = [{ [security.bearerAuthScheme.name]: [] }];
  const json = (schema: z.ZodTypeAny) => ({ "application/json": { schema } });
  const errorResponse = (description: string) => ({ description, content: json(schemas.ErrorResponseSchema) });
  const unauthenticated = errorResponse("Authentication required");
  const takeoverRequired = errorResponse("Workspace conversation takeover permission required");
  const notFound = errorResponse("Not a conversation or held reply of this workspace");
  const notPending = "`held_reply_not_pending`: the held reply was already decided or replaced; `details.heldReply` carries it as it is now";

  registry.registerPath({
    method: "get",
    path: "/api/v1/held-replies",
    tags: TAGS,
    summary: "List held replies",
    description: "Replies an agent wrote in review that wait for a teammate, newest first. With `attention=all`, the decided, replaced and automatically queued ones too.",
    operationId: "listHeldReplies",
    security: sec,
    request: { query: heldReplies.ListHeldRepliesQuerySchema },
    responses: {
      200: { description: "Held replies", content: json(heldReplies.HeldReplyPageSchema) },
      400: errorResponse("An invalid query or cursor"),
      401: unauthenticated,
      403: takeoverRequired,
    },
  });

  registry.registerPath({
    method: "get",
    path: "/api/v1/conversations/{conversationId}/held-reply",
    tags: TAGS,
    summary: "Get a conversation's current held reply",
    description: "The conversation's newest held reply, whatever its state, under a `heldReply` root; null when it has none.",
    operationId: "getCurrentHeldReply",
    security: sec,
    request: { params: ConversationParams },
    responses: {
      200: { description: "The current held reply", content: json(heldReplies.CurrentHeldReplyResponseSchema) },
      400: errorResponse("Invalid conversation id"),
      401: unauthenticated,
      403: takeoverRequired,
      404: errorResponse("Not a conversation of this workspace"),
    },
  });

  registry.registerPath({
    method: "post",
    path: "/api/v1/conversations/{conversationId}/held-replies/{heldReplyId}/release",
    tags: TAGS,
    summary: "Release a held reply",
    description: "Sends a pending draft to the customer. Without `editedText` it goes out as the agent wrote it, as the agent's message; with `editedText` the teammate's edit goes out as their own message and the draft is kept. Who owns the conversation does not change. Each refusal carries the held reply as it is now in `details.heldReply`.",
    operationId: "releaseHeldReply",
    security: sec,
    request: { params: HeldReplyParams, body: { required: false, content: json(heldReplies.ReleaseHeldReplyRequestSchema) } },
    responses: {
      201: { description: "Held reply released and its delivery queued", content: json(heldReplies.HeldReplyReleaseResultSchema) },
      400: errorResponse("Invalid ids or edit"),
      401: unauthenticated,
      403: takeoverRequired,
      404: notFound,
      409: errorResponse(`${notPending}; \`ownership_changed\`: the conversation changed hands since the draft was held; \`policy_changed\`: the channel's settings changed since the draft was held; \`channel_not_ready\`: the conversation's channel cannot send it; \`email_sending_not_verified\`: the sending domain is not verified`),
    },
  });

  registry.registerPath({
    method: "post",
    path: "/api/v1/conversations/{conversationId}/held-replies/{heldReplyId}/discard",
    tags: TAGS,
    summary: "Discard a held reply",
    description: "Sets a pending draft aside. The customer hears nothing, and the conversation keeps waiting for a teammate until one replies or takes it over.",
    operationId: "discardHeldReply",
    security: sec,
    request: { params: HeldReplyParams },
    responses: {
      200: { description: "Held reply discarded", content: json(heldReplies.HeldReplySchema) },
      400: errorResponse("Invalid ids"),
      401: unauthenticated,
      403: takeoverRequired,
      404: notFound,
      409: errorResponse(notPending),
    },
  });
};
