import { z } from "zod";
import type { OpenAPIRegistry } from "@asteasolutions/zod-to-openapi";

import type { OpenApiSchemas, OpenApiSecurity } from "../openApiRegistry.js";
import { agentSurfacePositions } from "../../../../modules/agents/public.js";

const assistantChatSseSchema = (name: string) => z.string().openapi(name, {
  description: [
    "A server-sent event stream. Status payloads use the named ChatStatusEvent schema.",
    "Successful order: status(interpreting), conversation (when available), status(searching) for retrieval, status(composing), one or more chunk events, done, then optional suggestions.",
    "A cancelled event is terminal and no event follows it.",
  ].join(" "),
  example: [
    "event: status",
    'data: {"stage":"interpreting"}',
    "",
    "event: chunk",
    'data: {"text":"Hello"}',
    "",
  ].join("\n"),
});

export const registerAssistantSessionPaths = (
  registry: OpenAPIRegistry,
  schemas: OpenApiSchemas,
  _security: OpenApiSecurity,
) => {
  registry.registerPath({
    method: "post",
    path: "/api/v1/public/chat/{token}/sessions",
    tags: ["Assistant"],
    summary: "Create a public chat session from a launch token",
    operationId: "createPublicChatSession",
    request: {
      params: schemas.tokenPathParamsSchema,
      body: {
        content: {
          "application/json": {
            schema: schemas.PublicChatSessionRequestSchema,
          },
        },
      },
    },
    responses: {
      200: {
        description: "Public chat session returned",
        content: {
          "application/json": {
            schema: schemas.PublicChatSessionResponseSchema,
          },
        },
      },
      400: {
        description: "Request validation failed",
        content: {
          "application/json": {
            schema: schemas.ErrorResponseSchema,
          },
        },
      },
      403: {
        description: "Origin not allowed for this public chat channel",
        content: {
          "application/json": {
            schema: schemas.ErrorResponseSchema,
          },
        },
      },
      404: {
        description: "Public chat not found",
        content: {
          "application/json": {
            schema: schemas.ErrorResponseSchema,
          },
        },
      },
      429: {
        description: "Public chat session exchange rate limit exceeded",
        content: {
          "application/json": {
            schema: schemas.RateLimitExceededSchema,
          },
        },
      },
    },
  });
};

export const registerAssistantAuthenticatedChatPaths = (
  registry: OpenAPIRegistry,
  schemas: OpenApiSchemas,
  security: OpenApiSecurity,
) => {
  registry.registerPath({
    method: "post",
    path: "/api/v1/assistant/chat",
    tags: ["Assistant"],
    summary: "Run human-facing assistant chat",
    operationId: "createAssistantChatResponse",
    security: [{ [security.bearerAuthScheme.name]: [] }],
    request: {
      body: {
        required: true,
        content: {
          "application/json": {
            schema: schemas.AssistantChatRequestSchema,
          },
        },
      },
    },
    responses: {
      200: {
        description: "Chat response returned as JSON or SSE",
        content: {
          "application/json": {
            schema: schemas.AssistantChatResponseSchema,
          },
          "text/event-stream": {
            schema: assistantChatSseSchema("AssistantChatSseStream"),
          },
        },
      },
      204: {
        description: "Bootstrap request completed without creating a greeting",
      },
      400: {
        description: "Request validation failed",
        content: {
          "application/json": {
            schema: schemas.ErrorResponseSchema,
          },
        },
      },
      401: {
        description: "Authentication required",
        content: {
          "application/json": {
            schema: schemas.ErrorResponseSchema,
          },
        },
      },
      404: {
        description: "Conversation not found",
        content: {
          "application/json": {
            schema: schemas.ErrorResponseSchema,
          },
        },
      },
      409: {
        description: "Turn superseded by a newer message in the same conversation",
        content: {
          "application/json": {
            schema: schemas.ErrorResponseSchema,
          },
        },
      },
      429: {
        description: "Expensive authenticated request rate limit exceeded",
        content: {
          "application/json": {
            schema: schemas.RateLimitExceededSchema,
          },
        },
      },
    },
  });
};

export const registerAssistantFeedbackPaths = (
  registry: OpenAPIRegistry,
  schemas: OpenApiSchemas,
  security: OpenApiSecurity,
) => {
  registry.registerPath({
    method: "put",
    path: "/api/v1/answer-feedback/messages/{assistantMessageId}",
    tags: ["Assistant"],
    summary: "Record feedback for an assistant answer",
    operationId: "upsertAnswerFeedback",
    security: [{ [security.bearerAuthScheme.name]: [] }],
    request: {
      params: schemas.answerFeedbackParamsSchema,
      body: {
        required: true,
        content: {
          "application/json": {
            schema: schemas.AnswerFeedbackRequestSchema,
          },
        },
      },
    },
    responses: {
      200: {
        description: "Feedback saved",
        content: {
          "application/json": {
            schema: schemas.AnswerFeedbackResponseSchema,
          },
        },
      },
      400: {
        description: "Request validation failed",
        content: {
          "application/json": {
            schema: schemas.ErrorResponseSchema,
          },
        },
      },
      401: {
        description: "Authentication required",
        content: {
          "application/json": {
            schema: schemas.ErrorResponseSchema,
          },
        },
      },
      404: {
        description: "Assistant message not found",
        content: {
          "application/json": {
            schema: schemas.ErrorResponseSchema,
          },
        },
      },
    },
  });

  registry.registerPath({
    method: "delete",
    path: "/api/v1/answer-feedback/messages/{assistantMessageId}",
    tags: ["Assistant"],
    summary: "Clear feedback for an assistant answer",
    operationId: "clearAnswerFeedback",
    security: [{ [security.bearerAuthScheme.name]: [] }],
    request: {
      params: schemas.answerFeedbackParamsSchema,
    },
    responses: {
      200: {
        description: "Feedback cleared if present",
        content: {
          "application/json": {
            schema: schemas.ClearAnswerFeedbackResponseSchema,
          },
        },
      },
      401: {
        description: "Authentication required",
        content: {
          "application/json": {
            schema: schemas.ErrorResponseSchema,
          },
        },
      },
      404: {
        description: "Assistant message not found",
        content: {
          "application/json": {
            schema: schemas.ErrorResponseSchema,
          },
        },
      },
    },
  });

  registry.registerPath({
    method: "put",
    path: "/api/v1/answer-feedback/public/chat/{token}/messages/{assistantMessageId}",
    tags: ["Assistant"],
    summary: "Record feedback for a public chat assistant answer",
    operationId: "upsertPublicAnswerFeedback",
    security: [{ [security.anonymousSessionCookieScheme.name]: [] }],
    request: {
      params: z.object({
        token: z.string().min(1),
        assistantMessageId: z.string().uuid(),
      }),
      body: {
        required: true,
        content: {
          "application/json": {
            schema: schemas.AnswerFeedbackRequestSchema,
          },
        },
      },
    },
    responses: {
      200: {
        description: "Feedback saved",
        content: {
          "application/json": {
            schema: schemas.AnswerFeedbackResponseSchema,
          },
        },
      },
      400: {
        description: "Request validation failed",
        content: {
          "application/json": {
            schema: schemas.ErrorResponseSchema,
          },
        },
      },
      404: {
        description: "Public chat session or assistant message not found",
        content: {
          "application/json": {
            schema: schemas.ErrorResponseSchema,
          },
        },
      },
    },
  });

  registry.registerPath({
    method: "delete",
    path: "/api/v1/answer-feedback/public/chat/{token}/messages/{assistantMessageId}",
    tags: ["Assistant"],
    summary: "Clear feedback for a public chat assistant answer",
    operationId: "clearPublicAnswerFeedback",
    security: [{ [security.anonymousSessionCookieScheme.name]: [] }],
    request: {
      params: z.object({
        token: z.string().min(1),
        assistantMessageId: z.string().uuid(),
      }),
    },
    responses: {
      200: {
        description: "Feedback cleared if present",
        content: {
          "application/json": {
            schema: schemas.ClearAnswerFeedbackResponseSchema,
          },
        },
      },
      404: {
        description: "Public chat session or assistant message not found",
        content: {
          "application/json": {
            schema: schemas.ErrorResponseSchema,
          },
        },
      },
    },
  });
};

export const registerAssistantPublicChatPaths = (
  registry: OpenAPIRegistry,
  schemas: OpenApiSchemas,
  security: OpenApiSecurity,
) => {
  registry.registerPath({
    method: "post",
    path: "/api/v1/public/chat/{token}",
    tags: ["Assistant"],
    summary: "Send a public chat message",
    operationId: "createPublicChatResponse",
    security: [{ [security.anonymousSessionCookieScheme.name]: [] }],
    request: {
      params: schemas.tokenPathParamsSchema,
      body: {
        required: true,
        content: {
          "application/json": {
            schema: schemas.PublicChatRequestSchema,
          },
        },
      },
    },
    responses: {
      200: {
        description: "Public chat response returned as JSON or SSE",
        content: {
          "application/json": {
            schema: schemas.AssistantChatResponseSchema,
          },
          "text/event-stream": {
            schema: assistantChatSseSchema("PublicChatSseStream"),
          },
        },
      },
      400: {
        description: "Request validation failed",
        content: {
          "application/json": {
            schema: schemas.ErrorResponseSchema,
          },
        },
      },
      404: {
        description: "Public chat link not found",
        content: {
          "application/json": {
            schema: schemas.ErrorResponseSchema,
          },
        },
      },
      409: {
        description: "Turn superseded by a newer message in the same conversation",
        content: {
          "application/json": {
            schema: schemas.ErrorResponseSchema,
          },
        },
      },
      429: {
        description: "Rate limit exceeded, or the account's conversation quota is exhausted. The usage-limit shape never carries `details` on this anonymous route, unlike the authenticated assistant and retrieval endpoints — the resource, limit, used count, and billing period are account information this caller has no reason to see.",
        content: {
          "application/json": {
            schema: z.union([schemas.RateLimitExceededSchema, schemas.ErrorResponseSchema]).openapi({
              description: "Either the rate-limit shape (`code: \"rate_limit_exceeded\"`) or the bare usage-limit shape (`code: \"usage_limit_exceeded\"`, no `details`).",
            }),
          },
        },
      },
      503: {
        description: "Public chat response is unavailable",
        content: {
          "application/json": {
            schema: schemas.ErrorResponseSchema,
          },
        },
      },
    },
  });

  registry.registerPath({
    method: "post",
    path: "/api/v1/public/chat/{token}/voice/sessions",
    tags: ["Assistant"],
    summary: "Start a voice session for the current public chat session",
    description: [
      "Opens a session on the vendor agent the agent's `voice.runtime` names, with the workspace's own API key for that vendor,",
      "and returns the vendor's signed URL with a fresh Radioso session key. The vendor key never leaves the backend.",
      "Only a website embed public session may start one: send it as `x-radioso-public-session`, from an origin the website embed admits, as for a chat message.",
      "A browser on another origin calls `/api/public/chat/{token}/voice/sessions` on the Radioso app host, which answers the CORS preflight and relays here.",
      "The signed URL is valid for 15 minutes and opens sessions for whoever holds it in that window, so it is a bearer credential: the response is `Cache-Control: no-store`.",
      "Starts spend their own budgets, per visitor session and per workspace, before the vendor is called.",
    ].join(" "),
    operationId: "createPublicVoiceSession",
    security: [{ [security.anonymousSessionCookieScheme.name]: [] }],
    request: {
      params: schemas.tokenPathParamsSchema,
      body: {
        content: {
          "application/json": {
            schema: schemas.PublicVoiceSessionRequestSchema,
          },
        },
      },
    },
    responses: {
      200: {
        description: "Voice session started",
        content: {
          "application/json": {
            schema: schemas.PublicVoiceSessionResponseSchema,
          },
        },
      },
      400: {
        description: "Request validation failed",
        content: {
          "application/json": {
            schema: schemas.ErrorResponseSchema,
          },
        },
      },
      404: {
        description: "Public session not found or not a website embed session, or the agent takes no voice sessions: voice is off or no vendor agent is bound",
        content: {
          "application/json": {
            schema: schemas.ErrorResponseSchema,
          },
        },
      },
      429: {
        description: "The visitor session's or the workspace's voice session start budget is spent",
        content: {
          "application/json": {
            schema: schemas.RateLimitExceededSchema,
          },
        },
      },
      503: {
        description: "`voice_unavailable`: the session could not be started (the workspace's vendor key is missing or unreadable, or the vendor did not start it)",
        content: {
          "application/json": {
            schema: schemas.ErrorResponseSchema,
          },
        },
      },
    },
  });

  registry.registerPath({
    method: "post",
    path: "/api/v1/public/chat/{token}/voice/sessions/{sessionKey}/vendor-conversation",
    tags: ["Assistant"],
    summary: "Report the vendor's id for a voice session the page opened",
    description: [
      "Once the vendor's client has connected a session from `createPublicVoiceSession`, the page reports the vendor's id for the call, which names the call's recording at the vendor.",
      "Radioso takes it once, from the same website embed public session the session was started for, while the session's start is unexpired.",
      "Before storing it, Radioso asks the vendor, with the workspace's own key, which vendor agent the conversation was held on, and stores it only when that is the vendor agent the session was started on; it only ever uses the id to look the recording up with that key.",
      "A browser on another origin calls `/api/public/chat/{token}/voice/sessions/{sessionKey}/vendor-conversation` on the Radioso app host, which answers the CORS preflight and relays here.",
    ].join(" "),
    operationId: "reportPublicVoiceVendorConversation",
    security: [{ [security.anonymousSessionCookieScheme.name]: [] }],
    request: {
      params: schemas.tokenPathParamsSchema.extend({ sessionKey: z.string().uuid() }),
      body: {
        content: {
          "application/json": {
            schema: schemas.PublicVoiceVendorConversationRequestSchema,
          },
        },
      },
    },
    responses: {
      204: { description: "The vendor's id is stored with the session" },
      400: {
        description: "Request validation failed: the session key is not a UUID, or the id is not 1 to 128 letters, digits, underscores and hyphens",
        content: { "application/json": { schema: schemas.ErrorResponseSchema } },
      },
      404: {
        description: "Public session not found or not a website embed session; no session this public session started waits for an id (it already has one, its start expired, or Radioso never started it); or the vendor says the conversation was held on another vendor agent",
        content: { "application/json": { schema: schemas.ErrorResponseSchema } },
      },
      429: {
        description: "The visitor session's request budget is spent",
        content: { "application/json": { schema: schemas.RateLimitExceededSchema } },
      },
      503: {
        description: "`voice_unavailable`: the id could not be checked with the vendor now (the vendor does not show the conversation yet, as can happen right after a call connects; the workspace's vendor key is missing or unreadable; or the vendor did not answer); report it again",
        content: { "application/json": { schema: schemas.ErrorResponseSchema } },
      },
    },
  });

  registry.registerPath({
    method: "get",
    path: "/api/v1/public/chat/{token}",
    tags: ["Assistant"],
    summary: "List conversations for the current anonymous session",
    operationId: "listPublicChatHistory",
    security: [{ [security.anonymousSessionCookieScheme.name]: [] }],
    request: {
      params: schemas.tokenPathParamsSchema,
      query: z.object({
        limit: z.number().int().min(1).max(100).optional(),
        offset: z.number().int().min(0).optional(),
        cursor: z.string().min(1).optional(),
      }),
    },
    responses: {
      200: {
        description: "Conversation summaries returned",
        content: {
          "application/json": {
            schema: schemas.PublicConversationListResponseSchema,
          },
        },
      },
      404: {
        description: "Public chat link not found",
        content: {
          "application/json": {
            schema: schemas.ErrorResponseSchema,
          },
        },
      },
    },
  });

  registry.registerPath({
    method: "get",
    path: "/api/v1/public/chat/{token}/history/{conversationId}",
    tags: ["Assistant"],
    summary: "Get a public conversation for the current anonymous session",
    operationId: "getPublicChatHistoryConversation",
    security: [{ [security.anonymousSessionCookieScheme.name]: [] }],
    request: {
      params: schemas.tokenPathParamsSchema.extend(schemas.publicConversationParamsSchema.shape),
      query: z.object({
        limit: z.number().int().min(1).max(100).optional(),
        offset: z.number().int().min(0).optional(),
        cursor: z.string().min(1).optional(),
      }),
    },
    responses: {
      200: {
        description: "Historical conversation detail",
        content: {
          "application/json": {
            schema: schemas.PublicChatConversationDetailSchema,
          },
        },
      },
      400: {
        description: "Request validation failed",
        content: {
          "application/json": {
            schema: schemas.ErrorResponseSchema,
          },
        },
      },
      404: {
        description: "Conversation not found",
        content: {
          "application/json": {
            schema: schemas.ErrorResponseSchema,
          },
        },
      },
    },
  });

  registry.registerPath({
    method: "get",
    path: "/api/v1/public/chat/{token}/tail/{conversationId}",
    tags: ["Assistant"],
    summary: "Poll new public conversation messages for the current anonymous session",
    operationId: "tailPublicChatHistoryConversation",
    security: [{ [security.anonymousSessionCookieScheme.name]: [] }],
    request: {
      params: schemas.tokenPathParamsSchema.extend(schemas.publicConversationParamsSchema.shape),
      query: z.object({
        limit: z.number().int().min(1).max(100).optional(),
        cursor: z.string().min(1).optional(),
      }),
    },
    responses: {
      200: {
        description: "New public conversation messages after the supplied tail cursor",
        content: {
          "application/json": {
            schema: schemas.PublicChatConversationTailSchema,
          },
        },
      },
      400: {
        description: "Request validation failed",
        content: {
          "application/json": {
            schema: schemas.ErrorResponseSchema,
          },
        },
      },
      404: {
        description: "Conversation not found",
        content: {
          "application/json": {
            schema: schemas.ErrorResponseSchema,
          },
        },
      },
    },
  });

  registry.registerPath({
    method: "get",
    path: "/api/v1/public/chat/{token}/events/{conversationId}",
    tags: ["Assistant"],
    summary: "Stream public conversation notifications for the current anonymous session",
    operationId: "streamPublicChatConversationEvents",
    security: [{ [security.anonymousSessionCookieScheme.name]: [] }],
    request: {
      params: schemas.tokenPathParamsSchema.extend(schemas.publicConversationParamsSchema.shape),
    },
    responses: {
      200: {
        description: "Server-sent public conversation notifications. Events include ready and message.created.",
        content: {
          "text/event-stream": {
            schema: z.string(),
          },
        },
      },
      400: {
        description: "Request validation failed",
        content: {
          "application/json": {
            schema: schemas.ErrorResponseSchema,
          },
        },
      },
      404: {
        description: "Conversation not found",
        content: {
          "application/json": {
            schema: schemas.ErrorResponseSchema,
          },
        },
      },
    },
  });

  registry.registerPath({
    method: "get",
    path: "/api/v1/public/chat/{token}/embed-config",
    tags: ["Assistant"],
    summary: "Read the website embed's bootstrap configuration",
    description: "Unauthenticated: the launch token alone selects the agent. 404 when the token is unknown or the website embed surface is disabled. Cacheable per allow-listed origin.",
    operationId: "getPublicChatEmbedConfig",
    request: {
      params: schemas.tokenPathParamsSchema,
    },
    responses: {
      200: {
        description: "Embed bootstrap configuration",
        content: {
          "application/json": {
            schema: z.object({
              launcherLabel: z.string(),
              launcherPosition: z.enum(agentSurfacePositions),
              assistantName: z.string(),
              theme: z.object({
                brand: z.string(),
                brandText: z.string(),
                surface: z.string(),
                text: z.string(),
              }),
              branding: z.object({
                hidePoweredBy: z.boolean(),
                privacyPolicyUrl: z.string().nullable(),
                privacyNotice: schemas.AgentPrivacyNoticesSchema,
              }),
              copy: z.record(z.string(), z.record(z.string(), z.string())),
              expertOverrides: z.record(z.string(), z.string()),
              assistantLogoUrl: z.string().nullable(),
              proactiveGreetingEnabled: z.boolean(),
              voice: z.object({
                available: z.boolean().openapi({
                  description: "Whether the embed shows a Talk button: the operator offers calls and the agent's voice is ready.",
                }),
              }),
              agentCardUrl: z.string().url().optional().openapi({
                description: "Present only when the agent publishes an A2A agent card.",
              }),
            }),
          },
        },
      },
      400: {
        description: "The requesting origin is not approved to host the embedded assistant",
        content: {
          "application/json": {
            schema: schemas.ErrorResponseSchema,
          },
        },
      },
      404: {
        description: "Launch token unknown, or the website embed surface is disabled",
        content: {
          "application/json": {
            schema: schemas.ErrorResponseSchema,
          },
        },
      },
    },
  });

  registry.registerPath({
    method: "get",
    path: "/api/v1/public/chat/{token}/assistant-logo",
    tags: ["Assistant"],
    summary: "Read the public widget's assistant logo image",
    description: "Unauthenticated: the launch token alone selects the agent. Sibling of the dashboard-only GET /api/v1/agents/{agentId}/assistant-logo, serving the same stored bytes.",
    operationId: "getPublicChatAssistantLogo",
    request: {
      params: schemas.tokenPathParamsSchema,
    },
    responses: {
      200: {
        description: "Logo image",
        content: {
          "image/png": { schema: { type: "string", format: "binary" } },
          "image/jpeg": { schema: { type: "string", format: "binary" } },
          "image/webp": { schema: { type: "string", format: "binary" } },
          "image/gif": { schema: { type: "string", format: "binary" } },
        },
      },
      404: {
        description: "Launch token unknown, or the agent has no logo",
        content: {
          "application/json": {
            schema: schemas.ErrorResponseSchema,
          },
        },
      },
    },
  });
};
