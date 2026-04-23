import { z } from "zod";
import {
  OpenAPIRegistry,
  OpenApiGeneratorV31,
  extendZodWithOpenApi,
} from "@asteasolutions/zod-to-openapi";

import {
  emailVerificationResendSchema,
  emailVerificationVerifySchema,
  invitationAcceptSchema,
  invitationTokenParamsSchema,
  loginSchema,
  passwordResetConfirmSchema,
  passwordResetRequestSchema,
  registerSchema,
} from "../routes/authRoutes.js";
import { accountMembershipParamsSchema, accountSwitchSchema, createAccountInvitationSchema } from "../routes/accountUserRoutes.js";
import {
  createWorkspaceSchema,
  renameWorkspaceSchema,
  workspaceParamsSchema,
} from "../routes/workspaceRoutes.js";
import { workspaceMcpContextSchema } from "../routes/mcpContextRoutes.js";
import {
  updateGeneralSettingsSchema,
  updateIngestionSettingsSchema,
  updateSettingsSchema,
} from "../routes/settingsRoutes.js";
import {
  documentParamsSchema,
  documentSchema,
  documentSearchHistoryParamsSchema,
  documentSearchSchema,
} from "../routes/documentRoutes.js";
import { chatSchema, conversationParamsSchema } from "../routes/chatRoutes.js";
import {
  createEvalCaseSchema,
  createEvalDatasetSchema,
  createEvalRunSchema,
  evalComparisonQuerySchema,
  evalDatasetParamsSchema,
  evalRunParamsSchema,
  importChatHistorySchema,
} from "../routes/evalRoutes.js";
import {
  anonymousChatSchema,
  publicConversationParamsSchema,
} from "../routes/publicChatRoutes.js";
import { websiteEmbedLauncherIcons, websiteEmbedLauncherPositions } from "../../../modules/settings/domain/websiteEmbedSettings.js";
import { chunkingStrategyIds } from "../../../modules/retrieval/domain/chunking/chunkingStrategy.js";
import {
  MAX_SUGGESTED_QUESTIONS_COUNT,
  MIN_SUGGESTED_QUESTIONS_COUNT,
  answerSupportPolicies,
  conversationModes,
  metadataRuleEffects,
  metadataRuleOperators,
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
    requiresEmailVerification: z.boolean(),
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
  }),
);

const PasswordResetConfirmResponseSchema = registry.register(
  "PasswordResetConfirmResponse",
  LoginResponseSchema.extend({
    email: z.string().email(),
  }),
);

const WorkspaceSchema = registry.register(
  "Workspace",
  z.object({
    id: z.string().uuid(),
    accountId: z.string().uuid(),
    name: z.string(),
    createdAt: z.string().datetime(),
    updatedAt: z.string().datetime(),
  }),
);

const WorkspaceListResponseSchema = registry.register(
  "WorkspaceListResponse",
  z.object({
    workspaces: z.array(WorkspaceSchema),
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
const PasswordResetRequestSchema = registry.register("PasswordResetRequest", passwordResetRequestSchema);
const PasswordResetConfirmSchema = registry.register("PasswordResetConfirmRequest", passwordResetConfirmSchema);
const EmailVerificationVerifyRequestSchema = registry.register("EmailVerificationVerifyRequest", emailVerificationVerifySchema);
const EmailVerificationResendRequestSchema = registry.register("EmailVerificationResendRequest", emailVerificationResendSchema);
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

const PasswordResetAcceptedResponseSchema = registry.register(
  "PasswordResetAcceptedResponse",
  z.object({
    accepted: z.literal(true),
  }),
);

const EmailVerificationVerifiedResponseSchema = registry.register(
  "EmailVerificationVerifiedResponse",
  z.object({
    verified: z.literal(true),
  }),
);

const RetrievalSettingsSchema = registry.register(
  "RetrievalSettings",
  z.object({
    workspaceId: z.string().uuid(),
    queryRewriteEnabled: z.boolean(),
    semanticRewriteInstructions: z.string().max(2000),
    lexicalRewriteInstructions: z.string().max(2000),
    answerSupportPolicy: z.enum(answerSupportPolicies),
    conversationMode: z.enum(conversationModes),
    suggestedQuestionsEnabled: z.boolean(),
    suggestedQuestionsCount: z.number().int().min(MIN_SUGGESTED_QUESTIONS_COUNT).max(MAX_SUGGESTED_QUESTIONS_COUNT),
    rerankEnabled: z.boolean(),
    vectorTopK: z.number().int().min(1).max(300),
    similarityThreshold: z.number().min(0).max(1),
    rerankTopK: z.number().int().min(1),
    citationDisplayEnabled: z.boolean(),
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
        effect: z.enum(metadataRuleEffects),
        enabled: z.boolean(),
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
    effect: z.enum(metadataRuleEffects),
    enabled: z.boolean(),
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
    assistantRole: z.string(),
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

const PublicEmbedSessionResponseSchema = registry.register(
  "PublicEmbedSessionResponse",
  z.object({
    workspaceName: z.string(),
    publicChatToken: z.string(),
    embedSessionToken: z.string(),
    assistantBootstrapActive: z.boolean(),
    expiresAt: z.string().datetime(),
  }),
);

const PublicEmbedSessionRequestSchema = registry.register(
  "PublicEmbedSessionRequest",
  z.object({
    anonymousSessionId: z.string().uuid().optional(),
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

const RetrievalInfoSchema = registry.register(
  "RetrievalInfo",
  z.object({
    parsedQuery: ParsedQuerySchema.optional(),
    retrievalSubqueries: z.array(RetrievalSubquerySchema).optional(),
    responseLanguagePolicy: z.enum(["match_user_question"]).optional(),
    candidateCounts: CandidateCountsSchema,
    appliedConstraints: z.array(AppliedConstraintSchema).optional(),
    fallbackApplied: z.boolean(),
    rerankStatus: z.enum(["skipped", "applied", "fallback"]),
    rewrite: RewriteInfoSchema.optional(),
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

const ChatResponseSchema = registry.register(
  "ChatResponse",
  z.object({
    conversationId: z.string().uuid(),
    answer: z.string(),
    citations: z.array(CitationSchema).optional(),
    answerSegments: z.array(AnswerSegmentSchema).optional(),
    suggestions: z.array(z.object({
      text: z.string(),
      citation: CitationSchema.optional(),
    })).optional(),
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
  }),
);

const ChatRequestSchema = registry.register("ChatRequest", chatSchema);
const PublicChatRequestSchema = registry.register("PublicChatRequest", anonymousChatSchema);

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
    answerSupportPolicy: z.enum(answerSupportPolicies).optional(),
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
    answerOutcome: z.enum(["grounded_success", "grounded_degraded_unsupported_segments", "no_context_refusal"]).optional(),
    answerSupportPolicy: z.enum(answerSupportPolicies).optional(),
    conversationMode: z.enum(conversationModes).optional(),
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
    suggestions: z.array(z.object({
      text: z.string(),
      citation: CitationSchema.optional(),
    })).optional(),
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

const EvalCaseConversationMessageSchema = registry.register(
  "EvalCaseConversationMessage",
  z.object({
    role: z.enum(["user", "assistant", "system"]),
    content: z.string(),
  }),
);

const EvalCaseExpectationsSchema = registry.register(
  "EvalCaseExpectations",
  z.object({
    expectedDocumentIds: z.array(z.string().uuid()).optional(),
    expectedCitationTitles: z.array(z.string()).optional(),
    expectedRefusalBehavior: z.enum(["refusal", "answer"]).optional(),
    expectedAnswerOutcome: z.enum(["grounded_success", "grounded_degraded_unsupported_segments", "no_context_refusal"]).optional(),
    requiredPhrases: z.array(z.string()).optional(),
    forbiddenPhrases: z.array(z.string()).optional(),
    latencyBudgetMs: z.number().int().positive().optional(),
  }),
);

const EvalDatasetSchema = registry.register(
  "EvalDataset",
  z.object({
    id: z.string().uuid(),
    workspaceId: z.string().uuid(),
    name: z.string(),
    description: z.string(),
    status: z.enum(["active", "archived"]),
    createdByAccountId: z.string().uuid().nullable(),
    createdAt: z.string().datetime(),
    updatedAt: z.string().datetime(),
  }),
);

const EvalDatasetSummarySchema = registry.register(
  "EvalDatasetSummary",
  EvalDatasetSchema.extend({
    caseCount: z.number().int().min(0),
    runCount: z.number().int().min(0),
    lastRunAt: z.string().datetime().nullable(),
  }),
);

const EvalCaseSchema = registry.register(
  "EvalCase",
  z.object({
    id: z.string().uuid(),
    datasetId: z.string().uuid(),
    workspaceId: z.string().uuid(),
    title: z.string(),
    sourceType: z.enum(["manual", "conversation_import"]),
    query: z.string(),
    conversationContext: z.array(EvalCaseConversationMessageSchema),
    expectations: EvalCaseExpectationsSchema,
    provenance: z.record(z.unknown()),
    createdAt: z.string().datetime(),
    updatedAt: z.string().datetime(),
  }),
);

const EvalImportDraftSchema = registry.register(
  "EvalImportDraft",
  z.object({
    title: z.string(),
    query: z.string(),
    conversationContext: z.array(EvalCaseConversationMessageSchema),
    sourceType: z.enum(["manual", "conversation_import"]),
    provenance: z.record(z.unknown()),
    seededExpectations: EvalCaseExpectationsSchema,
    unavailable: z.array(z.string()),
  }),
);

const EvalDatasetListResponseSchema = registry.register(
  "EvalDatasetListResponse",
  z.object({
    datasets: z.array(EvalDatasetSummarySchema),
  }),
);

const EvalDimensionResultSchema = registry.register(
  "EvalDimensionResult",
  z.object({
    verdict: z.enum(["pass", "fail", "unscored"]),
    expected: z.unknown().optional(),
    actual: z.unknown().optional(),
    reason: z.string().optional(),
  }),
);

const EvalCaseScoreSchema = registry.register(
  "EvalCaseScore",
  z.object({
    documentMatch: EvalDimensionResultSchema,
    citationMatch: EvalDimensionResultSchema,
    refusalMatch: EvalDimensionResultSchema,
    answerOutcomeMatch: EvalDimensionResultSchema,
    answerContainsMatch: EvalDimensionResultSchema,
    latencyMatch: EvalDimensionResultSchema,
    overallVerdict: z.enum(["pass", "fail"]),
    reasons: z.array(z.string()),
  }),
);

const EvalReplayDiagnosticsSchema = registry.register(
  "EvalReplayDiagnostics",
  z.object({
    retrievalInfo: RetrievalInfoSchema,
    retrievalTrace: RetrievalTraceSchema.optional(),
    citations: z.array(CitationSchema).optional(),
    answerSegments: z.array(AnswerSegmentSchema).optional(),
    answerOutcome: z.enum(["grounded_success", "grounded_degraded_unsupported_segments", "no_context_refusal"]),
    answerSupportPolicy: z.string().optional(),
    answer: z.string(),
    latencyMs: z.number().int().min(0),
  }),
);

const EvalCaseResultSchema = registry.register(
  "EvalCaseResult",
  z.object({
    caseId: z.string().uuid(),
    status: z.enum(["pass", "fail", "skipped", "invalid"]),
    score: EvalCaseScoreSchema,
    diagnostics: EvalReplayDiagnosticsSchema,
    comparisonOutcome: z.enum(["improved", "regressed", "unchanged", "unscored"]).optional(),
    comparisonReasons: z.array(z.string()).optional(),
  }),
);

const EvalRunSummarySchema = registry.register(
  "EvalRunSummary",
  z.object({
    totalCases: z.number().int().min(0),
    passCount: z.number().int().min(0),
    failCount: z.number().int().min(0),
    skippedCount: z.number().int().min(0),
    invalidCount: z.number().int().min(0),
    improvementCount: z.number().int().min(0),
    regressionCount: z.number().int().min(0),
    unchangedCount: z.number().int().min(0),
  }),
);

const EvalRunSchema = registry.register(
  "EvalRun",
  z.object({
    id: z.string().uuid(),
    datasetId: z.string().uuid(),
    workspaceId: z.string().uuid(),
    label: z.string().nullable(),
    baselineRunId: z.string().uuid().nullable(),
    createdByAccountId: z.string().uuid().nullable(),
    runMetadata: z.record(z.unknown()),
    summary: EvalRunSummarySchema,
    results: z.array(EvalCaseResultSchema),
    startedAt: z.string().datetime(),
    completedAt: z.string().datetime(),
  }),
);

const EvalDatasetDetailSchema = registry.register(
  "EvalDatasetDetail",
  EvalDatasetSchema.extend({
    cases: z.array(EvalCaseSchema),
    runs: z.array(EvalRunSchema),
  }),
);

const EvalRunComparisonSchema = registry.register(
  "EvalRunComparison",
  z.object({
    baselineRunId: z.string().uuid(),
    candidateRunId: z.string().uuid(),
    regressions: z.number().int().min(0),
    improvements: z.number().int().min(0),
    unchanged: z.number().int().min(0),
    unscored: z.number().int().min(0),
    cases: z.array(z.object({
      caseId: z.string().uuid(),
      title: z.string(),
      outcome: z.enum(["improved", "regressed", "unchanged", "unscored"]),
      reasons: z.array(z.string()),
      baselineStatus: z.enum(["pass", "fail", "skipped", "invalid"]).optional(),
      candidateStatus: z.enum(["pass", "fail", "skipped", "invalid"]).optional(),
    })),
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

const PlainTextChallengeSchema = registry.register(
  "PlainTextChallenge",
  z.string(),
);

const EmptySuccessSchema = registry.register(
  "EmptySuccess",
  z.object({}).passthrough(),
);

const tokenPathParamsSchema = z.object({
  token: z.string().min(1),
}).openapi("PublicChatTokenParams");

const connectorIdPathParamsSchema = z.object({
  connectorId: z.string().min(1),
}).openapi("ConnectorIdParams");

const whatsAppWebhookParamsSchema = z.object({
  workspaceId: z.string().uuid(),
}).openapi("WhatsAppWebhookParams");

const whatsAppWebhookQuerySchema = z.object({
  "hub.mode": z.string().optional(),
  "hub.verify_token": z.string().optional(),
  "hub.challenge": z.string().optional(),
}).openapi("WhatsAppWebhookQuery");

const whatsAppWebhookPayloadSchema = registry.register(
  "WhatsAppWebhookPayload",
  z.record(z.unknown()),
);

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
  path: "/api/v1/public/embed/{token}/session",
  tags: ["Public Chat"],
  summary: "Bootstrap an embedded chat session for an approved website origin",
  operationId: "createPublicEmbedSession",
  request: {
    params: tokenPathParamsSchema,
    body: {
      content: {
        "application/json": {
          schema: PublicEmbedSessionRequestSchema,
        },
      },
    },
  },
  responses: {
    200: {
      description: "Embedded chat session bootstrap returned",
      content: {
        "application/json": {
          schema: PublicEmbedSessionResponseSchema,
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
      description: "Origin not allowed",
      content: {
        "application/json": {
          schema: ErrorResponseSchema,
        },
      },
    },
    404: {
      description: "Embedded chat not found",
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
    403: {
      description: "Email verification required before sign-in",
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
  path: "/api/v1/auth/password-reset/request",
  tags: ["Auth"],
  summary: "Request a password reset email",
  operationId: "requestPasswordReset",
  request: {
    body: {
      required: true,
      content: {
        "application/json": {
          schema: PasswordResetRequestSchema,
        },
      },
    },
  },
  responses: {
    202: {
      description: "Password reset request accepted",
      content: {
        "application/json": {
          schema: PasswordResetAcceptedResponseSchema,
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
    429: {
      description: "Too many password reset requests",
      content: {
        "application/json": {
          schema: ErrorResponseSchema,
        },
      },
    },
    503: {
      description: "Password reset delivery is temporarily unavailable",
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
  path: "/api/v1/auth/email-verification/verify",
  tags: ["Auth"],
  summary: "Verify a user's email address",
  operationId: "verifyEmail",
  request: {
    body: {
      required: true,
      content: {
        "application/json": {
          schema: EmailVerificationVerifyRequestSchema,
        },
      },
    },
  },
  responses: {
    200: {
      description: "Email verified",
      content: {
        "application/json": {
          schema: EmailVerificationVerifiedResponseSchema,
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
      description: "Verification token is invalid or expired",
      content: {
        "application/json": {
          schema: ErrorResponseSchema,
        },
      },
    },
    429: {
      description: "Too many verification attempts",
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
  path: "/api/v1/auth/email-verification/resend",
  tags: ["Auth"],
  summary: "Resend an email verification link",
  operationId: "resendEmailVerification",
  request: {
    body: {
      required: true,
      content: {
        "application/json": {
          schema: EmailVerificationResendRequestSchema,
        },
      },
    },
  },
  responses: {
    202: {
      description: "Verification resend accepted",
      content: {
        "application/json": {
          schema: PasswordResetAcceptedResponseSchema,
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
    429: {
      description: "Too many verification resend attempts",
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
  path: "/api/v1/auth/password-reset/confirm",
  tags: ["Auth"],
  summary: "Confirm a password reset and establish a new session",
  operationId: "confirmPasswordReset",
  request: {
    body: {
      required: true,
      content: {
        "application/json": {
          schema: PasswordResetConfirmSchema,
        },
      },
    },
  },
  responses: {
    200: {
      description: "Password reset completed and session established",
      content: {
        "application/json": {
          schema: PasswordResetConfirmResponseSchema,
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
      description: "Password reset token is invalid or expired",
      content: {
        "application/json": {
          schema: ErrorResponseSchema,
        },
      },
    },
    429: {
      description: "Too many password reset attempts",
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
  path: "/api/v1/chat/",
  tags: ["Chat"],
  summary: "Ask a retrieval-grounded question",
  operationId: "createChatResponse",
  security: [{ [bearerAuthScheme.name]: [] }],
  request: {
    body: {
      required: true,
      content: {
        "application/json": {
          schema: ChatRequestSchema,
        },
      },
    },
  },
  responses: {
    200: {
      description: "Chat response returned as JSON or SSE",
      content: {
        "application/json": {
          schema: ChatResponseSchema,
        },
        "text/event-stream": {
          schema: z.string().openapi("ChatSseStream"),
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
  path: "/api/v1/chat/history",
  tags: ["Chat"],
  summary: "List saved chat conversations",
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
  path: "/api/v1/chat/history/{conversationId}",
  tags: ["Chat"],
  summary: "Get a saved conversation and its debug metadata",
  operationId: "getChatHistoryConversation",
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
  path: "/api/v1/evals/datasets",
  tags: ["Evals"],
  summary: "List eval datasets for the active workspace",
  operationId: "listEvalDatasets",
  security: [{ [bearerAuthScheme.name]: [] }],
  responses: {
    200: {
      description: "Eval dataset summaries",
      content: {
        "application/json": {
          schema: EvalDatasetListResponseSchema,
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
  path: "/api/v1/evals/datasets",
  tags: ["Evals"],
  summary: "Create an eval dataset",
  operationId: "createEvalDataset",
  security: [{ [bearerAuthScheme.name]: [] }],
  request: {
    body: {
      required: true,
      content: {
        "application/json": {
          schema: createEvalDatasetSchema,
        },
      },
    },
  },
  responses: {
    201: {
      description: "Eval dataset created",
      content: {
        "application/json": {
          schema: EvalDatasetSummarySchema,
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
  },
});

registry.registerPath({
  method: "get",
  path: "/api/v1/evals/datasets/{datasetId}",
  tags: ["Evals"],
  summary: "Get one eval dataset with its cases and runs",
  operationId: "getEvalDataset",
  security: [{ [bearerAuthScheme.name]: [] }],
  request: {
    params: evalDatasetParamsSchema,
  },
  responses: {
    200: {
      description: "Eval dataset detail",
      content: {
        "application/json": {
          schema: EvalDatasetDetailSchema,
        },
      },
    },
    404: {
      description: "Eval dataset not found",
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
  path: "/api/v1/evals/import/chat-history",
  tags: ["Evals"],
  summary: "Create an eval import draft from chat history",
  operationId: "importEvalChatHistory",
  security: [{ [bearerAuthScheme.name]: [] }],
  request: {
    body: {
      required: true,
      content: {
        "application/json": {
          schema: importChatHistorySchema,
        },
      },
    },
  },
  responses: {
    200: {
      description: "Eval import draft returned",
      content: {
        "application/json": {
          schema: z.object({ importDraft: EvalImportDraftSchema }),
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
  },
});

registry.registerPath({
  method: "post",
  path: "/api/v1/evals/datasets/{datasetId}/cases",
  tags: ["Evals"],
  summary: "Add an eval case to a dataset",
  operationId: "createEvalCase",
  security: [{ [bearerAuthScheme.name]: [] }],
  request: {
    params: evalDatasetParamsSchema,
    body: {
      required: true,
      content: {
        "application/json": {
          schema: createEvalCaseSchema,
        },
      },
    },
  },
  responses: {
    201: {
      description: "Eval case created",
      content: {
        "application/json": {
          schema: EvalCaseSchema,
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
      description: "Eval dataset not found",
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
  path: "/api/v1/evals/datasets/{datasetId}/runs",
  tags: ["Evals"],
  summary: "Run an eval dataset",
  operationId: "createEvalRun",
  security: [{ [bearerAuthScheme.name]: [] }],
  request: {
    params: evalDatasetParamsSchema,
    body: {
      required: true,
      content: {
        "application/json": {
          schema: createEvalRunSchema,
        },
      },
    },
  },
  responses: {
    201: {
      description: "Eval run created",
      content: {
        "application/json": {
          schema: EvalRunSchema,
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
  },
});

registry.registerPath({
  method: "get",
  path: "/api/v1/evals/datasets/{datasetId}/runs/{runId}",
  tags: ["Evals"],
  summary: "Get an eval run",
  operationId: "getEvalRun",
  security: [{ [bearerAuthScheme.name]: [] }],
  request: {
    params: evalRunParamsSchema,
  },
  responses: {
    200: {
      description: "Eval run returned",
      content: {
        "application/json": {
          schema: EvalRunSchema,
        },
      },
    },
    404: {
      description: "Eval run not found",
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
  path: "/api/v1/evals/datasets/{datasetId}/runs/{runId}/comparison",
  tags: ["Evals"],
  summary: "Compare an eval run to a baseline",
  operationId: "getEvalRunComparison",
  security: [{ [bearerAuthScheme.name]: [] }],
  request: {
    params: evalRunParamsSchema,
    query: evalComparisonQuerySchema,
  },
  responses: {
    200: {
      description: "Eval run comparison returned",
      content: {
        "application/json": {
          schema: EvalRunComparisonSchema,
        },
      },
    },
    400: {
      description: "Comparison unavailable",
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
  tags: ["Public Chat"],
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
          schema: ChatResponseSchema,
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
  tags: ["Public Chat"],
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
  tags: ["Public Chat"],
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

registry.registerPath({
  method: "get",
  path: "/api/connectors/whatsapp/{workspaceId}/webhook",
  tags: ["Connector Webhooks"],
  summary: "Verify WhatsApp webhook ownership",
  operationId: "verifyWhatsAppWebhook",
  request: {
    params: whatsAppWebhookParamsSchema,
    query: whatsAppWebhookQuerySchema,
  },
  responses: {
    200: {
      description: "Verification challenge echoed back",
      content: {
        "text/plain": {
          schema: PlainTextChallengeSchema,
        },
      },
    },
    403: {
      description: "Verification failed",
    },
    404: {
      description: "Connector config not found",
    },
  },
});

registry.registerPath({
  method: "post",
  path: "/api/connectors/whatsapp/{workspaceId}/webhook",
  tags: ["Connector Webhooks"],
  summary: "Receive a WhatsApp webhook event",
  operationId: "receiveWhatsAppWebhook",
  request: {
    params: whatsAppWebhookParamsSchema,
    body: {
      required: true,
      content: {
        "application/json": {
          schema: whatsAppWebhookPayloadSchema,
        },
      },
    },
  },
  responses: {
    200: {
      description: "Webhook accepted",
      content: {
        "application/json": {
          schema: EmptySuccessSchema,
        },
      },
    },
    401: {
      description: "Invalid webhook signature",
    },
    404: {
      description: "Connector config not found",
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
      { name: "Settings" },
      { name: "Documents" },
      { name: "Chat" },
      { name: "Public Chat" },
      { name: "Connectors" },
      { name: "Connector Webhooks" },
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
