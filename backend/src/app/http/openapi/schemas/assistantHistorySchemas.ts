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
  skillDisplayMetadataSchema,
  skillOutcomeDefinitionSchema,
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
  const SkillDisplayMetadataSchema = registry.register("SkillDisplayMetadata", skillDisplayMetadataSchema);
  const SkillOutcomeDefinitionSchema = registry.register("SkillOutcomeDefinition", skillOutcomeDefinitionSchema);
  const SkillDiagnosticEvidenceSchema = registry.register("SkillDiagnosticEvidence", skillDiagnosticEvidenceSchema);
  const SkillDiagnosticDefinitionSchema = registry.register("SkillDiagnosticDefinition", skillDiagnosticSchema);
  const SkillCatalogEntrySchema = registry.register("SkillCatalogEntry", skillCatalogEntrySchema.extend({
    availability: SkillAvailabilitySchema,
    contractReferences: z.array(SkillContractReferenceSchema),
    diagnostics: SkillDiagnosticsSummarySchema,
    outcomes: z.array(SkillOutcomeDefinitionSchema).optional(),
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
          display: SkillDisplayMetadataSchema.optional(),
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

  const CapabilitySubTraceSchema = registry.register(
    "CapabilitySubTrace",
    z.object({
      namespace: z.string().openapi({
        description: "Capability that produced this sub-trace; the renderer keys on it (e.g. retrieval, skill-intake).",
      }),
      version: z.number(),
      payload: z.unknown().openapi({
        description: "Opaque capability-owned trace payload (e.g. an ActivityTrace). Shape varies by namespace/version.",
      }),
    }),
  );

  const ConversationTraceStageSchema = registry.register(
    "ConversationTraceStage",
    z.object({
      id: z.string(),
      kind: z.string(),
      status: z.enum(["applied", "skipped", "fallback", "rejected", "unavailable", "failed"]),
      startedAt: z.string().optional(),
      completedAt: z.string().optional(),
      inputs: z.record(z.unknown()).optional(),
      outputs: z.record(z.unknown()).optional(),
      metrics: z.record(z.number()).optional(),
      subTrace: CapabilitySubTraceSchema.optional(),
    }),
  );

  const ConversationTraceSchema = registry.register(
    "ConversationTrace",
    z.object({
      traceId: z.string(),
      startedAt: z.string(),
      completedAt: z.string().optional(),
      stages: z.array(ConversationTraceStageSchema),
      links: z.array(z.object({ from: z.string(), to: z.string(), kind: z.string() })).optional(),
      summary: z.record(z.unknown()).optional(),
    }),
  );

  const TurnTraceOpenTelemetryCorrelationSchema = registry.register(
    "TurnTraceOpenTelemetryCorrelation",
    z.object({
      traceId: z.string().openapi({
        description: "Active OpenTelemetry trace id for correlating this product diagnostic turn with exported traces.",
      }),
      spanId: z.string().openapi({
        description: "Active OpenTelemetry span id at the point the turn trace envelope was built.",
      }),
      sampled: z.boolean().openapi({
        description: "Whether the active OpenTelemetry span context was sampled.",
      }),
    }).openapi({
      description:
        "Debug-only OpenTelemetry correlation. Contains primitive trace identity only; no SDK span objects or payload data are embedded.",
    }),
  );

  const TurnTraceEnvelopeSchema = registry.register(
    "TurnTraceEnvelope",
    z.object({
      version: z.number().openapi({
        description: "Envelope generation marker. 0 = synthesized from a legacy turn; >=1 = engine-emitted spine.",
      }),
      spine: ConversationTraceSchema,
      openTelemetry: TurnTraceOpenTelemetryCorrelationSchema.optional(),
      summary: z.record(z.unknown()).optional(),
    }),
  );

  const chatResponseCoreShape = {
    agentId: z.string().uuid().optional(),
    agentName: z.string().optional(),
    answer: z.string(),
    citations: z.array(schemas.CitationSchema).optional(),
    answerSegments: z.array(schemas.AnswerSegmentSchema).optional(),
    suggestions: z.array(ChatSuggestionSchema).optional(),
    ownership: z.object({
      state: z.enum(["ai_owned", "human_owned"]),
      suppressed: z.boolean(),
    }).optional(),
  };

  const AssistantChatDebugSchema = registry.register(
    "AssistantChatDebug",
    z.object({
      route: AssistantRouteSchema,
      activitySummary: schemas.ActivitySummarySchema,
      activityTrace: schemas.ActivityTraceSchema,
      turnTrace: TurnTraceEnvelopeSchema.optional(),
    }),
  );

  const ChatResponseSchema = registry.register(
    "ChatResponse",
    z.object({
      conversationId: z.string().uuid(),
      assistantMessageId: z.string(),
      ...chatResponseCoreShape,
      debug: AssistantChatDebugSchema.optional(),
    }),
  );

  const ChatBootstrapResponseSchema = registry.register(
    "ChatBootstrapResponse",
    z.object({
      conversationId: z.string().uuid().optional(),
      bootstrapGreetingId: z.string().uuid().optional(),
      ...chatResponseCoreShape,
      debug: AssistantChatDebugSchema.optional(),
    }).openapi({
      description: "Ephemeral bootstrap greeting response. Conversation id is omitted until the first persisted user turn. The optional bootstrap greeting id can be sent with the first user message to save the displayed greeting in conversation history.",
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

  // Declared before the conversation summary/detail schemas so both can carry it. Absent on
  // the response means the conversation is AI-owned (the ownership table is lazy: no row).
  const ConversationOwnershipSchema = registry.register(
    "ConversationOwnership",
    z.object({
      conversationId: z.string().uuid(),
      workspaceId: z.string().uuid(),
      state: z.enum(["ai_owned", "human_owned"]),
      ownerAccountId: z.string().uuid().nullable(),
      ownerDisplayName: z.string().nullable(),
      reason: z.string().nullable(),
      version: z.number().int().nonnegative(),
      takenOverAt: z.string().datetime().nullable(),
      createdAt: z.string().datetime(),
      updatedAt: z.string().datetime(),
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
      ownership: ConversationOwnershipSchema.optional(),
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
        display: SkillDisplayMetadataSchema.optional(),
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
      skillName: z.string().optional(),
      skillOutcome: z.string().optional(),
      skillStatus: z.enum([
        "active",
        "paused",
        "awaiting_confirmation",
        "awaiting_tool",
        "completed",
        "cancelled",
        "expired",
        "failed",
      ]).optional(),
      route: AssistantRouteDiagnosticsSchema.optional(),
      activitySummary: schemas.ActivitySummarySchema.optional(),
      activityTrace: schemas.ActivityTraceSchema.optional(),
      turnTrace: TurnTraceEnvelopeSchema.optional(),
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
      source: z.enum(["customer", "ai_agent", "human_agent", "human_agent_on_behalf_of_ai_agent", "system"]),
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

  const ConversationOwnershipResponseSchema = registry.register(
    "ConversationOwnershipResponse",
    z.object({
      ownership: ConversationOwnershipSchema,
    }),
  );

  const HumanReplyMessageSchema = registry.register(
    "HumanReplyMessage",
    z.object({
      id: z.string().uuid(),
      conversationId: z.string().uuid(),
      workspaceId: z.string().uuid(),
      role: z.enum(["user", "assistant", "system"]),
      source: z.enum(["customer", "ai_agent", "human_agent", "human_agent_on_behalf_of_ai_agent", "system"]).optional(),
      content: z.string(),
      metadata: z.record(z.unknown()).optional(),
      inputMetadata: z.object({
        method: z.enum(["typed", "suggestion_click", "intent_click"]),
        suggestionSourceMessageId: z.string().uuid().optional(),
        intent: z.object({
          skillName: z.string(),
          intentName: z.string().optional(),
        }).optional(),
      }).optional(),
      skillName: z.string().optional(),
      skillOutcome: z.string().optional(),
      skillStatus: z.string().optional(),
      createdAt: z.string().datetime(),
    }),
  );

  const HumanReplyMessageResponseSchema = registry.register(
    "HumanReplyMessageResponse",
    z.object({
      message: HumanReplyMessageSchema,
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
      ownership: ConversationOwnershipSchema.optional(),
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
    SkillOutcomeDefinitionSchema,
    SkillDiagnosticEvidenceSchema,
    SkillDiagnosticDefinitionSchema,
    SkillCatalogEntrySchema,
    SkillCatalogResponseSchema,
    SkillParamsSchema,
    ChatSuggestionActionSchema,
    ChatSuggestionSchema,
    ConversationOwnershipSchema,
    ConversationOwnershipResponseSchema,
    AssistantRouteSchema,
    AssistantRouteDiagnosticsSchema,
    CapabilitySubTraceSchema,
    ConversationTraceStageSchema,
    ConversationTraceSchema,
    TurnTraceOpenTelemetryCorrelationSchema,
    TurnTraceEnvelopeSchema,
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
    HumanReplyMessageSchema,
    HumanReplyMessageResponseSchema,
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
