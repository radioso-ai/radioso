import { z } from "zod";
import { assistantChatSchema } from "../../schemas/assistantChatSchemas.js";
import { conversationParamsSchema } from "../../routes/conversationRouteSchemas.js";
import {
  skillAvailabilitySchema,
  skillCatalogEntrySchema,
  skillCatalogResponseSchema,
  skillContractReferenceSchema,
  skillDiagnosticEvidenceSchema,
  skillDiagnosticSchema,
  skillDiagnosticsSummarySchema,
  skillParamsSchema,
} from "../../../../modules/skills/public.js";
import {
  anonymousChatSchema,
  publicConversationParamsSchema,
} from "../../routes/publicChatRouteSchemas.js";
import type { OpenAPIRegistry } from "@asteasolutions/zod-to-openapi";
import type { OpenApiSchemaCatalog } from "../openApiRegistry.js";

export const registerAssistantHistorySchemas = (registry: OpenAPIRegistry, schemas: OpenApiSchemaCatalog) => {
  const answerFeedbackParamsSchema = z.object({
    assistantMessageId: z.string().uuid(),
  }).openapi("AnswerFeedbackParams");
  const SkillAvailabilitySchema = registry.register("SkillAvailability", skillAvailabilitySchema);
  const SkillContractReferenceSchema = registry.register("SkillContractReference", skillContractReferenceSchema);
  const SkillDiagnosticsSummarySchema = registry.register("SkillDiagnosticsSummary", skillDiagnosticsSummarySchema);
  const SkillDiagnosticEvidenceSchema = registry.register("SkillDiagnosticEvidence", skillDiagnosticEvidenceSchema);
  const SkillDiagnosticDefinitionSchema = registry.register("SkillDiagnosticDefinition", skillDiagnosticSchema);
  const SkillCatalogEntrySchema = registry.register("SkillCatalogEntry", skillCatalogEntrySchema.extend({
    availability: SkillAvailabilitySchema,
    contractReferences: z.array(SkillContractReferenceSchema),
    diagnostics: SkillDiagnosticsSummarySchema,
  }));
  const SkillCatalogResponseSchema = registry.register("SkillCatalogResponse", skillCatalogResponseSchema.extend({
    skills: z.array(SkillCatalogEntrySchema),
  }));
  const SkillParamsSchema = registry.register("SkillParams", skillParamsSchema);
  void SkillDiagnosticEvidenceSchema;
  void SkillDiagnosticDefinitionSchema;

  const ChatSuggestionActionSchema = registry.register(
    "ChatSuggestionAction",
    z.discriminatedUnion("kind", [
      z.object({ kind: z.literal("ask_followup") }),
      z.object({
        kind: z.literal("start_intent"),
        intent: z.object({
          skillName: z.string(),
          intentName: z.string().optional(),
        }),
      }),
    ]).openapi({
      description:
        "Behavior triggered when the user activates the suggestion chip. Absent means ask_followup (default: submit the chip text as a new user turn).",
    }),
  );

  const ChatSuggestionSchema = registry.register(
    "ChatSuggestion",
    z.object({
      text: z.string(),
      kind: z.string(),
      citation: schemas.CitationSchema.optional(),
      action: ChatSuggestionActionSchema.optional(),
    }),
  );

  const AssistantRouteSchema = registry.register(
    "AssistantRoute",
    z.object({
      type: z.enum(["direct", "retrieval"]),
      reason: z.enum(["assistant_identity", "conversation_start", "evidence_required", "social_only"]).openapi({
        description: "Execution routing reason chosen by the assistant surface after intent and policy checks.",
      }),
    }),
  );

  const AssistantRouteDiagnosticsSchema = registry.register(
    "AssistantRouteDiagnostics",
    z.object({
      generator: z.literal("assistant").openapi({
        description: "The human-facing assistant surface that produced this response.",
      }),
      routeType: z.enum(["direct", "retrieval"]),
      routeReason: z.enum(["assistant_identity", "conversation_start", "evidence_required", "social_only"]).openapi({
        description: "Route reason echoed into diagnostics for replay and history views.",
      }),
      retrievalInvoked: z.boolean(),
    }),
  );

  const chatResponseCoreShape = {
    agentId: z.string().uuid().optional(),
    agentName: z.string().optional(),
    answer: z.string(),
    citations: z.array(schemas.CitationSchema).optional(),
    answerSegments: z.array(schemas.AnswerSegmentSchema).optional(),
    suggestions: z.array(ChatSuggestionSchema).optional(),
  };

  const AssistantChatDebugSchema = registry.register(
    "AssistantChatDebug",
    z.object({
      route: AssistantRouteSchema,
      activitySummary: schemas.ActivitySummarySchema,
      activityTrace: schemas.ActivityTraceSchema,
    }),
  );

  const ChatResponseSchema = registry.register(
    "ChatResponse",
    z.object({
      conversationId: z.string().uuid(),
      assistantMessageId: z.string().uuid(),
      ...chatResponseCoreShape,
      debug: AssistantChatDebugSchema.optional(),
    }),
  );

  const ChatBootstrapResponseSchema = registry.register(
    "ChatBootstrapResponse",
    z.object({
      conversationId: z.string().uuid().optional(),
      ...chatResponseCoreShape,
      debug: AssistantChatDebugSchema.optional(),
    }).openapi({
      description: "Ephemeral bootstrap greeting response. Conversation id is omitted until the first persisted user turn.",
    }),
  );

  const AssistantChatResponseSchema = registry.register(
    "AssistantChatResponse",
    z.union([ChatResponseSchema, ChatBootstrapResponseSchema]),
  );

  const AssistantChatRequestSchema = registry.register(
    "AssistantChatRequest",
    assistantChatSchema.openapi({
      description: "`message` is required unless `startConversation` is true; bootstrap requests cannot include `conversationId`.",
    }),
  );
  const PublicChatRequestSchema = registry.register(
    "PublicChatRequest",
    anonymousChatSchema.openapi({
      description: "`message` is required unless `startConversation` is true; bootstrap requests cannot include `conversationId`.",
    }),
  );

  const ChatConversationSummarySchema = registry.register(
    "ChatConversationSummary",
    z.object({
      id: z.string().uuid(),
      agentId: z.string().uuid().nullable(),
      agentName: z.string().nullable(),
      sourceChannel: z.string().nullable(),
      sourceOrigin: z.string().nullable(),
      anonymousSessionId: z.string().nullable(),
      createdAt: z.string().datetime(),
      updatedAt: z.string().datetime(),
      messageCount: z.number().int().min(0),
      userMessageCount: z.number().int().min(0),
      assistantMessageCount: z.number().int().min(0),
      preview: z.string().nullable(),
    }),
  );

  const ChatHistoryListResponseSchema = registry.register(
    "ChatHistoryListResponse",
    z.object({
      workspaceName: z.string().optional(),
      assistantBootstrapActive: z.boolean().optional(),
      conversations: z.array(ChatConversationSummarySchema),
      assistantAvatarUrl: z.string().nullable().optional(),
      theme: z.object({
        brand: z.string(),
        brandText: z.string(),
        surface: z.string(),
        text: z.string(),
      }).optional(),
      branding: z.object({
        hidePoweredBy: z.boolean(),
        privacyPolicyUrl: z.string().nullable(),
      }).optional(),
      intakeActions: z.array(z.object({
        skillName: z.string(),
        intentName: z.string(),
      })).optional(),
      total: z.number().int().min(0),
      nextCursor: z.string().nullable(),
      hasMore: z.boolean(),
    }),
  );

  const HistoryItemSchema = registry.register(
    "HistoryItem",
    z.discriminatedUnion("kind", [
      z.object({
        kind: z.literal("chat"),
        id: z.string().uuid(),
        sortAt: z.string().datetime(),
        conversation: ChatConversationSummarySchema,
      }),
      z.object({
        kind: z.literal("search"),
        id: z.string().uuid(),
        sortAt: z.string().datetime(),
        search: schemas.DocumentSearchHistoryEntrySchema,
      }),
    ]),
  );

  const HistoryItemsResponseSchema = registry.register(
    "HistoryItemsResponse",
    z.object({
      items: z.array(HistoryItemSchema),
      total: z.number().int().min(0),
      nextCursor: z.null(),
      hasMore: z.boolean(),
    }),
  );

  const ChatConversationMessageDebugSchema = registry.register(
    "ChatConversationMessageDebug",
    z.object({
      eventStatus: z.enum(["success", "failure"]),
      recordedAt: z.string().datetime(),
      stream: z.boolean(),
      citationCount: z.number().int().min(0),
      answerOutcome: z.enum(["grounded_success", "no_context_refusal", "non_retrieval_response"]).optional(),
      route: AssistantRouteDiagnosticsSchema.optional(),
      activitySummary: schemas.ActivitySummarySchema.optional(),
      activityTrace: schemas.ActivityTraceSchema.optional(),
      errorMessage: z.string().nullable().optional(),
    }),
  );

  const AnswerFeedbackEntrySchema = registry.register(
    "AnswerFeedbackEntry",
    z.object({
      id: z.string().uuid(),
      value: z.enum(["up", "down"]),
      comment: z.string().nullable(),
      actorType: z.enum(["authenticated_user", "api_token", "anonymous_user"]),
      actorId: z.string(),
      accountId: z.string().uuid().nullable(),
      userId: z.string().uuid().nullable(),
      anonymousSessionId: z.string().nullable(),
      createdAt: z.string().datetime(),
      updatedAt: z.string().datetime(),
    }),
  );

  const AnswerFeedbackRequestSchema = registry.register(
    "AnswerFeedbackRequest",
    z.object({
      value: z.enum(["up", "down"]),
      comment: z.string().max(2000).nullable().optional(),
    }),
  );

  const AnswerFeedbackResponseSchema = registry.register(
    "AnswerFeedbackResponse",
    AnswerFeedbackEntrySchema,
  );

  const ClearAnswerFeedbackResponseSchema = registry.register(
    "ClearAnswerFeedbackResponse",
    z.object({
      cleared: z.boolean(),
    }),
  );

  const ChatConversationMessageSchema = registry.register(
    "ChatConversationMessage",
    z.object({
      id: z.string().uuid(),
      role: z.enum(["user", "assistant", "system"]),
      content: z.string(),
      createdAt: z.string().datetime(),
      inputMetadata: z.object({
        method: z.enum(["typed", "suggestion_click", "intent_click"]),
        suggestionSourceMessageId: z.string().uuid().optional(),
        intent: z.object({
          skillName: z.string(),
          intentName: z.string().optional(),
        }).optional(),
      }).optional(),
      citations: z.array(schemas.CitationSchema).optional(),
      answerSegments: z.array(schemas.AnswerSegmentSchema).optional(),
      suggestions: z.array(ChatSuggestionSchema).optional(),
      answerFeedbackEntries: z.array(AnswerFeedbackEntrySchema).optional(),
      debug: ChatConversationMessageDebugSchema.optional(),
    }),
  );

  const ChatConversationDetailSchema = registry.register(
    "ChatConversationDetail",
    z.object({
      conversationId: z.string().uuid(),
      workspaceId: z.string().uuid(),
      agentId: z.string().uuid().nullable(),
      sourceChannel: z.string().nullable(),
      sourceOrigin: z.string().nullable(),
      createdAt: z.string().datetime(),
      updatedAt: z.string().datetime(),
      messageCount: z.number().int().min(0),
      userMessageCount: z.number().int().min(0),
      assistantMessageCount: z.number().int().min(0),
      messagesTotal: z.number().int().min(0),
      messageWindowOffset: z.number().int().min(0),
      messageWindowLimit: z.number().int().min(1),
      hasOlderMessages: z.boolean(),
      nextCursor: z.string().nullable(),
      messages: z.array(ChatConversationMessageSchema),
    }),
  );

  const PublicConversationSummarySchema = registry.register(
    "PublicConversationSummary",
    z.object({
      id: z.string().uuid(),
      sourceChannel: z.string().nullable(),
      preview: z.string().nullable(),
      messageCount: z.number().int().min(0),
      createdAt: z.string().datetime(),
      updatedAt: z.string().datetime(),
    }),
  );

  const PublicConversationListResponseSchema = registry.register(
    "PublicConversationListResponse",
    z.object({
      workspaceName: z.string(),
      assistantBootstrapActive: z.boolean(),
      conversations: z.array(PublicConversationSummarySchema),
      total: z.number().int().min(0),
      nextCursor: z.string().nullable(),
      hasMore: z.boolean(),
    }),
  );

  const RateLimitExceededSchema = registry.register(
    "RateLimitExceededResponse",
    z.object({
      code: z.literal("rate_limit_exceeded"),
      message: z.string(),
      retryAfterSeconds: z.number().int().min(1),
    }),
  );

  Object.assign(schemas, {
    answerFeedbackParamsSchema,
    conversationParamsSchema,
    publicConversationParamsSchema,
    SkillAvailabilitySchema,
    SkillContractReferenceSchema,
    SkillDiagnosticsSummarySchema,
    SkillDiagnosticEvidenceSchema,
    SkillDiagnosticDefinitionSchema,
    SkillCatalogEntrySchema,
    SkillCatalogResponseSchema,
    SkillParamsSchema,
    ChatSuggestionActionSchema,
    ChatSuggestionSchema,
    AssistantRouteSchema,
    AssistantRouteDiagnosticsSchema,
    AssistantChatDebugSchema,
    ChatResponseSchema,
    ChatBootstrapResponseSchema,
    AssistantChatResponseSchema,
    AssistantChatRequestSchema,
    PublicChatRequestSchema,
    ChatConversationSummarySchema,
    ChatHistoryListResponseSchema,
    HistoryItemSchema,
    HistoryItemsResponseSchema,
    ChatConversationMessageDebugSchema,
    AnswerFeedbackEntrySchema,
    AnswerFeedbackRequestSchema,
    AnswerFeedbackResponseSchema,
    ClearAnswerFeedbackResponseSchema,
    ChatConversationMessageSchema,
    ChatConversationDetailSchema,
    PublicConversationSummarySchema,
    PublicConversationListResponseSchema,
    RateLimitExceededSchema,
  });
};
