import { z } from "zod";
import type { OpenAPIRegistry } from "@asteasolutions/zod-to-openapi";

import { DATA_SUBJECT_MAX_CONVERSATIONS } from "../../../../modules/privacy/public.js";

import {
  dataSubjectIdentitiesRequestSchema,
  dataSubjectIdentitySchema,
  dataSubjectLookupRequestSchema,
} from "../../routes/privacyRoutes.js";
import type { OpenApiSchemas, OpenApiSecurity } from "../openApiRegistry.js";

const TAGS = ["Privacy"];

const registerPrivacySchemas = (registry: OpenAPIRegistry) => {
  const DataSubjectIdentitySchema = registry.register("DataSubjectIdentity", dataSubjectIdentitySchema.openapi({
    description: "One identity a data subject is known by on one channel. `web_visitor`: a visitor record, keyed by its id. `email_address`: an email sender, keyed by the lowercased address. `slack_user`: a Slack member, keyed by the Slack workspace id and the member id.",
  }));
  const DataSubjectIdentityCandidateSchema = registry.register("DataSubjectIdentityCandidate", z.object({
    identity: DataSubjectIdentitySchema,
    channel: z.string().openapi({ description: "The conversation channel the identity is on: `web`, `email` or `slack`." }),
    label: z.string().openapi({ description: "How the channel knows the person: a verified customer id, an address, or a Slack member id." }),
    conversationCount: z.number().int().min(0),
    firstSeenAt: z.string().datetime().nullable(),
    lastSeenAt: z.string().datetime().nullable(),
  }));
  const DataSubjectConversationSchema = registry.register("DataSubjectConversation", z.object({
    id: z.string().uuid(),
    channel: z.string().nullable(),
    title: z.string().nullable(),
    startedAt: z.string().datetime(),
    lastActivityAt: z.string().datetime(),
    messageCount: z.number().int().min(0),
  }));
  const DataSubjectExportSchema = registry.register("DataSubjectExport", z.object({
    format: z.literal("radioso.data_subject_export"),
    formatVersion: z.literal(1).openapi({ description: "The format's version. A change to the document's shape is a new version." }),
    exportedAt: z.string().datetime(),
    workspaceId: z.string().uuid(),
    identities: z.array(DataSubjectIdentitySchema),
    sections: z.record(z.string(), z.array(z.record(z.string(), z.unknown()))).openapi({
      description: "Every section, keyed by name, each a list of records: `conversations` (each with its `messages`), `visitors`, `routine_values`, `routine_actions`, `conversation_summaries`, `context_values`, `email_messages`, `answer_feedback`. A section with nothing for the subject is an empty list.",
    }),
  }));
  const DataSubjectErasureSchema = registry.register("DataSubjectErasure", z.object({
    visitorCount: z.number().int().min(0),
    conversationCount: z.number().int().min(0),
    messageCount: z.number().int().min(0),
    complete: z.boolean().openapi({ description: "False only in the `details.receipt` of a `500`: the erasure stopped partway." }),
  }));
  return {
    DataSubjectLookupRequestSchema: registry.register("DataSubjectLookupRequest", dataSubjectLookupRequestSchema),
    DataSubjectIdentitiesRequestSchema: registry.register("DataSubjectIdentitiesRequest", dataSubjectIdentitiesRequestSchema),
    DataSubjectLookupResponseSchema: z.object({ identities: z.array(DataSubjectIdentityCandidateSchema) }),
    DataSubjectConversationsResponseSchema: z.object({ conversations: z.array(DataSubjectConversationSchema) }),
    DataSubjectExportSchema,
    DataSubjectErasureSchema,
  };
};

/**
 * A data subject request (GDPR Articles 15, 17 and 20): find a person by a verified customer id,
 * an email address or a Slack member id, then list, export or erase what the identities an operator
 * confirmed reach. Every operation is a POST so identifiers stay out of URLs, and every one needs
 * `workspace.history.delete`.
 */
export const registerPrivacyPaths = (
  registry: OpenAPIRegistry,
  schemas: OpenApiSchemas,
  security: OpenApiSecurity,
) => {
  const privacy = registerPrivacySchemas(registry);
  const sec = [{ [security.bearerAuthScheme.name]: [] }];
  const json = (schema: z.ZodTypeAny) => ({ "application/json": { schema } });
  const errorResponse = (description: string) => ({ description, content: json(schemas.ErrorResponseSchema) });
  const common = {
    400: errorResponse("Request validation failed"),
    401: errorResponse("Authentication required"),
    403: errorResponse("Caller lacks workspace.history.delete"),
  };
  const identitiesBody = { body: { content: json(privacy.DataSubjectIdentitiesRequestSchema), required: true } };
  const tooLarge = errorResponse(
    `\`data_subject_request_too_large\`: the identities reach more than ${DATA_SUBJECT_MAX_CONVERSATIONS} conversations. \`details\` carries \`conversationCount\` and \`maxConversations\`; split the request by identity.`,
  );

  registry.registerPath({
    method: "post",
    path: "/api/v1/privacy/data-subjects/lookup",
    tags: TAGS,
    summary: "Find a data subject's identities",
    description: "Returns every identity whose verified customer id, email address or Slack member id is exactly the query, each with its channel and conversation count. Identities are never merged: the caller confirms which belong to the subject and passes those to the other operations. Records one `data_subject.looked_up` audit event with identity references and counts.",
    operationId: "lookupDataSubject",
    security: sec,
    request: { body: { content: json(privacy.DataSubjectLookupRequestSchema), required: true } },
    responses: {
      200: { description: "Candidate identities", content: json(privacy.DataSubjectLookupResponseSchema) },
      ...common,
    },
  });

  registry.registerPath({
    method: "post",
    path: "/api/v1/privacy/data-subjects/conversations",
    tags: TAGS,
    summary: "List the conversations of a data subject's identities",
    description: "The conversations the confirmed identities reach, latest activity first, each once.",
    operationId: "listDataSubjectConversations",
    security: sec,
    request: identitiesBody,
    responses: {
      200: { description: "The subject's conversations", content: json(privacy.DataSubjectConversationsResponseSchema) },
      ...common,
    },
  });

  registry.registerPath({
    method: "post",
    path: "/api/v1/privacy/data-subjects/export",
    tags: TAGS,
    summary: "Export a data subject's data",
    description: "One machine-readable JSON document holding everything the confirmed identities reach, read from one consistent snapshot. Records one `data_subject.exported` audit event with identity references and counts per section, never content.",
    operationId: "exportDataSubject",
    security: sec,
    request: identitiesBody,
    responses: {
      200: { description: "The export", content: json(privacy.DataSubjectExportSchema) },
      ...common,
      413: tooLarge,
    },
  });

  registry.registerPath({
    method: "post",
    path: "/api/v1/privacy/data-subjects/erase",
    tags: TAGS,
    summary: "Permanently erase a data subject's data",
    description: "Erases each web visitor among the confirmed identities as `DELETE /api/v1/history/visitors/{visitorId}` does, then every other conversation the identities reach as `DELETE /api/v1/history/chat/{conversationId}` does, each with its own audit event, and records one `data_subject.erased` audit event for the request with identity records and totals. One already erased is skipped. There is no undo.",
    operationId: "eraseDataSubject",
    security: sec,
    request: identitiesBody,
    responses: {
      200: { description: "What was erased", content: json(privacy.DataSubjectErasureSchema) },
      ...common,
      413: tooLarge,
      500: errorResponse("`data_subject_erasure_incomplete`: the erasure stopped partway. `details.receipt` is a `DataSubjectErasure` with what it erased and `complete: false`; send the same request again to erase the rest."),
    },
  });
};
