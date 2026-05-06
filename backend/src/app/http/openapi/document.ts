import { z } from "zod";
import {
  OpenAPIRegistry,
  OpenApiGeneratorV31,
  extendZodWithOpenApi,
} from "@asteasolutions/zod-to-openapi";

import {
  invitationAcceptSchema,
  invitationTokenParamsSchema,
  loginSchema,
  registerSchema,
} from "../routes/authRoutes.js";
import { accountMembershipParamsSchema, accountSwitchSchema, createAccountInvitationSchema } from "../routes/accountUserRoutes.js";
import {
  createWorkspaceSchema,
  renameWorkspaceSchema,
  workspaceKeyParamsSchema,
  workspaceParamsSchema,
} from "../routes/workspaceRoutes.js";
import { workspaceMcpContextSchema } from "../routes/mcpContextRoutes.js";
import {
  updateGeneralSettingsSchema,
  updateIngestionSettingsSchema,
  updatePlatformSettingsSchema,
  updateSettingsSchema,
} from "../routes/settingsRoutes.js";
import {
  documentParamsSchema,
  documentSchema,
  documentSearchHistoryParamsSchema,
  documentSearchSchema,
} from "../routes/documentRoutes.js";
import { assistantChatSchema } from "../schemas/assistantChatSchemas.js";
import { conversationParamsSchema } from "../routes/conversationRouteSchemas.js";
import { retrievalAnswerSchema, retrievalSearchSchema } from "../routes/retrievalRoutes.js";
import {
  anonymousChatSchema,
  publicConversationParamsSchema,
} from "../routes/publicChatRoutes.js";
import { websiteEmbedLauncherIcons, websiteEmbedLauncherPositions } from "../../../modules/settings/domain/websiteEmbedSettings.js";
import { chunkingStrategyIds } from "../../../modules/retrieval/domain/chunking/chunkingStrategy.js";
import {
  MAX_SUGGESTED_QUESTIONS_COUNT,
  MIN_SUGGESTED_QUESTIONS_COUNT,
  conversationModes,
  metadataRuleEffects,
  metadataRuleOperators,
  metadataRuleTriggerModes,
  metadataValueTypes,
} from "../../../modules/settings/domain/retrievalSettings.js";

extendZodWithOpenApi(z);

const registry = new OpenAPIRegistry();

const sessionCookieScheme = registry.registerComponent("securitySchemes", "sessionCookie", {
  type: "apiKey",
  in: "cookie",
  name: "radioso_session",
});

const workspaceSelectionScheme = registry.registerComponent("securitySchemes", "workspaceSelection", {
  type: "apiKey",
  in: "header",
  name: "X-Workspace-Id",
});

const bearerAuthScheme = registry.registerComponent("securitySchemes", "bearerAuth", {
  type: "http",
  scheme: "bearer",
  bearerFormat: "APIKey",
});

const anonymousSessionCookieScheme = registry.registerComponent("securitySchemes", "anonymousSessionCookie", {
  type: "apiKey",
  in: "cookie",
  name: "anon_session_{token}",
});

const workspaceAdminSecurity = [{ [sessionCookieScheme.name]: [], [workspaceSelectionScheme.name]: [] }];

const ErrorResponseSchema = registry.register(
  "ErrorResponse",
  z.object({
    error: z.object({
      code: z.string(),
      message: z.string(),
      details: z.unknown().optional(),
    }),
  }),
);

const FlatErrorResponseSchema = registry.register(
  "FlatErrorResponse",
  z.object({
    code: z.string(),
    message: z.string(),
  }),
);

const HealthResponseSchema = registry.register(
  "HealthResponse",
  z.object({
    status: z.literal("ok"),
  }),
);

const RegisterResponseSchema = registry.register(
  "RegisterResponse",
  z.object({
    userId: z.string().uuid(),
    accountId: z.string().uuid(),
    organizationName: z.string(),
    workspaceId: z.string().uuid(),
    workspaceName: z.string(),
    workspacePublicRouteKey: z.string(),
  }),
);

const LoginResponseSchema = registry.register(
  "LoginResponse",
  z.object({
    userId: z.string().uuid(),
    accountId: z.string().uuid(),
    organizationName: z.string(),
    workspaceId: z.string().uuid(),
    workspaceName: z.string(),
    workspacePublicRouteKey: z.string(),
  }),
);

const WorkspaceSchema = registry.register(
  "Workspace",
  z.object({
    id: z.string().uuid(),
    accountId: z.string().uuid(),
    name: z.string(),
    publicRouteKey: z.string(),
    createdAt: z.string().datetime(),
    updatedAt: z.string().datetime(),
  }),
);

const WorkspaceRouteResolutionResponseSchema = registry.register(
  "WorkspaceRouteResolutionResponse",
  z.object({
    workspaceKey: z.string(),
    workspaceId: z.string().uuid(),
    workspaceName: z.string(),
    accountId: z.string().uuid(),
    organizationName: z.string(),
  }),
);

const WorkspaceListResponseSchema = registry.register(
  "WorkspaceListResponse",
  z.object({
    workspaces: z.array(WorkspaceSchema),
  }),
);

const WorkspaceSummaryResponseSchema = registry.register(
  "WorkspaceSummaryResponse",
  z.object({
    documentCount: z.number().int().min(0),
    readyDocumentCount: z.number().int().min(0),
    pendingDocumentCount: z.number().int().min(0),
    sampleDocumentCount: z.number().int().min(0),
    sampleDocumentSlugs: z.array(z.string()),
    conversationCount: z.number().int().min(0),
    hasDocuments: z.boolean(),
    hasPendingDocuments: z.boolean(),
    hasReadyDocuments: z.boolean(),
    hasCompletedChat: z.boolean(),
    sampleDocumentsImported: z.boolean(),
  }),
);

const WorkspaceTokenResponseSchema = registry.register(
  "WorkspaceTokenResponse",
  z.object({
    token: z.string(),
  }),
);

const WorkspaceMcpContextResponseSchema = registry.register(
  "WorkspaceMcpContextResponse",
  workspaceMcpContextSchema,
);

const RegisterRequestSchema = registry.register("RegisterRequest", registerSchema);
const LoginRequestSchema = registry.register("LoginRequest", loginSchema);
const InvitationAcceptRequestSchema = registry.register("InvitationAcceptRequest", invitationAcceptSchema);
const AccountInvitationCreateRequestSchema = registry.register("AccountInvitationCreateRequest", createAccountInvitationSchema);
const WorkspaceCreateRequestSchema = registry.register("WorkspaceCreateRequest", createWorkspaceSchema);
const WorkspaceRenameRequestSchema = registry.register("WorkspaceRenameRequest", renameWorkspaceSchema);

const AccountUserSchema = registry.register(
  "AccountUser",
  z.object({
    membershipId: z.string().uuid(),
    userId: z.string().uuid(),
    email: z.string().email(),
    role: z.enum(["owner", "member"]),
    status: z.literal("active"),
    createdAt: z.string().datetime(),
  }),
);

const AccountInvitationSchema = registry.register(
  "AccountInvitation",
  z.object({
    id: z.string().uuid(),
    email: z.string().email(),
    status: z.enum(["pending", "accepted", "revoked", "expired"]),
    expiresAt: z.string().datetime(),
    acceptedAt: z.string().datetime().nullable(),
    createdAt: z.string().datetime(),
  }),
);

const AccountUsersResponseSchema = registry.register(
  "AccountUsersResponse",
  z.object({
    accountId: z.string().uuid(),
    currentUserId: z.string().uuid(),
    users: z.array(AccountUserSchema),
    invitations: z.array(AccountInvitationSchema),
  }),
);

const AccessibleAccountSchema = registry.register(
  "AccessibleAccount",
  z.object({
    accountId: z.string().uuid(),
    organizationName: z.string(),
    role: z.enum(["owner", "member"]),
    workspaceId: z.string().uuid(),
    workspaceName: z.string(),
    workspacePublicRouteKey: z.string(),
  }),
);

const AccessibleAccountsResponseSchema = registry.register(
  "AccessibleAccountsResponse",
  z.object({
    currentAccountId: z.string().uuid(),
    accounts: z.array(AccessibleAccountSchema),
  }),
);

const CreateAccountInvitationResponseSchema = registry.register(
  "CreateAccountInvitationResponse",
  AccountInvitationSchema.extend({
    acceptanceUrl: z.string(),
  }),
);

const InvitationDetailsResponseSchema = registry.register(
  "InvitationDetailsResponse",
  z.object({
    accountId: z.string().uuid(),
    email: z.string().email(),
    status: z.enum(["pending", "accepted", "revoked", "expired"]),
    expiresAt: z.string().datetime(),
  }),
);

const RetrievalSettingsSchema = registry.register(
  "RetrievalSettings",
  z.object({
    workspaceId: z.string().uuid(),
    queryRewriteEnabled: z.boolean(),
    semanticRewriteInstructions: z.string().max(2000),
    lexicalRewriteInstructions: z.string().max(2000),
    conversationMode: z.enum(conversationModes),
    suggestedQuestionsEnabled: z.boolean(),
    suggestedQuestionsCount: z.number().int().min(MIN_SUGGESTED_QUESTIONS_COUNT).max(MAX_SUGGESTED_QUESTIONS_COUNT),
    rerankEnabled: z.boolean(),
    vectorTopK: z.number().int().min(1).max(300),
    similarityThreshold: z.number().min(0).max(1),
    rerankTopK: z.number().int().min(1),
    citationDisplayEnabled: z.boolean(),
    answerSupportValidationEnabled: z.boolean(),
    metadataFieldSuggestions: z.array(
      z.object({
        field: z.string(),
        inferredType: z.enum(metadataValueTypes),
      }),
    ).default([]),
    metadataRules: z.array(
      z.object({
        id: z.string(),
        field: z.string(),
        valueType: z.enum(metadataValueTypes),
        operator: z.enum(metadataRuleOperators),
        value: z.string(),
        combinator: z.enum(["and", "or"]).default("and"),
        conditions: z.array(
          z.object({
            id: z.string(),
            field: z.string(),
            valueType: z.enum(metadataValueTypes),
            operator: z.enum(metadataRuleOperators),
            value: z.string(),
          }),
        ).default([]),
        effect: z.enum(metadataRuleEffects),
        enabled: z.boolean(),
        triggerMode: z.enum(metadataRuleTriggerModes),
        triggerInstruction: z.string().optional(),
      }),
    ).default([]),
    customInstruction: z.string().max(2000),
    createdAt: z.string().datetime(),
    updatedAt: z.string().datetime(),
  }),
);

const UpdateRetrievalSettingsRequestSchema = registry.register(
  "UpdateRetrievalSettingsRequest",
  updateSettingsSchema,
);

const IngestionSettingsSchema = registry.register(
  "IngestionSettings",
  z.object({
    workspaceId: z.string().uuid(),
    chunkingStrategy: z.enum(chunkingStrategyIds),
    fixedWindowChunkSize: z.number().int(),
    fixedWindowChunkOverlap: z.number().int(),
    structuredMinChunkSize: z.number().int(),
    structuredMaxChunkSize: z.number().int(),
    createdAt: z.string().datetime(),
    updatedAt: z.string().datetime(),
  }),
);

const UpdateIngestionSettingsRequestSchema = registry.register(
  "UpdateIngestionSettingsRequest",
  updateIngestionSettingsSchema,
);

const RetrievalMetadataRuleSchema = registry.register(
  "RetrievalMetadataRule",
  z.object({
    id: z.string(),
    field: z.string(),
    valueType: z.enum(metadataValueTypes),
    operator: z.enum(metadataRuleOperators),
    value: z.string(),
    combinator: z.enum(["and", "or"]).default("and"),
    conditions: z.array(
      z.object({
        id: z.string(),
        field: z.string(),
        valueType: z.enum(metadataValueTypes),
        operator: z.enum(metadataRuleOperators),
        value: z.string(),
      }),
    ).default([]),
    effect: z.enum(metadataRuleEffects),
    enabled: z.boolean(),
    triggerMode: z.enum(metadataRuleTriggerModes),
    triggerInstruction: z.string().optional(),
  }),
);

const TriggerAnalysisRuleSchema = registry.register(
  "TriggerAnalysisRule",
  z.object({
    ruleId: z.string(),
    matched: z.boolean(),
    matchStrength: z.number().min(0).max(1),
    reason: z.string(),
    triggerInstructionPreview: z.string(),
  }),
);

const TriggerAnalysisSchema = registry.register(
  "TriggerAnalysis",
  z.object({
    status: z.enum(["skipped_not_configured", "skipped_unavailable", "applied", "fallback"]),
    consideredRules: z.array(TriggerAnalysisRuleSchema),
    matchedRuleIds: z.array(z.string()),
    unmatchedRuleIds: z.array(z.string()),
    matchCount: z.number().int().min(0),
    matcherVersion: z.string(),
    failureReason: z.string().optional(),
  }),
);

const TriggerBackoffSchema = registry.register(
  "TriggerBackoff",
  z.object({
    applied: z.boolean(),
    reason: z.enum(["empty_filtered_candidates", "weak_filtered_support"]).optional(),
    relaxedRuleIds: z.array(z.string()),
    restoredCandidateCount: z.number().int().min(0).optional(),
  }),
);

const UpdateGeneralSettingsRequestSchema = registry.register(
  "UpdateGeneralSettingsRequest",
  updateGeneralSettingsSchema,
);

const GeneralSettingsResponseSchema = registry.register(
  "GeneralSettingsResponse",
  z.object({
    anonymousChatEnabled: z.boolean(),
    anonymousChatUrl: z.string().nullable(),
    anonymousRateLimit: z.number().int().min(1).max(60),
    assistantName: z.string(),
    greetingInstruction: z.string(),
    assistantDefaultLocale: z.string().nullable(),
    proactiveGreetingEnabled: z.boolean(),
    assistantBootstrapActive: z.boolean(),
    websiteEmbedEnabled: z.boolean(),
    websiteEmbedToken: z.string().nullable(),
    websiteEmbedScriptUrl: z.string().nullable(),
    websiteEmbedSnippet: z.string().nullable(),
    websiteEmbedAllowedOrigins: z.array(z.string()),
    websiteEmbedLauncherLabel: z.string(),
    websiteEmbedLauncherIcon: z.enum(websiteEmbedLauncherIcons),
    websiteEmbedLauncherPosition: z.enum(websiteEmbedLauncherPositions),
  }),
);

const AssistantSettingsSectionSchema = registry.register(
  "AssistantSettingsSection",
  z.object({
    assistantName: z.string(),
    greetingInstruction: z.string(),
    assistantDefaultLocale: z.string().nullable(),
    proactiveGreetingEnabled: z.boolean(),
    assistantBootstrapActive: z.boolean().openapi({
      description: "Server-managed bootstrap readiness derived from the current assistant configuration.",
      readOnly: true,
    }),
    conversationMode: z.enum(conversationModes),
    suggestedQuestionsEnabled: z.boolean(),
    suggestedQuestionsCount: z.number().int().min(MIN_SUGGESTED_QUESTIONS_COUNT).max(MAX_SUGGESTED_QUESTIONS_COUNT),
    customInstruction: z.string(),
  }),
);

const PlatformRetrievalSettingsSectionSchema = registry.register(
  "PlatformRetrievalSettingsSection",
  z.object({
    queryRewriteEnabled: z.boolean(),
    semanticRewriteInstructions: z.string().max(2000),
    lexicalRewriteInstructions: z.string().max(2000),
    rerankEnabled: z.boolean(),
    vectorTopK: z.number().int().min(1).max(300),
    similarityThreshold: z.number().min(0).max(1),
    rerankTopK: z.number().int().min(1),
    citationDisplayEnabled: z.boolean(),
    answerSupportValidationEnabled: z.boolean(),
    metadataRules: z.array(
      z.object({
        id: z.string(),
        field: z.string(),
        valueType: z.enum(metadataValueTypes),
        operator: z.enum(metadataRuleOperators),
        value: z.string(),
        combinator: z.enum(["and", "or"]).default("and"),
        conditions: z.array(
          z.object({
            id: z.string(),
            field: z.string(),
            valueType: z.enum(metadataValueTypes),
            operator: z.enum(metadataRuleOperators),
            value: z.string(),
          }),
        ).default([]),
        effect: z.enum(metadataRuleEffects),
        enabled: z.boolean(),
        triggerMode: z.enum(metadataRuleTriggerModes),
        triggerInstruction: z.string().optional(),
      }),
    ).default([]),
    metadataFieldSuggestions: z.array(
      z.object({
        field: z.string(),
        inferredType: z.enum(metadataValueTypes),
      }),
    ).default([]),
  }),
);

const PlatformChannelsSettingsSectionSchema = registry.register(
  "PlatformChannelsSettingsSection",
  z.object({
    anonymousChatEnabled: z.boolean(),
    anonymousChatUrl: z.string().nullable(),
    anonymousRateLimit: z.number().int().min(1).max(60),
    websiteEmbedEnabled: z.boolean(),
    websiteEmbedToken: z.string().nullable(),
    websiteEmbedAllowedOrigins: z.array(z.string()),
    websiteEmbedLauncherLabel: z.string(),
    websiteEmbedLauncherIcon: z.enum(websiteEmbedLauncherIcons),
    websiteEmbedLauncherPosition: z.enum(websiteEmbedLauncherPositions),
    websiteEmbedScriptUrl: z.string().nullable(),
    websiteEmbedSnippet: z.string().nullable(),
  }),
);

const PlatformSettingsResponseSchema = registry.register(
  "PlatformSettingsResponse",
  z.object({
    assistant: AssistantSettingsSectionSchema,
    retrieval: PlatformRetrievalSettingsSectionSchema,
    channels: PlatformChannelsSettingsSectionSchema,
  }),
);

const UpdatePlatformSettingsRequestSchema = registry.register(
  "UpdatePlatformSettingsRequest",
  updatePlatformSettingsSchema,
);

const PublicChatPageContextSchema = z.object({
  pageUrl: z.string().trim().max(2048).nullable().optional(),
  pageTitle: z.string().trim().max(180).nullable().optional(),
  pageLocale: z.string().trim().max(35).nullable().optional(),
  browserLocale: z.string().trim().max(35).nullable().optional(),
  content: z.string().trim().max(6000).nullable().optional(),
}).optional();

const PublicChatSessionResponseSchema = registry.register(
  "PublicChatSessionResponse",
  z.object({
    workspaceName: z.string(),
    publicChatToken: z.string(),
    publicSessionId: z.string().uuid(),
    publicSessionToken: z.string(),
    assistantBootstrapActive: z.boolean(),
    actions: z.record(z.unknown()).optional(),
    expiresAt: z.string().datetime(),
  }),
);

const PublicChatSessionRequestSchema = registry.register(
  "PublicChatSessionRequest",
  z.object({
    channel: z.enum(["anonymous_link", "website_embed"]),
    anonymousSessionId: z.string().uuid().optional(),
    pageContext: PublicChatPageContextSchema,
  }),
);

const WorkspaceIngestionReprocessResponseSchema = registry.register(
  "WorkspaceIngestionReprocessResponse",
  z.object({
    workspaceId: z.string().uuid(),
    queuedDocumentCount: z.number().int().min(0),
    skippedDocumentCount: z.number().int().min(0),
    status: z.enum(["queued", "noop"]),
  }),
);

const DocumentStatusSchema = z.string().openapi("DocumentStatus");
const RagStatusSchema = z.string().openapi("RagStatus");
const DocumentCreateRequestSchema = registry.register("DocumentCreateRequest", documentSchema);

const DocumentOperationResponseSchema = registry.register(
  "DocumentOperationResponse",
  z.object({
    documentId: z.string().uuid(),
    status: DocumentStatusSchema,
  }),
);

const DocumentSummarySchema = registry.register(
  "DocumentSummary",
  z.object({
    id: z.string().uuid(),
    title: z.string(),
    status: DocumentStatusSchema,
    ragStatus: RagStatusSchema,
    failureReason: z.string().nullable().optional(),
    createdAt: z.string().datetime(),
    updatedAt: z.string().datetime(),
    metadata: z.record(z.union([z.string(), z.number(), z.boolean(), z.null()])).default({}),
    externalDocumentId: z.string().nullable().optional(),
  }),
);

const DocumentDetailsSchema = registry.register(
  "DocumentDetails",
  DocumentSummarySchema.extend({
    content: z.string(),
  }),
);

const DocumentListResponseSchema = registry.register(
  "DocumentListResponse",
  z.object({
    documents: z.array(DocumentSummarySchema),
    total: z.number().int().min(0),
    nextCursor: z.string().nullable(),
    hasMore: z.boolean(),
  }),
);

const DocumentSearchActionSchema = registry.register(
  "DocumentSearchAction",
  z.object({
    type: z.enum(["open_document", "inspect_match_evidence", "open_history_entry", "rerun_search"]),
    status: z.enum(["available", "unavailable"]),
  }),
);

const DocumentSearchResultSchema = registry.register(
  "DocumentSearchResult",
  z.object({
    documentId: z.string().uuid(),
    title: z.string(),
    status: DocumentStatusSchema,
    ragStatus: RagStatusSchema,
    metadata: z.record(z.unknown()),
    score: z.number(),
    rank: z.number().int().min(1),
    matchEvidence: z.array(z.string()),
    sourceKind: z.enum(["inline_text", "uploaded_file"]),
    sourceFilename: z.string().nullable().optional(),
    sourceMimeType: z.string().nullable().optional(),
    actions: z.array(DocumentSearchActionSchema),
  }),
);

const DocumentSearchHistoryEntrySchema = registry.register(
  "DocumentSearchHistoryEntry",
  z.object({
    searchId: z.string().uuid(),
    query: z.string(),
    createdAt: z.string().datetime(),
    resultCount: z.number().int().min(0),
    traceAvailable: z.boolean(),
    previewTopTitles: z.array(z.string()),
  }),
);

const DocumentSearchHistoryListResponseSchema = registry.register(
  "DocumentSearchHistoryListResponse",
  z.object({
    searches: z.array(DocumentSearchHistoryEntrySchema),
    total: z.number().int().min(0),
    nextCursor: z.string().nullable(),
    hasMore: z.boolean(),
  }),
);
const DocumentSearchRequestSchema = registry.register("DocumentSearchRequest", documentSearchSchema);

const CitationSchema = registry.register(
  "Citation",
  z.object({
    documentId: z.string().uuid(),
    chunkId: z.string().uuid(),
    title: z.string(),
  }),
);

const AnswerSegmentSchema = registry.register(
  "AnswerSegment",
  z.object({
    text: z.string(),
    citationIndices: z.array(z.number().int().min(0)).optional(),
  }),
);

const ParsedQuerySchema = registry.register(
  "ParsedQuery",
  z.object({
    originalQuery: z.string().optional(),
    semanticQuery: z.string(),
    lexicalQuery: z.string(),
    constraintSummary: z.array(z.string()),
  }),
);

const CandidateCountsSchema = registry.register(
  "CandidateCounts",
  z.object({
    semantic: z.number().int().min(0),
    lexical: z.number().int().min(0),
    merged: z.number().int().min(0),
    final: z.number().int().min(0),
  }),
);

const RetrievalSubquerySchema = registry.register(
  "RetrievalSubquery",
  z.object({
    id: z.string(),
    label: z.string(),
    semanticQuery: z.string(),
    lexicalQuery: z.string(),
    reason: z.string().optional(),
    responseLanguagePolicy: z.enum(["match_user_question"]).optional(),
  }),
);

const AppliedConstraintSchema = registry.register(
  "AppliedConstraint",
  z.object({
    signalKey: z.string(),
    mode: z.enum(["boost_only", "hard_filter"]),
    outcome: z.enum(["applied", "relaxed", "skipped"]),
    summary: z.string(),
  }),
);

const RewriteInfoSchema = registry.register(
  "RewriteInfo",
  z.object({
    status: z.string(),
    eligible: z.boolean(),
    ran: z.boolean(),
    materialDisagreement: z.boolean(),
    continuityDecision: z.string().optional(),
    rejectionReason: z.string().optional(),
  }),
);

const RetrievalExecutionMetadataSchema = registry.register(
  "RetrievalExecutionMetadata",
  z.object({
    surface: z.enum(["assistant", "retrieval", "mcp_capability"]),
    path: z.enum([
      "assistant_direct",
      "assistant_retrieval",
      "retrieval_search",
      "retrieval_answer",
      "mcp_grounded_answer",
    ]),
    retrievalInvoked: z.boolean(),
  }),
);

const RetrievalInfoSchema = registry.register(
  "RetrievalInfo",
  z.object({
    execution: RetrievalExecutionMetadataSchema.optional(),
    parsedQuery: ParsedQuerySchema.optional(),
    retrievalSubqueries: z.array(RetrievalSubquerySchema).optional(),
    responseIntent: z.enum(["retrieval", "social_only", "assistant_identity"]).optional().openapi({
      description: "High-level user-turn intent inferred before routing. This is independent from the assistant route reason.",
    }),
    retrievalSkipped: z.boolean().optional(),
    intentConfidence: z.number().min(0).max(1).optional(),
    intentFallbackApplied: z.boolean().optional(),
    responseLanguagePolicy: z.enum(["match_user_question"]).optional(),
    candidateCounts: CandidateCountsSchema,
    appliedConstraints: z.array(AppliedConstraintSchema).optional(),
    fallbackApplied: z.boolean(),
    rerankStatus: z.enum(["skipped", "applied", "fallback"]),
    rewrite: RewriteInfoSchema.optional(),
    triggerAnalysis: TriggerAnalysisSchema.optional(),
    triggerBackoff: TriggerBackoffSchema.optional(),
  }),
);

const RetrievalTraceStageSchema = registry.register(
  "RetrievalTraceStage",
  z.object({
    stageId: z.string(),
    kind: z.string(),
    label: z.string(),
    status: z.enum(["applied", "skipped", "fallback", "rejected", "unavailable", "failed"]),
    startedAt: z.string().datetime().optional(),
    durationMs: z.number().int().min(0).optional(),
    settings: z.record(z.unknown()).optional(),
    inputs: z.record(z.unknown()).optional(),
    outputs: z.record(z.unknown()).optional(),
    metrics: z.record(z.number()).optional(),
    reason: z.string().optional(),
  }),
);

const RetrievalTraceLinkSchema = registry.register(
  "RetrievalTraceLink",
  z.object({
    fromStageId: z.string(),
    toStageId: z.string(),
    kind: z.enum(["sequence", "branch", "converge"]),
  }),
);

const RetrievalTraceSchema = registry.register(
  "RetrievalTrace",
  z.object({
    traceId: z.string(),
    startedAt: z.string().datetime(),
    completedAt: z.string().datetime().optional(),
    totalDurationMs: z.number().int().min(0).optional(),
    stages: z.array(RetrievalTraceStageSchema),
    links: z.array(RetrievalTraceLinkSchema),
    summary: RetrievalInfoSchema.optional(),
  }),
);

const DocumentSearchResponseSchema = registry.register(
  "DocumentSearchResponse",
  z.object({
    searchId: z.string().uuid(),
    mode: z.enum(["live", "snapshot"]),
    query: z.string(),
    resultCount: z.number().int().min(0),
    results: z.array(DocumentSearchResultSchema),
    retrievalTrace: RetrievalTraceSchema.optional(),
  }),
);

const RetrievalSearchRequestSchema = registry.register("RetrievalSearchRequest", retrievalSearchSchema);
const RetrievalAnswerRequestSchema = registry.register("RetrievalAnswerRequest", retrievalAnswerSchema);

const RetrievalSearchEvidenceSchema = registry.register(
  "RetrievalSearchEvidence",
  z.object({
    documentId: z.string().uuid(),
    chunkId: z.string().uuid(),
    title: z.string(),
    content: z.string(),
    metadata: z.record(z.unknown()).optional(),
    score: z.number().optional(),
  }),
);

const RetrievalSearchResponseSchema = registry.register(
  "RetrievalSearchResponse",
  z.object({
    outcome: z.literal("results"),
    rewrittenQuery: z.object({
      semantic: z.string(),
      lexical: z.string(),
    }),
    results: z.array(RetrievalSearchEvidenceSchema),
    retrievalInfo: RetrievalInfoSchema,
    retrievalTrace: RetrievalTraceSchema,
  }),
);

const RetrievalAnswerEvidenceSchema = registry.register(
  "RetrievalAnswerEvidence",
  z.object({
    documentId: z.string().uuid(),
    chunkId: z.string().uuid(),
    title: z.string(),
    content: z.string(),
    metadata: z.record(z.unknown()).optional(),
  }),
);

const RetrievalAnswerSuccessSchema = registry.register(
  "RetrievalAnswerSuccess",
  z.object({
    outcome: z.literal("answer"),
    answer: z.string(),
    citations: z.array(CitationSchema).optional(),
    evidence: z.array(RetrievalAnswerEvidenceSchema),
    validation: z.object({
      status: z.enum(["supported", "unsupported", "not_checked"]),
    }),
    retrievalInfo: RetrievalInfoSchema,
    retrievalTrace: RetrievalTraceSchema,
  }),
);

const RetrievalAnswerUnsupportedSchema = registry.register(
  "RetrievalAnswerUnsupported",
  z.object({
    outcome: z.literal("unsupported"),
    code: z.literal("unsupported_query_type"),
    reason: z.enum(["social_only", "assistant_identity"]),
    message: z.literal("This request is outside retrieval scope."),
  }),
);

const RetrievalAnswerResponseSchema = registry.register(
  "RetrievalAnswerResponse",
  z.union([RetrievalAnswerSuccessSchema, RetrievalAnswerUnsupportedSchema]),
);

const ChatSuggestionSchema = registry.register(
  "ChatSuggestion",
  z.object({
    text: z.string(),
    kind: z.string(),
    citation: CitationSchema.optional(),
    action: z.object({
      kind: z.string(),
      payload: z.record(z.unknown()).optional(),
    }).optional(),
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
  answer: z.string(),
  citations: z.array(CitationSchema).optional(),
  answerSegments: z.array(AnswerSegmentSchema).optional(),
  suggestions: z.array(ChatSuggestionSchema).optional(),
  conversationMode: z.enum(conversationModes),
  conversationModeMetadata: z.object({
    conversationMode: z.enum(conversationModes),
    brevityOverrideApplied: z.boolean(),
    expansionApplied: z.boolean(),
    expansionKind: z.enum(["none", "focused", "expansive"]),
    suggestionCount: z.number().int().min(0),
    followUpQuestionApplied: z.boolean(),
  }),
  retrievalInfo: RetrievalInfoSchema,
  retrievalTrace: RetrievalTraceSchema,
};

const ChatResponseSchema = registry.register(
  "ChatResponse",
  z.object({
    conversationId: z.string().uuid(),
    ...chatResponseCoreShape,
    route: AssistantRouteSchema,
  }),
);

const ChatBootstrapResponseSchema = registry.register(
  "ChatBootstrapResponse",
  z.object({
    conversationId: z.string().uuid().optional(),
    ...chatResponseCoreShape,
    route: AssistantRouteSchema,
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
  z.union([
    z.object({
      conversationId: z.string().uuid().optional(),
      message: z.string().min(1),
      startConversation: z.literal(false).optional().default(false),
      stream: z.boolean().default(false),
      userExpectedLocale: z.string().trim().max(35).optional(),
      inputMetadata: z.object({
        method: z.enum(["typed", "suggestion_click"]),
        suggestionSourceMessageId: z.string().uuid().optional(),
      }).optional(),
      sourceContext: z.object({
        surface: z.enum(["authenticated_chat", "public_chat", "website_embed"]).optional(),
        sourceOrigin: z.string().trim().max(200).nullable().optional(),
      }).optional(),
      metadataFilter: z.record(z.unknown()).optional(),
    }).openapi({
      description: "Standard assistant turn. `message` is required for non-bootstrap requests.",
    }),
    z.object({
      startConversation: z.literal(true),
      stream: z.literal(false).default(false),
      message: z.string().min(1).optional(),
      userExpectedLocale: z.string().trim().max(35).optional(),
      inputMetadata: z.object({
        method: z.enum(["typed", "suggestion_click"]),
        suggestionSourceMessageId: z.string().uuid().optional(),
      }).optional(),
      sourceContext: z.object({
        surface: z.enum(["authenticated_chat", "public_chat", "website_embed"]).optional(),
        sourceOrigin: z.string().trim().max(200).nullable().optional(),
      }).optional(),
      metadataFilter: z.record(z.unknown()).optional(),
    }).strict().openapi({
      description: "Conversation bootstrap request. `conversationId` is not allowed and streaming is disabled.",
    }),
  ]),
);
const PublicChatRequestSchema = registry.register(
  "PublicChatRequest",
  z.union([
    z.object({
      conversationId: z.string().uuid().optional(),
      message: z.string().min(1),
      startConversation: z.literal(false).optional().default(false),
      stream: z.boolean().default(false),
      userExpectedLocale: z.string().trim().max(35).optional(),
      pageContext: z.object({
        pageUrl: z.string().trim().max(2048).nullable().optional(),
        pageTitle: z.string().trim().max(180).nullable().optional(),
        pageLocale: z.string().trim().max(35).nullable().optional(),
        browserLocale: z.string().trim().max(35).nullable().optional(),
        content: z.string().trim().max(6000).nullable().optional(),
      }).optional(),
      inputMetadata: z.object({
        method: z.enum(["typed", "suggestion_click"]),
        suggestionSourceMessageId: z.string().uuid().optional(),
      }).optional(),
    }).openapi({
      description: "Standard public chat turn. `message` is required for non-bootstrap requests.",
    }),
    z.object({
      startConversation: z.literal(true),
      stream: z.literal(false).default(false),
      message: z.string().min(1).optional(),
      userExpectedLocale: z.string().trim().max(35).optional(),
      pageContext: z.object({
        pageUrl: z.string().trim().max(2048).nullable().optional(),
        pageTitle: z.string().trim().max(180).nullable().optional(),
        pageLocale: z.string().trim().max(35).nullable().optional(),
        browserLocale: z.string().trim().max(35).nullable().optional(),
        content: z.string().trim().max(6000).nullable().optional(),
      }).optional(),
      inputMetadata: z.object({
        method: z.enum(["typed", "suggestion_click"]),
        suggestionSourceMessageId: z.string().uuid().optional(),
      }).optional(),
    }).strict().openapi({
      description: "Public conversation bootstrap request. `conversationId` is not allowed and streaming is disabled.",
    }),
  ]),
);

const ChatConversationSummarySchema = registry.register(
  "ChatConversationSummary",
  z.object({
    id: z.string().uuid(),
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
    conversations: z.array(ChatConversationSummarySchema),
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
      search: DocumentSearchHistoryEntrySchema,
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

const ValidationDispositionSchema = registry.register(
  "ValidationDisposition",
  z.enum(["supported", "unsupported", "non_substantive"]),
);

const ValidationSegmentResultSchema = registry.register(
  "ValidationSegmentResult",
  z.object({
    originalText: z.string(),
    text: z.string(),
    disposition: ValidationDispositionSchema,
    replacementApplied: z.boolean(),
    reason: z.string(),
    citationIndices: z.array(z.number().int().min(0)).optional(),
  }),
);

const ValidationDebugSchema = registry.register(
  "ValidationDebug",
  z.object({
    ran: z.boolean(),
    answerModified: z.boolean(),
    unsupportedSegmentCount: z.number().int().min(0),
    substantiveUnsupportedSegmentCount: z.number().int().min(0),
    supportedSegmentCount: z.number().int().min(0),
    nonSubstantiveSegmentCount: z.number().int().min(0),
    hiddenSupportUsed: z.boolean().optional(),
    hiddenSupportKindsUsed: z.array(z.enum(["assistant_name"])).optional(),
    segmentResults: z.array(ValidationSegmentResultSchema),
  }),
);

const ChatConversationMessageDebugSchema = registry.register(
  "ChatConversationMessageDebug",
  z.object({
    eventStatus: z.enum(["success", "failure"]),
    recordedAt: z.string().datetime(),
    stream: z.boolean(),
    citationCount: z.number().int().min(0),
    answerOutcome: z.enum(["grounded_success", "grounded_degraded_unsupported_segments", "no_context_refusal", "non_retrieval_response"]).optional(),
    conversationMode: z.enum(conversationModes).optional(),
    route: AssistantRouteDiagnosticsSchema.optional(),
    conversationModeMetadata: z.object({
      conversationMode: z.enum(conversationModes),
      brevityOverrideApplied: z.boolean(),
      expansionApplied: z.boolean(),
      expansionKind: z.enum(["none", "focused", "expansive"]),
      suggestionCount: z.number().int().min(0),
      followUpQuestionApplied: z.boolean(),
    }).optional(),
    validation: ValidationDebugSchema.optional(),
    retrievalInfo: RetrievalInfoSchema.optional(),
    retrievalTrace: RetrievalTraceSchema.optional(),
    errorMessage: z.string().nullable().optional(),
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
      method: z.enum(["typed", "suggestion_click"]),
      suggestionSourceMessageId: z.string().uuid().optional(),
    }).optional(),
    citations: z.array(CitationSchema).optional(),
    answerSegments: z.array(AnswerSegmentSchema).optional(),
    suggestions: z.array(ChatSuggestionSchema).optional(),
    debug: ChatConversationMessageDebugSchema.optional(),
  }),
);

const ChatConversationDetailSchema = registry.register(
  "ChatConversationDetail",
  z.object({
    conversationId: z.string().uuid(),
    workspaceId: z.string().uuid(),
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

const ConnectorFieldSchema = registry.register(
  "ConnectorField",
  z.object({
    key: z.string(),
    label: z.string(),
    type: z.string(),
    required: z.boolean(),
    defaultValue: z.string().optional(),
    helpText: z.string().optional(),
  }),
);

const ConnectorSummarySchema = registry.register(
  "ConnectorSummary",
  z.object({
    id: z.string(),
    name: z.string(),
    description: z.string(),
    enabled: z.boolean(),
    errorStatus: z.string().nullable(),
  }),
);

const ConnectorListResponseSchema = registry.register(
  "ConnectorListResponse",
  z.object({
    connectors: z.array(ConnectorSummarySchema),
  }),
);

const ConnectorDetailSchema = registry.register(
  "ConnectorDetail",
  ConnectorSummarySchema.extend({
    schema: z.array(ConnectorFieldSchema),
    config: z.record(z.union([z.string(), z.number(), z.boolean()])),
    webhookUrl: z.string().url(),
  }),
);

const ConnectorConfigUpdateSchema = registry.register(
  "ConnectorConfigUpdateRequest",
  z.object({
    config: z.record(z.union([z.string(), z.number(), z.boolean()])),
  }),
);

const ConnectorValidationIssueSchema = registry.register(
  "ConnectorValidationIssue",
  z.object({
    key: z.string(),
    message: z.string(),
  }),
);

const ConnectorValidationErrorSchema = registry.register(
  "ConnectorValidationErrorResponse",
  z.object({
    error: z.literal("Validation failed"),
    fields: z.array(ConnectorValidationIssueSchema),
  }),
);

const ConnectorConflictSchema = registry.register(
  "ConnectorConflictResponse",
  z.object({
    error: z.literal("Channel identity conflict"),
    detail: z.string(),
  }),
);

const tokenPathParamsSchema = z.object({
  token: z.string().min(1),
}).openapi("PublicChatTokenParams");

const connectorIdPathParamsSchema = z.object({
  connectorId: z.string().min(1),
}).openapi("ConnectorIdParams");

registry.registerPath({
  method: "get",
  path: "/health",
  tags: ["System"],
  summary: "Health check",
  operationId: "getHealth",
  responses: {
    200: {
      description: "Service is healthy",
      content: {
        "application/json": {
          schema: HealthResponseSchema,
        },
      },
    },
  },
});

registry.registerPath({
  method: "post",
  path: "/api/v1/public/chat/{token}/sessions",
  tags: ["Assistant"],
  summary: "Create a public chat session from a launch token",
  operationId: "createPublicChatSession",
  request: {
    params: tokenPathParamsSchema,
    body: {
      content: {
        "application/json": {
          schema: PublicChatSessionRequestSchema,
        },
      },
    },
  },
  responses: {
    200: {
      description: "Public chat session returned",
      content: {
        "application/json": {
          schema: PublicChatSessionResponseSchema,
        },
      },
    },
    400: {
      description: "Request validation failed",
      content: {
        "application/json": {
          schema: ErrorResponseSchema,
        },
      },
    },
    403: {
      description: "Origin not allowed for this public chat channel",
      content: {
        "application/json": {
          schema: ErrorResponseSchema,
        },
      },
    },
    404: {
      description: "Public chat not found",
      content: {
        "application/json": {
          schema: ErrorResponseSchema,
        },
      },
    },
  },
});

registry.registerPath({
  method: "post",
  path: "/api/v1/auth/register",
  tags: ["Auth"],
  summary: "Register a new account",
  operationId: "registerAccount",
  request: {
    body: {
      required: true,
      content: {
        "application/json": {
          schema: RegisterRequestSchema,
        },
      },
    },
  },
  responses: {
    201: {
      description: "Account created and verification required before sign-in",
      content: {
        "application/json": {
          schema: RegisterResponseSchema,
        },
      },
    },
    400: {
      description: "Request validation failed",
      content: {
        "application/json": {
          schema: ErrorResponseSchema,
        },
      },
    },
    409: {
      description: "Resource already exists",
      content: {
        "application/json": {
          schema: ErrorResponseSchema,
        },
      },
    },
    500: {
      description: "Unexpected server error",
      content: {
        "application/json": {
          schema: ErrorResponseSchema,
        },
      },
    },
  },
});

registry.registerPath({
  method: "post",
  path: "/api/v1/auth/login",
  tags: ["Auth"],
  summary: "Log in an existing account",
  operationId: "loginAccount",
  request: {
    body: {
      required: true,
      content: {
        "application/json": {
          schema: LoginRequestSchema,
        },
      },
    },
  },
  responses: {
    200: {
      description: "Session established",
      content: {
        "application/json": {
          schema: LoginResponseSchema,
        },
      },
    },
    400: {
      description: "Request validation failed",
      content: {
        "application/json": {
          schema: ErrorResponseSchema,
        },
      },
    },
    401: {
      description: "Authentication required or invalid credentials",
      content: {
        "application/json": {
          schema: ErrorResponseSchema,
        },
      },
    },
    500: {
      description: "Unexpected server error",
      content: {
        "application/json": {
          schema: ErrorResponseSchema,
        },
      },
    },
  },
});

registry.registerPath({
  method: "get",
  path: "/api/v1/auth/invitations/{invitationToken}",
  tags: ["Auth"],
  summary: "Get invitation details for an account join flow",
  operationId: "getAccountInvitation",
  request: {
    params: invitationTokenParamsSchema,
  },
  responses: {
    200: {
      description: "Invitation details returned",
      content: {
        "application/json": {
          schema: InvitationDetailsResponseSchema,
        },
      },
    },
    404: {
      description: "Invitation not found",
      content: {
        "application/json": {
          schema: ErrorResponseSchema,
        },
      },
    },
  },
});

registry.registerPath({
  method: "post",
  path: "/api/v1/auth/invitations/{invitationToken}/accept",
  tags: ["Auth"],
  summary: "Accept an invitation and establish a session for the joined account",
  operationId: "acceptAccountInvitation",
  request: {
    params: invitationTokenParamsSchema,
    body: {
      required: true,
      content: {
        "application/json": {
          schema: InvitationAcceptRequestSchema,
        },
      },
    },
  },
  responses: {
    200: {
      description: "Invitation accepted and session established",
      content: {
        "application/json": {
          schema: LoginResponseSchema,
        },
      },
    },
    401: {
      description: "Invitation email mismatch or invalid credentials",
      content: {
        "application/json": {
          schema: ErrorResponseSchema,
        },
      },
    },
    404: {
      description: "Invitation not found",
      content: {
        "application/json": {
          schema: ErrorResponseSchema,
        },
      },
    },
    409: {
      description: "Invitation is no longer valid",
      content: {
        "application/json": {
          schema: ErrorResponseSchema,
        },
      },
    },
  },
});

registry.registerPath({
  method: "get",
  path: "/api/v1/account/users",
  tags: ["Account"],
  summary: "List active account users and invitations",
  operationId: "listAccountUsers",
  security: [{ [sessionCookieScheme.name]: [] }],
  responses: {
    200: {
      description: "Account users returned",
      content: {
        "application/json": {
          schema: AccountUsersResponseSchema,
        },
      },
    },
    401: {
      description: "Authentication required",
      content: {
        "application/json": {
          schema: ErrorResponseSchema,
        },
      },
    },
  },
});

registry.registerPath({
  method: "get",
  path: "/api/v1/account/accounts",
  tags: ["Account"],
  summary: "List accessible accounts for the current user",
  operationId: "listAccessibleAccounts",
  security: [{ [sessionCookieScheme.name]: [] }],
  responses: {
    200: {
      description: "Accessible accounts returned",
      content: {
        "application/json": {
          schema: AccessibleAccountsResponseSchema,
        },
      },
    },
    401: {
      description: "Authentication required",
      content: {
        "application/json": {
          schema: ErrorResponseSchema,
        },
      },
    },
  },
});

registry.registerPath({
  method: "post",
  path: "/api/v1/account/invitations",
  tags: ["Account"],
  summary: "Create an account invitation",
  operationId: "createAccountInvitation",
  security: [{ [sessionCookieScheme.name]: [] }],
  request: {
    body: {
      required: true,
      content: {
        "application/json": {
          schema: AccountInvitationCreateRequestSchema,
        },
      },
    },
  },
  responses: {
    201: {
      description: "Invitation created",
      content: {
        "application/json": {
          schema: CreateAccountInvitationResponseSchema,
        },
      },
    },
    401: {
      description: "Authentication required",
      content: {
        "application/json": {
          schema: ErrorResponseSchema,
        },
      },
    },
    409: {
      description: "Invitation already pending or user already has access",
      content: {
        "application/json": {
          schema: ErrorResponseSchema,
        },
      },
    },
  },
});

registry.registerPath({
  method: "post",
  path: "/api/v1/account/switch",
  tags: ["Account"],
  summary: "Switch the current session to another accessible account",
  operationId: "switchAccount",
  security: [{ [sessionCookieScheme.name]: [] }],
  request: {
    body: {
      required: true,
      content: {
        "application/json": {
          schema: accountSwitchSchema,
        },
      },
    },
  },
  responses: {
    200: {
      description: "Account switched",
      content: {
        "application/json": {
          schema: LoginResponseSchema,
        },
      },
    },
    401: {
      description: "Authentication required",
      content: {
        "application/json": {
          schema: ErrorResponseSchema,
        },
      },
    },
  },
});

registry.registerPath({
  method: "delete",
  path: "/api/v1/account/users/{membershipId}",
  tags: ["Account"],
  summary: "Remove account user access",
  operationId: "removeAccountUser",
  security: [{ [sessionCookieScheme.name]: [] }],
  request: {
    params: accountMembershipParamsSchema,
  },
  responses: {
    204: {
      description: "Account user removed",
    },
    401: {
      description: "Authentication required",
      content: {
        "application/json": {
          schema: ErrorResponseSchema,
        },
      },
    },
    403: {
      description: "Owner access required",
      content: {
        "application/json": {
          schema: ErrorResponseSchema,
        },
      },
    },
    404: {
      description: "Membership not found",
      content: {
        "application/json": {
          schema: ErrorResponseSchema,
        },
      },
    },
    409: {
      description: "Membership cannot be removed",
      content: {
        "application/json": {
          schema: ErrorResponseSchema,
        },
      },
    },
  },
});

registry.registerPath({
  method: "get",
  path: "/api/v1/account/workspaces/{workspaceId}/token",
  tags: ["Account"],
  summary: "Reveal the workspace API token for manual SDK or CLI use",
  operationId: "getWorkspaceApiToken",
  security: [{ [sessionCookieScheme.name]: [] }],
  request: {
    params: workspaceParamsSchema,
  },
  responses: {
    200: {
      description: "Workspace token returned",
      content: {
        "application/json": {
          schema: WorkspaceTokenResponseSchema,
        },
      },
    },
    400: {
      description: "Invalid workspace id",
      content: {
        "application/json": {
          schema: ErrorResponseSchema,
        },
      },
    },
    401: {
      description: "Authentication required",
      content: {
        "application/json": {
          schema: ErrorResponseSchema,
        },
      },
    },
    403: {
      description: "Workspace token no longer resolves to an active workspace",
      content: {
        "application/json": {
          schema: ErrorResponseSchema,
        },
      },
    },
    429: {
      description: "Token reveal temporarily rate limited",
      content: {
        "application/json": {
          schema: RateLimitExceededSchema,
        },
      },
    },
  },
});

registry.registerPath({
  method: "post",
  path: "/api/v1/account/workspaces/{workspaceId}/token/rotate",
  tags: ["Account"],
  summary: "Rotate the workspace API token",
  operationId: "rotateWorkspaceApiToken",
  security: [{ [sessionCookieScheme.name]: [] }],
  request: {
    params: workspaceParamsSchema,
  },
  responses: {
    200: {
      description: "Workspace token rotated",
      content: {
        "application/json": {
          schema: WorkspaceTokenResponseSchema,
        },
      },
    },
    400: {
      description: "Invalid workspace id",
      content: {
        "application/json": {
          schema: ErrorResponseSchema,
        },
      },
    },
    401: {
      description: "Authentication required",
      content: {
        "application/json": {
          schema: ErrorResponseSchema,
        },
      },
    },
    403: {
      description: "Workspace does not belong to the current account",
      content: {
        "application/json": {
          schema: ErrorResponseSchema,
        },
      },
    },
    429: {
      description: "Too many rotate attempts",
      content: {
        "application/json": {
          schema: ErrorResponseSchema,
        },
      },
    },
    503: {
      description: "Workspace token secret is not configured",
      content: {
        "application/json": {
          schema: ErrorResponseSchema,
        },
      },
    },
  },
});

registry.registerPath({
  method: "get",
  path: "/api/v1/workspace/mcp/context",
  tags: ["Workspace"],
  summary: "Get workspace MCP context for a bearer-authenticated workspace token",
  operationId: "getWorkspaceMcpContext",
  security: [{ [bearerAuthScheme.name]: [] }],
  responses: {
    200: {
      description: "Workspace MCP context returned",
      content: {
        "application/json": {
          schema: WorkspaceMcpContextResponseSchema,
        },
      },
    },
    401: {
      description: "Authentication required",
      content: {
        "application/json": {
          schema: ErrorResponseSchema,
        },
      },
    },
    403: {
      description: "Workspace token no longer resolves to an active workspace",
      content: {
        "application/json": {
          schema: ErrorResponseSchema,
        },
      },
    },
  },
});

registry.registerPath({
  method: "get",
  path: "/api/v1/workspace",
  tags: ["Workspace"],
  summary: "List workspaces for the authenticated account",
  operationId: "listWorkspaces",
  security: [{ [sessionCookieScheme.name]: [] }],
  responses: {
    200: {
      description: "Workspaces returned",
      content: {
        "application/json": {
          schema: WorkspaceListResponseSchema,
        },
      },
    },
    401: {
      description: "Authentication required",
      content: {
        "application/json": {
          schema: ErrorResponseSchema,
        },
      },
    },
  },
});

registry.registerPath({
  method: "get",
  path: "/api/v1/workspace/summary",
  tags: ["Workspace"],
  summary: "Get lightweight workspace dashboard summary",
  operationId: "getWorkspaceSummary",
  security: [{ [bearerAuthScheme.name]: [] }],
  responses: {
    200: {
      description: "Workspace summary returned",
      content: {
        "application/json": {
          schema: WorkspaceSummaryResponseSchema,
        },
      },
    },
    401: {
      description: "Authentication required",
      content: {
        "application/json": {
          schema: ErrorResponseSchema,
        },
      },
    },
  },
});

registry.registerPath({
  method: "get",
  path: "/api/v1/workspace/resolve/{workspaceKey}",
  tags: ["Workspace"],
  summary: "Resolve a workspace public route key for the authenticated user",
  operationId: "resolveWorkspaceRouteKey",
  security: [{ [sessionCookieScheme.name]: [] }],
  request: {
    params: workspaceKeyParamsSchema,
  },
  responses: {
    200: {
      description: "Workspace route key resolved",
      content: {
        "application/json": {
          schema: WorkspaceRouteResolutionResponseSchema,
        },
      },
    },
    401: {
      description: "Authentication required",
      content: {
        "application/json": {
          schema: ErrorResponseSchema,
        },
      },
    },
    404: {
      description: "Workspace not found or inaccessible",
      content: {
        "application/json": {
          schema: ErrorResponseSchema,
        },
      },
    },
  },
});

registry.registerPath({
  method: "post",
  path: "/api/v1/workspace",
  tags: ["Workspace"],
  summary: "Create a workspace",
  operationId: "createWorkspace",
  security: [{ [sessionCookieScheme.name]: [] }],
  request: {
    body: {
      required: true,
      content: {
        "application/json": {
          schema: WorkspaceCreateRequestSchema,
        },
      },
    },
  },
  responses: {
    201: {
      description: "Workspace created",
      content: {
        "application/json": {
          schema: WorkspaceSchema,
        },
      },
    },
    400: {
      description: "Request validation failed",
      content: {
        "application/json": {
          schema: ErrorResponseSchema,
        },
      },
    },
    401: {
      description: "Authentication required",
      content: {
        "application/json": {
          schema: ErrorResponseSchema,
        },
      },
    },
  },
});

registry.registerPath({
  method: "patch",
  path: "/api/v1/workspace/{workspaceId}",
  tags: ["Workspace"],
  summary: "Rename a workspace",
  operationId: "renameWorkspace",
  security: [{ [sessionCookieScheme.name]: [] }],
  request: {
    params: workspaceParamsSchema,
    body: {
      required: true,
      content: {
        "application/json": {
          schema: WorkspaceRenameRequestSchema,
        },
      },
    },
  },
  responses: {
    200: {
      description: "Workspace renamed",
      content: {
        "application/json": {
          schema: WorkspaceSchema,
        },
      },
    },
    400: {
      description: "Request validation failed",
      content: {
        "application/json": {
          schema: ErrorResponseSchema,
        },
      },
    },
    401: {
      description: "Authentication required",
      content: {
        "application/json": {
          schema: ErrorResponseSchema,
        },
      },
    },
    404: {
      description: "Workspace not found",
      content: {
        "application/json": {
          schema: ErrorResponseSchema,
        },
      },
    },
  },
});

registry.registerPath({
  method: "delete",
  path: "/api/v1/workspace/{workspaceId}",
  tags: ["Workspace"],
  summary: "Delete a workspace",
  operationId: "deleteWorkspace",
  security: [{ [sessionCookieScheme.name]: [] }],
  request: {
    params: workspaceParamsSchema,
  },
  responses: {
    204: {
      description: "Workspace deleted",
    },
    400: {
      description: "Request validation failed",
      content: {
        "application/json": {
          schema: ErrorResponseSchema,
        },
      },
    },
    401: {
      description: "Authentication required",
      content: {
        "application/json": {
          schema: ErrorResponseSchema,
        },
      },
    },
    404: {
      description: "Workspace not found",
      content: {
        "application/json": {
          schema: ErrorResponseSchema,
        },
      },
    },
  },
});

registry.registerPath({
  method: "get",
  path: "/api/v1/settings",
  tags: ["Settings"],
  summary: "Get shared workspace platform settings",
  operationId: "getPlatformSettings",
  security: [{ [bearerAuthScheme.name]: [] }],
  responses: {
    200: {
      description: "Shared assistant, retrieval, and channel settings returned",
      content: {
        "application/json": {
          schema: PlatformSettingsResponseSchema,
        },
      },
    },
    401: {
      description: "Authentication required",
      content: {
        "application/json": {
          schema: ErrorResponseSchema,
        },
      },
    },
    404: {
      description: "Workspace not found",
      content: {
        "application/json": {
          schema: ErrorResponseSchema,
        },
      },
    },
  },
});

registry.registerPath({
  method: "put",
  path: "/api/v1/settings",
  tags: ["Settings"],
  summary: "Merge-update shared workspace platform settings",
  operationId: "updatePlatformSettings",
  security: [{ [bearerAuthScheme.name]: [] }],
  request: {
    body: {
      required: true,
      content: {
        "application/json": {
          schema: UpdatePlatformSettingsRequestSchema,
        },
      },
    },
  },
  responses: {
    200: {
      description: "Shared settings updated",
      content: {
        "application/json": {
          schema: PlatformSettingsResponseSchema,
        },
      },
    },
    400: {
      description: "Request validation failed",
      content: {
        "application/json": {
          schema: ErrorResponseSchema,
        },
      },
    },
    401: {
      description: "Authentication required",
      content: {
        "application/json": {
          schema: ErrorResponseSchema,
        },
      },
    },
    404: {
      description: "Workspace not found",
      content: {
        "application/json": {
          schema: ErrorResponseSchema,
        },
      },
    },
  },
});

registry.registerPath({
  method: "get",
  path: "/api/v1/settings/retrieval",
  tags: ["Settings"],
  summary: "Get retrieval settings for the authenticated workspace",
  operationId: "getRetrievalSettings",
  security: [{ [bearerAuthScheme.name]: [] }],
  responses: {
    200: {
      description: "Retrieval settings returned",
      content: {
        "application/json": {
          schema: RetrievalSettingsSchema,
        },
      },
    },
    401: {
      description: "Authentication required",
      content: {
        "application/json": {
          schema: ErrorResponseSchema,
        },
      },
    },
  },
});

registry.registerPath({
  method: "put",
  path: "/api/v1/settings/retrieval",
  tags: ["Settings"],
  summary: "Update retrieval settings for the authenticated workspace",
  operationId: "updateRetrievalSettings",
  security: [{ [bearerAuthScheme.name]: [] }],
  request: {
    body: {
      required: true,
      content: {
        "application/json": {
          schema: UpdateRetrievalSettingsRequestSchema,
        },
      },
    },
  },
  responses: {
    200: {
      description: "Updated retrieval settings",
      content: {
        "application/json": {
          schema: RetrievalSettingsSchema,
        },
      },
    },
    400: {
      description: "Request validation failed",
      content: {
        "application/json": {
          schema: ErrorResponseSchema,
        },
      },
    },
    401: {
      description: "Authentication required",
      content: {
        "application/json": {
          schema: ErrorResponseSchema,
        },
      },
    },
  },
});

registry.registerPath({
  method: "get",
  path: "/api/v1/settings/ingestion",
  tags: ["Settings"],
  summary: "Get ingestion settings for the authenticated workspace",
  operationId: "getIngestionSettings",
  security: [{ [bearerAuthScheme.name]: [] }],
  responses: {
    200: {
      description: "Ingestion settings returned",
      content: {
        "application/json": {
          schema: IngestionSettingsSchema,
        },
      },
    },
    401: {
      description: "Authentication required",
      content: {
        "application/json": {
          schema: ErrorResponseSchema,
        },
      },
    },
  },
});

registry.registerPath({
  method: "put",
  path: "/api/v1/settings/ingestion",
  tags: ["Settings"],
  summary: "Update ingestion settings for the authenticated workspace",
  operationId: "updateIngestionSettings",
  security: [{ [bearerAuthScheme.name]: [] }],
  request: {
    body: {
      required: true,
      content: {
        "application/json": {
          schema: UpdateIngestionSettingsRequestSchema,
        },
      },
    },
  },
  responses: {
    200: {
      description: "Updated ingestion settings",
      content: {
        "application/json": {
          schema: IngestionSettingsSchema,
        },
      },
    },
    400: {
      description: "Request validation failed",
      content: {
        "application/json": {
          schema: ErrorResponseSchema,
        },
      },
    },
    401: {
      description: "Authentication required",
      content: {
        "application/json": {
          schema: ErrorResponseSchema,
        },
      },
    },
  },
});

registry.registerPath({
  method: "post",
  path: "/api/v1/settings/ingestion/reprocess",
  tags: ["Settings"],
  summary: "Queue eligible workspace documents for reprocessing using current ingestion settings",
  operationId: "reprocessWorkspaceIngestion",
  security: [{ [bearerAuthScheme.name]: [] }],
  responses: {
    202: {
      description: "Workspace documents accepted for reprocessing",
      content: {
        "application/json": {
          schema: WorkspaceIngestionReprocessResponseSchema,
        },
      },
    },
    401: {
      description: "Authentication required",
      content: {
        "application/json": {
          schema: ErrorResponseSchema,
        },
      },
    },
  },
});

registry.registerPath({
  method: "get",
  path: "/api/v1/settings/general",
  tags: ["Settings"],
  summary: "Get general workspace settings",
  operationId: "getGeneralSettings",
  security: [{ [bearerAuthScheme.name]: [] }],
  responses: {
    200: {
      description: "General settings returned",
      content: {
        "application/json": {
          schema: GeneralSettingsResponseSchema,
        },
      },
    },
    401: {
      description: "Authentication required",
      content: {
        "application/json": {
          schema: ErrorResponseSchema,
        },
      },
    },
    404: {
      description: "Workspace not found",
      content: {
        "application/json": {
          schema: FlatErrorResponseSchema,
        },
      },
    },
  },
});

registry.registerPath({
  method: "put",
  path: "/api/v1/settings/general",
  tags: ["Settings"],
  summary: "Update general workspace settings",
  operationId: "updateGeneralSettings",
  security: [{ [bearerAuthScheme.name]: [] }],
  request: {
    body: {
      required: true,
      content: {
        "application/json": {
          schema: UpdateGeneralSettingsRequestSchema,
        },
      },
    },
  },
  responses: {
    200: {
      description: "Updated general settings",
      content: {
        "application/json": {
          schema: GeneralSettingsResponseSchema,
        },
      },
    },
    400: {
      description: "Request validation failed",
      content: {
        "application/json": {
          schema: ErrorResponseSchema,
        },
      },
    },
    401: {
      description: "Authentication required",
      content: {
        "application/json": {
          schema: ErrorResponseSchema,
        },
      },
    },
    404: {
      description: "Workspace not found",
      content: {
        "application/json": {
          schema: FlatErrorResponseSchema,
        },
      },
    },
  },
});

registry.registerPath({
  method: "post",
  path: "/api/v1/retrieval/search",
  tags: ["Retrieval"],
  summary: "Search workspace evidence without assistant behavior",
  operationId: "searchRetrievalEvidence",
  security: [{ [bearerAuthScheme.name]: [] }],
  request: {
    body: {
      required: true,
      content: {
        "application/json": {
          schema: RetrievalSearchRequestSchema,
        },
      },
    },
  },
  responses: {
    200: {
      description: "Retrieval evidence returned",
      content: {
        "application/json": {
          schema: RetrievalSearchResponseSchema,
        },
      },
    },
    400: {
      description: "Request validation failed",
      content: {
        "application/json": {
          schema: ErrorResponseSchema,
        },
      },
    },
    401: {
      description: "Authentication required",
      content: {
        "application/json": {
          schema: ErrorResponseSchema,
        },
      },
    },
  },
});

registry.registerPath({
  method: "post",
  path: "/api/v1/retrieval/answer",
  tags: ["Retrieval"],
  summary: "Generate a retrieval-only grounded answer",
  operationId: "createRetrievalAnswer",
  security: [{ [bearerAuthScheme.name]: [] }],
  request: {
    body: {
      required: true,
      content: {
        "application/json": {
          schema: RetrievalAnswerRequestSchema,
        },
      },
    },
  },
  responses: {
    200: {
      description: "Retrieval answer or unsupported retrieval-scoped result returned",
      content: {
        "application/json": {
          schema: RetrievalAnswerResponseSchema,
        },
      },
    },
    400: {
      description: "Request validation failed",
      content: {
        "application/json": {
          schema: ErrorResponseSchema,
        },
      },
    },
    401: {
      description: "Authentication required",
      content: {
        "application/json": {
          schema: ErrorResponseSchema,
        },
      },
    },
  },
});

registry.registerPath({
  method: "post",
  path: "/api/v1/document/search",
  tags: ["Documents"],
  summary: "Search documents for the authenticated workspace",
  operationId: "searchDocuments",
  security: [{ [bearerAuthScheme.name]: [] }],
  request: {
    body: {
      required: true,
      content: {
        "application/json": {
          schema: DocumentSearchRequestSchema,
        },
      },
    },
  },
  responses: {
    200: {
      description: "Search results returned",
      content: {
        "application/json": {
          schema: DocumentSearchResponseSchema,
        },
      },
    },
    400: {
      description: "Request validation failed",
      content: {
        "application/json": {
          schema: ErrorResponseSchema,
        },
      },
    },
    401: {
      description: "Authentication required",
      content: {
        "application/json": {
          schema: ErrorResponseSchema,
        },
      },
    },
  },
});

registry.registerPath({
  method: "get",
  path: "/api/v1/document/search/history",
  tags: ["Documents"],
  summary: "List document search history for the authenticated workspace",
  operationId: "listDocumentSearchHistory",
  security: [{ [bearerAuthScheme.name]: [] }],
  request: {
    query: z.object({
      limit: z.number().int().min(1).max(100).optional(),
      offset: z.number().int().min(0).optional(),
      cursor: z.string().min(1).optional(),
    }),
  },
  responses: {
    200: {
      description: "Document search history returned",
      content: {
        "application/json": {
          schema: DocumentSearchHistoryListResponseSchema,
        },
      },
    },
    401: {
      description: "Authentication required",
      content: {
        "application/json": {
          schema: ErrorResponseSchema,
        },
      },
    },
  },
});

registry.registerPath({
  method: "get",
  path: "/api/v1/document/search/history/{searchId}",
  tags: ["Documents"],
  summary: "Replay one historical document search",
  operationId: "getDocumentSearchHistory",
  security: [{ [bearerAuthScheme.name]: [] }],
  request: {
    params: documentSearchHistoryParamsSchema,
  },
  responses: {
    200: {
      description: "Document search replay returned",
      content: {
        "application/json": {
          schema: DocumentSearchResponseSchema,
        },
      },
    },
    401: {
      description: "Authentication required",
      content: {
        "application/json": {
          schema: ErrorResponseSchema,
        },
      },
    },
    404: {
      description: "Document search not found",
      content: {
        "application/json": {
          schema: ErrorResponseSchema,
        },
      },
    },
  },
});

registry.registerPath({
  method: "get",
  path: "/api/v1/document/",
  tags: ["Documents"],
  summary: "List documents for the authenticated workspace",
  operationId: "listDocuments",
  security: [{ [bearerAuthScheme.name]: [] }],
  request: {
    query: z.object({
      limit: z.number().int().min(1).max(100).optional(),
      offset: z.number().int().min(0).optional(),
      cursor: z.string().min(1).optional(),
    }),
  },
  responses: {
    200: {
      description: "Documents returned",
      content: {
        "application/json": {
          schema: DocumentListResponseSchema,
        },
      },
    },
    401: {
      description: "Authentication required",
      content: {
        "application/json": {
          schema: ErrorResponseSchema,
        },
      },
    },
  },
});

registry.registerPath({
  method: "post",
  path: "/api/v1/document/",
  tags: ["Documents"],
  summary: "Queue a document for background processing",
  operationId: "createDocument",
  security: [{ [bearerAuthScheme.name]: [] }],
  request: {
    body: {
      required: true,
      content: {
        "application/json": {
          schema: DocumentCreateRequestSchema,
        },
      },
    },
  },
  responses: {
    202: {
      description: "Document accepted for processing",
      content: {
        "application/json": {
          schema: DocumentOperationResponseSchema,
        },
      },
    },
    400: {
      description: "Request validation failed",
      content: {
        "application/json": {
          schema: ErrorResponseSchema,
        },
      },
    },
    401: {
      description: "Authentication required",
      content: {
        "application/json": {
          schema: ErrorResponseSchema,
        },
      },
    },
  },
});

registry.registerPath({
  method: "get",
  path: "/api/v1/document/{documentId}",
  tags: ["Documents"],
  summary: "Get a document",
  operationId: "getDocument",
  security: [{ [bearerAuthScheme.name]: [] }],
  request: {
    params: documentParamsSchema,
  },
  responses: {
    200: {
      description: "Document returned",
      content: {
        "application/json": {
          schema: DocumentDetailsSchema,
        },
      },
    },
    401: {
      description: "Authentication required",
      content: {
        "application/json": {
          schema: ErrorResponseSchema,
        },
      },
    },
    404: {
      description: "Document not found",
      content: {
        "application/json": {
          schema: ErrorResponseSchema,
        },
      },
    },
  },
});

registry.registerPath({
  method: "put",
  path: "/api/v1/document/{documentId}",
  tags: ["Documents"],
  summary: "Update and requeue a document",
  operationId: "updateDocument",
  security: [{ [bearerAuthScheme.name]: [] }],
  request: {
    params: documentParamsSchema,
    body: {
      required: true,
      content: {
        "application/json": {
          schema: documentSchema,
        },
      },
    },
  },
  responses: {
    202: {
      description: "Document accepted for reprocessing",
      content: {
        "application/json": {
          schema: DocumentOperationResponseSchema,
        },
      },
    },
    400: {
      description: "Request validation failed",
      content: {
        "application/json": {
          schema: ErrorResponseSchema,
        },
      },
    },
    401: {
      description: "Authentication required",
      content: {
        "application/json": {
          schema: ErrorResponseSchema,
        },
      },
    },
    404: {
      description: "Document not found",
      content: {
        "application/json": {
          schema: ErrorResponseSchema,
        },
      },
    },
  },
});

registry.registerPath({
  method: "post",
  path: "/api/v1/document/{documentId}/reprocess",
  tags: ["Documents"],
  summary: "Requeue an existing document for processing",
  operationId: "reprocessDocument",
  security: [{ [bearerAuthScheme.name]: [] }],
  request: {
    params: documentParamsSchema,
  },
  responses: {
    202: {
      description: "Document accepted for reprocessing",
      content: {
        "application/json": {
          schema: DocumentOperationResponseSchema,
        },
      },
    },
    401: {
      description: "Authentication required",
      content: {
        "application/json": {
          schema: ErrorResponseSchema,
        },
      },
    },
    404: {
      description: "Document not found",
      content: {
        "application/json": {
          schema: ErrorResponseSchema,
        },
      },
    },
  },
});

registry.registerPath({
  method: "delete",
  path: "/api/v1/document/{documentId}",
  tags: ["Documents"],
  summary: "Delete a document",
  operationId: "deleteDocument",
  security: [{ [bearerAuthScheme.name]: [] }],
  request: {
    params: documentParamsSchema,
  },
  responses: {
    204: {
      description: "Document deleted",
    },
    401: {
      description: "Authentication required",
      content: {
        "application/json": {
          schema: ErrorResponseSchema,
        },
      },
    },
    404: {
      description: "Document not found",
      content: {
        "application/json": {
          schema: ErrorResponseSchema,
        },
      },
    },
  },
});

registry.registerPath({
  method: "post",
  path: "/api/v1/assistant/chat",
  tags: ["Assistant"],
  summary: "Run human-facing assistant chat",
  operationId: "createAssistantChatResponse",
  security: [{ [bearerAuthScheme.name]: [] }],
  request: {
    body: {
      required: true,
      content: {
        "application/json": {
          schema: AssistantChatRequestSchema,
        },
      },
    },
  },
  responses: {
    200: {
      description: "Chat response returned as JSON or SSE",
      content: {
        "application/json": {
          schema: AssistantChatResponseSchema,
        },
        "text/event-stream": {
          schema: z.string().openapi("AssistantChatSseStream"),
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
          schema: ErrorResponseSchema,
        },
      },
    },
    401: {
      description: "Authentication required",
      content: {
        "application/json": {
          schema: ErrorResponseSchema,
        },
      },
    },
    404: {
      description: "Conversation not found",
      content: {
        "application/json": {
          schema: ErrorResponseSchema,
        },
      },
    },
  },
});

registry.registerPath({
  method: "get",
  path: "/api/v1/history",
  tags: ["History"],
  summary: "List merged chat and document search history",
  operationId: "listHistory",
  security: [{ [bearerAuthScheme.name]: [] }],
  request: {
    query: z.object({
      limit: z.number().int().min(1).max(100).optional(),
      offset: z.number().int().min(0).optional(),
    }),
  },
  responses: {
    200: {
      description: "Merged history items",
      content: {
        "application/json": {
          schema: HistoryItemsResponseSchema,
        },
      },
    },
    401: {
      description: "Authentication required",
      content: {
        "application/json": {
          schema: ErrorResponseSchema,
        },
      },
    },
  },
});

registry.registerPath({
  method: "get",
  path: "/api/v1/history/chat",
  tags: ["History"],
  summary: "List saved assistant conversations",
  operationId: "listChatHistory",
  security: [{ [bearerAuthScheme.name]: [] }],
  request: {
    query: z.object({
      limit: z.number().int().min(1).max(100).optional(),
      offset: z.number().int().min(0).optional(),
      cursor: z.string().min(1).optional(),
    }),
  },
  responses: {
    200: {
      description: "Chat history summaries",
      content: {
        "application/json": {
          schema: ChatHistoryListResponseSchema,
        },
      },
    },
    401: {
      description: "Authentication required",
      content: {
        "application/json": {
          schema: ErrorResponseSchema,
        },
      },
    },
  },
});

registry.registerPath({
  method: "get",
  path: "/api/v1/history/search",
  tags: ["History"],
  summary: "List document search history for the authenticated workspace",
  operationId: "listHistorySearches",
  security: [{ [bearerAuthScheme.name]: [] }],
  request: {
    query: z.object({
      limit: z.number().int().min(1).max(100).optional(),
      offset: z.number().int().min(0).optional(),
      cursor: z.string().min(1).optional(),
    }),
  },
  responses: {
    200: {
      description: "Document search history returned",
      content: {
        "application/json": {
          schema: DocumentSearchHistoryListResponseSchema,
        },
      },
    },
    401: {
      description: "Authentication required",
      content: {
        "application/json": {
          schema: ErrorResponseSchema,
        },
      },
    },
  },
});

registry.registerPath({
  method: "get",
  path: "/api/v1/history/chat/{conversationId}",
  tags: ["History"],
  summary: "Get a saved assistant conversation and its debug metadata",
  operationId: "getHistoryConversation",
  security: [{ [bearerAuthScheme.name]: [] }],
  request: {
    params: conversationParamsSchema,
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
          schema: ChatConversationDetailSchema,
        },
      },
    },
    400: {
      description: "Request validation failed",
      content: {
        "application/json": {
          schema: ErrorResponseSchema,
        },
      },
    },
    401: {
      description: "Authentication required",
      content: {
        "application/json": {
          schema: ErrorResponseSchema,
        },
      },
    },
    404: {
      description: "Conversation not found",
      content: {
        "application/json": {
          schema: ErrorResponseSchema,
        },
      },
    },
  },
});

registry.registerPath({
  method: "get",
  path: "/api/v1/history/{conversationId}",
  tags: ["History"],
  summary: "Get a saved assistant conversation and its debug metadata",
  description: "Deprecated compatibility alias. Prefer `/api/v1/history/chat/{conversationId}`.",
  operationId: "getLegacyHistoryConversation",
  deprecated: true,
  security: [{ [bearerAuthScheme.name]: [] }],
  request: {
    params: conversationParamsSchema,
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
          schema: ChatConversationDetailSchema,
        },
      },
    },
    400: {
      description: "Request validation failed",
      content: {
        "application/json": {
          schema: ErrorResponseSchema,
        },
      },
    },
    401: {
      description: "Authentication required",
      content: {
        "application/json": {
          schema: ErrorResponseSchema,
        },
      },
    },
    404: {
      description: "Conversation not found",
      content: {
        "application/json": {
          schema: ErrorResponseSchema,
        },
      },
    },
  },
});

registry.registerPath({
  method: "get",
  path: "/api/v1/history/search/{searchId}",
  tags: ["History"],
  summary: "Replay one historical document search",
  operationId: "getHistorySearch",
  security: [{ [bearerAuthScheme.name]: [] }],
  request: {
    params: documentSearchHistoryParamsSchema,
  },
  responses: {
    200: {
      description: "Document search replay returned",
      content: {
        "application/json": {
          schema: DocumentSearchResponseSchema,
        },
      },
    },
    400: {
      description: "Request validation failed",
      content: {
        "application/json": {
          schema: ErrorResponseSchema,
        },
      },
    },
    401: {
      description: "Authentication required",
      content: {
        "application/json": {
          schema: ErrorResponseSchema,
        },
      },
    },
    404: {
      description: "Search history entry not found",
      content: {
        "application/json": {
          schema: ErrorResponseSchema,
        },
      },
    },
  },
});

registry.registerPath({
  method: "get",
  path: "/api/v1/connectors",
  tags: ["Connectors"],
  summary: "List connectors for the authenticated workspace",
  operationId: "listConnectors",
  security: [{ [bearerAuthScheme.name]: [] }],
  responses: {
    200: {
      description: "Connectors returned",
      content: {
        "application/json": {
          schema: ConnectorListResponseSchema,
        },
      },
    },
    401: {
      description: "Authentication required",
      content: {
        "application/json": {
          schema: ErrorResponseSchema,
        },
      },
    },
  },
});

registry.registerPath({
  method: "get",
  path: "/api/v1/connectors/{connectorId}",
  tags: ["Connectors"],
  summary: "Get connector detail",
  operationId: "getConnectorDetail",
  security: [{ [bearerAuthScheme.name]: [] }],
  request: {
    params: connectorIdPathParamsSchema,
  },
  responses: {
    200: {
      description: "Connector detail returned",
      content: {
        "application/json": {
          schema: ConnectorDetailSchema,
        },
      },
    },
    401: {
      description: "Authentication required",
      content: {
        "application/json": {
          schema: ErrorResponseSchema,
        },
      },
    },
    404: {
      description: "Connector not found",
      content: {
        "application/json": {
          schema: z.object({ error: z.literal("Connector not found") }).openapi("ConnectorNotFoundResponse"),
        },
      },
    },
  },
});

registry.registerPath({
  method: "put",
  path: "/api/v1/connectors/{connectorId}",
  tags: ["Connectors"],
  summary: "Save connector config",
  operationId: "updateConnectorConfig",
  security: [{ [bearerAuthScheme.name]: [] }],
  request: {
    params: connectorIdPathParamsSchema,
    body: {
      required: true,
      content: {
        "application/json": {
          schema: ConnectorConfigUpdateSchema,
        },
      },
    },
  },
  responses: {
    200: {
      description: "Connector config saved",
      content: {
        "application/json": {
          schema: ConnectorDetailSchema,
        },
      },
    },
    400: {
      description: "Connector config invalid",
      content: {
        "application/json": {
          schema: ConnectorValidationErrorSchema,
        },
      },
    },
    401: {
      description: "Authentication required",
      content: {
        "application/json": {
          schema: ErrorResponseSchema,
        },
      },
    },
    404: {
      description: "Connector not found",
      content: {
        "application/json": {
          schema: z.object({ error: z.literal("Connector not found") }),
        },
      },
    },
    409: {
      description: "Connector identity conflict",
      content: {
        "application/json": {
          schema: ConnectorConflictSchema,
        },
      },
    },
  },
});

registry.registerPath({
  method: "post",
  path: "/api/v1/connectors/{connectorId}/enable",
  tags: ["Connectors"],
  summary: "Enable a connector",
  operationId: "enableConnector",
  security: [{ [bearerAuthScheme.name]: [] }],
  request: {
    params: connectorIdPathParamsSchema,
  },
  responses: {
    200: {
      description: "Connector enabled",
      content: {
        "application/json": {
          schema: ConnectorDetailSchema,
        },
      },
    },
    400: {
      description: "Connector config invalid",
      content: {
        "application/json": {
          schema: ConnectorValidationErrorSchema,
        },
      },
    },
    401: {
      description: "Authentication required",
      content: {
        "application/json": {
          schema: ErrorResponseSchema,
        },
      },
    },
    404: {
      description: "Connector not found",
      content: {
        "application/json": {
          schema: z.object({ error: z.literal("Connector not found") }),
        },
      },
    },
    409: {
      description: "Connector identity conflict",
      content: {
        "application/json": {
          schema: ConnectorConflictSchema,
        },
      },
    },
  },
});

registry.registerPath({
  method: "post",
  path: "/api/v1/connectors/{connectorId}/disable",
  tags: ["Connectors"],
  summary: "Disable a connector",
  operationId: "disableConnector",
  security: [{ [bearerAuthScheme.name]: [] }],
  request: {
    params: connectorIdPathParamsSchema,
  },
  responses: {
    200: {
      description: "Connector disabled",
      content: {
        "application/json": {
          schema: ConnectorDetailSchema,
        },
      },
    },
    401: {
      description: "Authentication required",
      content: {
        "application/json": {
          schema: ErrorResponseSchema,
        },
      },
    },
    404: {
      description: "Connector not found",
      content: {
        "application/json": {
          schema: z.object({ error: z.literal("Connector not found") }),
        },
      },
    },
  },
});

registry.registerPath({
  method: "post",
  path: "/api/v1/public/chat/{token}",
  tags: ["Assistant"],
  summary: "Send a public chat message",
  operationId: "createPublicChatResponse",
  security: [{ [anonymousSessionCookieScheme.name]: [] }],
  request: {
    params: tokenPathParamsSchema,
    body: {
      required: true,
      content: {
        "application/json": {
          schema: PublicChatRequestSchema,
        },
      },
    },
  },
  responses: {
    200: {
      description: "Public chat response returned as JSON or SSE",
      content: {
        "application/json": {
          schema: AssistantChatResponseSchema,
        },
        "text/event-stream": {
          schema: z.string().openapi("PublicChatSseStream"),
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
          schema: ErrorResponseSchema,
        },
      },
    },
    404: {
      description: "Public chat link not found",
      content: {
        "application/json": {
          schema: ErrorResponseSchema,
        },
      },
    },
    429: {
      description: "Rate limit exceeded",
      content: {
        "application/json": {
          schema: RateLimitExceededSchema,
        },
      },
    },
  },
});

registry.registerPath({
  method: "get",
  path: "/api/v1/public/chat/{token}",
  tags: ["Assistant"],
  summary: "List conversations for the current anonymous session",
  operationId: "listPublicChatHistory",
  security: [{ [anonymousSessionCookieScheme.name]: [] }],
  request: {
    params: tokenPathParamsSchema,
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
          schema: PublicConversationListResponseSchema,
        },
      },
    },
    404: {
      description: "Public chat link not found",
      content: {
        "application/json": {
          schema: ErrorResponseSchema,
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
  security: [{ [anonymousSessionCookieScheme.name]: [] }],
  request: {
    params: tokenPathParamsSchema.extend(publicConversationParamsSchema.shape),
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
          schema: ChatConversationDetailSchema,
        },
      },
    },
    400: {
      description: "Request validation failed",
      content: {
        "application/json": {
          schema: ErrorResponseSchema,
        },
      },
    },
    404: {
      description: "Conversation not found",
      content: {
        "application/json": {
          schema: ErrorResponseSchema,
        },
      },
    },
  },
});

export const createOpenApiDocument = (
  options: {
    sessionCookieName?: string;
  } = {},
) => {
  const document = new OpenApiGeneratorV31(registry.definitions).generateDocument({
    openapi: "3.1.0",
    info: {
      title: "radioso API",
      version: "0.1.0",
      description: "Code-generated OpenAPI contract for the radioso backend",
    },
    servers: [
      {
        url: "http://localhost:8080",
        description: "Local development",
      },
    ],
    tags: [
      { name: "System" },
      { name: "Auth" },
      { name: "Account" },
      { name: "Workspace" },
      { name: "Assistant" },
      { name: "History" },
      { name: "Retrieval" },
      { name: "Settings" },
      { name: "Documents" },
      { name: "Connectors" },
    ],
  });

  const sessionCookie = document.components?.securitySchemes?.sessionCookie;
  if (sessionCookie && "name" in sessionCookie) {
    sessionCookie.name = options.sessionCookieName ?? "radioso_session";
  }

  if (document.components?.securitySchemes) {
    delete document.components.securitySchemes.anonymousSessionCookie;
  }

  const publicChatPaths = [
    "/api/v1/public/chat/{token}",
    "/api/v1/public/chat/{token}/history/{conversationId}",
  ] as const;

  const paths = document.paths ?? {};

  for (const path of publicChatPaths) {
    const operations = paths[path];
    if (!operations) {
      continue;
    }

    for (const method of Object.keys(operations) as Array<keyof typeof operations>) {
      const operation = operations[method];
      if (!operation || typeof operation !== "object") {
        continue;
      }

      delete operation.security;
      operation.description = [
        operation.description,
        "Anonymous session continuity is maintained by an HttpOnly cookie set by the server.",
        "The cookie name is workspace-specific (`anon_session_<workspaceId>`) and should be preserved by a browser or cookie jar rather than configured as a fixed client credential.",
      ].filter(Boolean).join("\n\n");
    }
  }

  return document;
};
