import { z } from "zod";
import type { OpenAPIRegistry } from "@asteasolutions/zod-to-openapi";

import { conversationAttributeParamsSchema, conversationAttributeValueBodySchema } from "../../routes/conversationRouteSchemas.js";
import type { OpenApiSchemas, OpenApiSecurity } from "../openApiRegistry.js";

const TAGS = ["History"];

const refusals = "`404` when the conversation or an attribute by that exact name does not exist. `400` `attribute_not_editable` for an attribute a teammate doesn't edit here, with `details.reason`: `private` for a Private attribute, whose value a teammate never sees, and `not_choice` for a set of one that is not a Choice.";

/**
 * A teammate sets a conversation's Choice attribute, or resets any attribute that is not Private
 * (#1884): the Inbox's edit, also reachable through Ray and operator MCP.
 */
export const registerHistoryAttributePaths = (
  registry: OpenAPIRegistry,
  schemas: OpenApiSchemas,
  security: OpenApiSecurity,
) => {
  const sec = [{ [security.bearerAuthScheme.name]: [] }];
  const json = (schema: z.ZodTypeAny) => ({ "application/json": { schema } });
  const errorResponse = (description: string) => ({ description, content: json(schemas.ErrorResponseSchema) });

  registry.registerPath({
    method: "put",
    path: "/api/v1/history/chat/{conversationId}/attributes/{name}",
    tags: TAGS,
    summary: "Set a conversation's attribute",
    description: [
      "Sets a Choice attribute's value for this conversation to one of its active options, with the signed-in teammate as its writer (`writtenBy.kind` `operator`).",
      "The AI never replaces a teammate's value. A value the visitor's session, verified customer or WhatsApp number holds stays as it is, and this conversation reads the one set here.",
      "Setting the option the AI, an API token or a routine already set keeps it as the teammate's value, which the AI then no longer changes; the value itself is unchanged, so it records no `context_value.changed`.",
      "Setting the option a teammate already set changes nothing and records nothing, so a retried request is safe.",
      "A change of value records `context_value.changed`; each write records a `conversation_attribute.set` audit event that names the attribute's id and the conversation, never the value.",
      refusals,
      "An option that is archived or not the attribute's is refused with `400`, naming the active option keys.",
      "Dashboard sessions only. Requires workspace.conversation.takeover.",
    ].join(" "),
    operationId: "setHistoryConversationAttribute",
    security: sec,
    request: {
      params: conversationAttributeParamsSchema,
      body: { content: json(conversationAttributeValueBodySchema) },
    },
    responses: {
      200: { description: "The attribute as the conversation reads it now", content: json(schemas.ConversationAttributeChangeSchema) },
      400: errorResponse("Request validation failed, an option the attribute doesn't offer, or an attribute a teammate doesn't edit"),
      401: errorResponse("A signed-in teammate is required"),
      403: errorResponse("Caller lacks workspace.conversation.takeover"),
      404: errorResponse("No such conversation, or no attribute by that name"),
    },
  });

  registry.registerPath({
    method: "delete",
    path: "/api/v1/history/chat/{conversationId}/attributes/{name}",
    tags: TAGS,
    summary: "Reset a conversation's attribute",
    description: [
      "Deletes the value this conversation holds for an attribute of any type that is not Private, whoever wrote it: a teammate's, the AI's, an API token's or a routine's. When the conversation's agent classifies the attribute, the AI is asked to fill it again now (`classificationQueued`), so a finished conversation gets a value back too.",
      "The conversation then reads what the visitor's session, verified customer or WhatsApp number holds, if anything.",
      "A conversation with no value of its own changes nothing and answers `200` the same way.",
      "A change records `context_value.changed` with `value: null` and a `conversation_attribute.reset` audit event with no value.",
      refusals,
      "Dashboard sessions only. Requires workspace.conversation.takeover.",
    ].join(" "),
    operationId: "resetHistoryConversationAttribute",
    security: sec,
    request: { params: conversationAttributeParamsSchema },
    responses: {
      200: { description: "The attribute as the conversation reads it now", content: json(schemas.ConversationAttributeChangeSchema) },
      400: errorResponse("Request validation failed, or a Private attribute"),
      401: errorResponse("A signed-in teammate is required"),
      403: errorResponse("Caller lacks workspace.conversation.takeover"),
      404: errorResponse("No such conversation, or no attribute by that name"),
    },
  });
};
