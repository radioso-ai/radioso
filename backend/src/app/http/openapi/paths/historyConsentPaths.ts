import { z } from "zod";
import type { OpenAPIRegistry } from "@asteasolutions/zod-to-openapi";

import { conversationConsentParamsSchema, conversationParamsSchema } from "../../routes/conversationRouteSchemas.js";
import type { OpenApiSchemas, OpenApiSecurity } from "../openApiRegistry.js";

const TAGS = ["History"];

const registerConsentSchemas = (registry: OpenAPIRegistry) => {
  const ConversationConsentSchema = registry.register("ConversationConsent", z.object({
    id: z.string().uuid(),
    routineId: z.string().openapi({ description: "The routine that asked the consent." }),
    consentKey: z.string().openapi({ description: "The consent's `key` within the routine." }),
    slotKeys: z.array(z.string()).openapi({ description: "The sensitive fields the consent covered when it was decided: the values a withdrawal erases." }),
    decision: z.enum(["granted", "declined"]),
    method: z.enum(["button", "reply"]).openapi({ description: "`button`: a click on one of the two choices. `reply`: an answer read from the visitor's message." }),
    defaulted: z.boolean().openapi({ description: "True for a decline recorded because the visitor's replies stayed unclear after the consent was asked twice." }),
    locale: z.string().openapi({ description: "The language of the wording the visitor was shown." }),
    channel: z.string().nullable().openapi({ description: "The conversation's channel, such as `website_embed` or `email`." }),
    wordingVersionId: z.string().openapi({ description: "The immutable version of the wording shown: a hash of exactly what the visitor saw." }),
    wording: z.object({
      body: z.string(),
      agreeLabel: z.string(),
      declineLabel: z.string(),
    }).openapi({ description: "The wording exactly as the visitor was shown it." }),
    decidedAt: z.string().datetime(),
    withdrawnAt: z.string().datetime().nullable().openapi({ description: "When an operator withdrew the consent; null while it stands." }),
  }).openapi({
    description: "One consent decision a visitor gave in a conversation (#1544): the proof, with no reply text and no field values. A record outlives its conversation.",
  }));
  const ConsentNotWithdrawableErrorSchema = registry.register("ConsentNotWithdrawableError", z.object({
    error: z.object({
      code: z.literal("consent_not_withdrawable"),
      message: z.string(),
      details: z.object({
        reason: z.enum(["declined", "already_withdrawn"]).openapi({
          description: "`declined`: the visitor never granted it, so nothing was collected under it. `already_withdrawn`: it was withdrawn before.",
        }),
        consent: ConversationConsentSchema,
      }),
    }),
  }));
  return {
    ConversationConsentSchema,
    ConsentNotWithdrawableErrorSchema,
    ConversationConsentListSchema: registry.register("ConversationConsentList", z.object({ consents: z.array(ConversationConsentSchema) })),
    ConversationConsentWithdrawalSchema: registry.register("ConversationConsentWithdrawal", z.object({ consent: ConversationConsentSchema })),
  };
};

/**
 * A conversation's routine consent records, and the withdrawal of a granted one on the visitor's
 * request (Article 7(3)).
 */
export const registerHistoryConsentPaths = (
  registry: OpenAPIRegistry,
  schemas: OpenApiSchemas,
  security: OpenApiSecurity,
) => {
  const consents = registerConsentSchemas(registry);
  const sec = [{ [security.bearerAuthScheme.name]: [] }];
  const json = (schema: z.ZodTypeAny) => ({ "application/json": { schema } });
  const errorResponse = (description: string) => ({ description, content: json(schemas.ErrorResponseSchema) });

  registry.registerPath({
    method: "get",
    path: "/api/v1/history/chat/{conversationId}/consents",
    tags: TAGS,
    summary: "List a conversation's consent records",
    description: "Every consent decision a visitor gave in the conversation, oldest first, each with the exact wording they were shown. Records outlive their conversation, so a conversation that was erased still lists its records; one with no routine consent lists none. Requires workspace.history.read.",
    operationId: "listHistoryConversationConsents",
    security: sec,
    request: { params: conversationParamsSchema },
    responses: {
      200: { description: "The conversation's consent records", content: json(consents.ConversationConsentListSchema) },
      400: errorResponse("Request validation failed"),
      401: errorResponse("Authentication required"),
      403: errorResponse("Caller lacks workspace.history.read"),
    },
  });

  registry.registerPath({
    method: "post",
    path: "/api/v1/history/chat/{conversationId}/consents/{recordId}/withdraw",
    tags: TAGS,
    summary: "Withdraw a visitor's consent",
    description: "Withdraws a granted consent on the visitor's request, in one transaction. The values of the fields it covered are erased from the conversation's routine state, a finished run's included. Each message that carried one keeps `[redacted]` as its text and is marked `withheld`, and so are the copies Radioso keeps of it: the inbound email's body and raw copy, the turn's content audit, its coverage text and any photo it carried. The record keeps its proof and gains `withdrawnAt` and the acting member. A routine still running in the conversation goes on without those fields and doesn't ask the consent again. Text already delivered to Slack or WhatsApp stays with those providers. Records one `routine_consent.withdrawn` audit event with ids only. Requires workspace.history.delete.",
    operationId: "withdrawHistoryConversationConsent",
    security: sec,
    request: { params: conversationConsentParamsSchema },
    responses: {
      200: { description: "The consent, withdrawn", content: json(consents.ConversationConsentWithdrawalSchema) },
      400: errorResponse("Request validation failed"),
      401: errorResponse("Authentication required"),
      403: errorResponse("Caller lacks workspace.history.delete"),
      404: errorResponse("The conversation has no such consent record"),
      409: {
        description: "`consent_not_withdrawable`: the consent was declined or is already withdrawn, so nothing changed. `details.reason` says which, and `details.consent` is the record as it stands.",
        content: json(consents.ConsentNotWithdrawableErrorSchema),
      },
    },
  });
};
