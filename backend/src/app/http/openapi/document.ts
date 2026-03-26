import { z } from "zod";
import {
  OpenAPIRegistry,
  OpenApiGeneratorV31,
  extendZodWithOpenApi,
} from "@asteasolutions/zod-to-openapi";

import { registerSchema, loginSchema } from "../routes/authRoutes.js";
import { workspaceParamsSchema as accountWorkspaceParamsSchema } from "../routes/accountRoutes.js";
import {
  createWorkspaceSchema,
  renameWorkspaceSchema,
  workspaceParamsSchema,
} from "../routes/workspaceRoutes.js";
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
  anonymousChatSchema,
  publicConversationParamsSchema,
} from "../routes/publicChatRoutes.js";
import { chunkingStrategyIds } from "../../../modules/retrieval/domain/chunking/chunkingStrategy.js";
import {
  retrievalSignalDefinitions,
  signalPolicyModes,
} from "../../../modules/settings/domain/retrievalSettings.js";

extendZodWithOpenApi(z);

const registry = new OpenAPIRegistry();

const sessionCookieScheme = registry.registerComponent("securitySchemes", "sessionCookie", {
  type: "apiKey",
  in: "cookie",
  name: "radioso_session",
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
    workspaceId: z.string().uuid(),
    workspaceName: z.string(),
    token: z.string().regex(/^sk_proj_[a-f0-9]+$/i),
  }),
);

const LoginResponseSchema = registry.register(
  "LoginResponse",
  z.object({
    userId: z.string().uuid(),
    workspaceId: z.string().uuid(),
    workspaceName: z.string(),
    token: z.string().regex(/^sk_proj_[a-f0-9]+$/i),
  }),
);

const AccountTokenResponseSchema = registry.register(
  "AccountTokenResponse",
  z.object({
    token: z.string().regex(/^sk_proj_[a-f0-9]+$/i),
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

const RegisterRequestSchema = registry.register("RegisterRequest", registerSchema);
const LoginRequestSchema = registry.register("LoginRequest", loginSchema);
const WorkspaceCreateRequestSchema = registry.register("WorkspaceCreateRequest", createWorkspaceSchema);
const WorkspaceRenameRequestSchema = registry.register("WorkspaceRenameRequest", renameWorkspaceSchema);

const RetrievalSettingsSchema = registry.register(
  "RetrievalSettings",
  z.object({
    workspaceId: z.string().uuid(),
    queryRewriteEnabled: z.boolean(),
    rerankEnabled: z.boolean(),
    vectorTopK: z.number().int().min(1).max(300),
    similarityThreshold: z.number().min(0).max(1),
    rerankTopK: z.number().int().min(1),
    warmthLevel: z.number().int().min(1).max(10),
    citationDisplayEnabled: z.boolean(),
    signalDefinitions: z.array(
      z.object({
        key: z.string(),
        label: z.string(),
        description: z.string(),
        source: z.enum(["system", "metadata"]),
      }),
    ).default(retrievalSignalDefinitions),
    signalPolicies: z.array(
      z.object({
        signalKey: z.string(),
        enabled: z.boolean(),
        mode: z.enum(signalPolicyModes),
      }),
    ),
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

const RetrievalSignalPolicySchema = registry.register(
  "RetrievalSignalPolicy",
  z.object({
    signalKey: z.string(),
    enabled: z.boolean(),
    mode: z.enum(signalPolicyModes),
  }),
);

const RetrievalSignalDefinitionSchema = registry.register(
  "RetrievalSignalDefinition",
  z.object({
    key: z.string(),
    label: z.string(),
    description: z.string(),
    source: z.enum(["system", "metadata"]),
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
    createdAt: z.string().datetime(),
    updatedAt: z.string().datetime(),
    metadata: z.record(z.union([z.string(), z.number(), z.boolean(), z.null()])).default({}),
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

const AppliedConstraintSchema = registry.register(
  "AppliedConstraint",
  z.object({
    signalKey: z.string(),
    mode: z.enum(signalPolicyModes),
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
  }),
);

const ValidationDispositionSchema = registry.register(
  "ValidationDisposition",
  z.enum(["supported", "unsupported", "non_substantive"]),
);

const ValidationSegmentResultSchema = registry.register(
  "ValidationSegmentResult",
  z.object({
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
    supportedSegmentCount: z.number().int().min(0),
    nonSubstantiveSegmentCount: z.number().int().min(0),
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
    citations: z.array(CitationSchema).optional(),
    answerSegments: z.array(AnswerSegmentSchema).optional(),
    debug: ChatConversationMessageDebugSchema.optional(),
  }),
);

const ChatConversationDetailSchema = registry.register(
  "ChatConversationDetail",
  z.object({
    conversationId: z.string().uuid(),
    workspaceId: z.string().uuid(),
    sourceChannel: z.string().nullable(),
    createdAt: z.string().datetime(),
    updatedAt: z.string().datetime(),
    messageCount: z.number().int().min(0),
    userMessageCount: z.number().int().min(0),
    assistantMessageCount: z.number().int().min(0),
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
    conversations: z.array(PublicConversationSummarySchema),
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
      description: "Account created and session established",
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
  path: "/api/v1/account/workspaces/{workspaceId}/token",
  tags: ["Account"],
  summary: "Return the API token for a specific workspace",
  operationId: "getWorkspaceToken",
  security: [{ [sessionCookieScheme.name]: [] }],
  request: {
    params: accountWorkspaceParamsSchema,
  },
  responses: {
    200: {
      description: "Token returned",
      content: {
        "application/json": {
          schema: AccountTokenResponseSchema,
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
      title: "Hivec API",
      version: "0.1.0",
      description: "Code-generated OpenAPI contract for the Hivec backend",
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
