import { z } from "zod";
import {
  OpenAPIRegistry,
  extendZodWithOpenApi,
} from "@asteasolutions/zod-to-openapi";

import { registerCommonSchemas } from "./schemas/commonSchemas.js";
import { registerIdentitySchemas } from "./schemas/identitySchemas.js";
import { registerSettingsSchemas } from "./schemas/settingsSchemas.js";
import { registerAgentSchemas } from "./schemas/agentSchemas.js";
import { registerDocumentRetrievalSchemas } from "./schemas/documentRetrievalSchemas.js";
import { registerAssistantHistorySchemas } from "./schemas/assistantHistorySchemas.js";
import { registerConnectorSchemas } from "./schemas/connectorSchemas.js";
import { registerQualitySchemas } from "./schemas/qualitySchemas.js";
import { registerUsageTrendSchemas } from "./schemas/usageTrendSchemas.js";
import { registerContextVariableSchemas } from "./schemas/contextVariableSchemas.js";

extendZodWithOpenApi(z);

type RouteParameterSchema = z.AnyZodObject | z.ZodEffects<RouteParameterSchema, unknown, unknown>;

export interface OpenApiSchemaCatalog {
  AccessibleAccountSchema: z.ZodTypeAny;
  AccessibleAccountsResponseSchema: z.ZodTypeAny;
  AccountInvitationCreateRequestSchema: z.ZodTypeAny;
  AccountInvitationSchema: z.ZodTypeAny;
  accountInvitationParamsSchema: RouteParameterSchema;
  accountMembershipParamsSchema: RouteParameterSchema;
  AccountMembershipRoleUpdateRequestSchema: z.ZodTypeAny;
  accountSwitchSchema: z.ZodTypeAny;
  AccountUserSchema: z.ZodTypeAny;
  AccountUsersResponseSchema: z.ZodTypeAny;
  AgentSourceScopeSchema: z.ZodTypeAny;
  AgentListResponseSchema: z.ZodTypeAny;
  AgentLogoSchema: z.ZodTypeAny;
  AgentChannelLifecycleSchema: z.ZodTypeAny;
  AgentChannelsLifecycleResponseSchema: z.ZodTypeAny;
  AgentMcpConverseGrantIssueRequestSchema: z.ZodTypeAny;
  AgentMcpConverseGrantIssueResponseSchema: z.ZodTypeAny;
  AgentMcpConverseGrantListResponseSchema: z.ZodTypeAny;
  AgentMcpConverseGrantMetadataSchema: z.ZodTypeAny;
  AgentMcpConverseGrantParamsSchema: RouteParameterSchema;
  AgentMcpConverseGrantSecretResponseSchema: z.ZodTypeAny;
  AgentParamsSchema: RouteParameterSchema;
  AgentSchema: z.ZodTypeAny;
  AgentContextVariableEnablementListResponseSchema: z.ZodTypeAny;
  AgentContextVariableEnablementRequestSchema: z.ZodTypeAny;
  AgentContextVariableEnablementResponseSchema: z.ZodTypeAny;
  AgentContextVariableParamsSchema: RouteParameterSchema;
  AuthoredDirectiveConditionSchema: z.ZodTypeAny;
  AuthoredDirectiveCreateRequestSchema: z.ZodTypeAny;
  AuthoredDirectiveListResponseSchema: z.ZodTypeAny;
  AuthoredDirectiveParamsSchema: RouteParameterSchema;
  AuthoredDirectiveResponseSchema: z.ZodTypeAny;
  AuthoredDirectiveSaveResponseSchema: z.ZodTypeAny;
  AuthoredDirectiveUpdateRequestSchema: z.ZodTypeAny;
  BuiltInDirectiveSchema: z.ZodTypeAny;
  DirectiveDraftRequestSchema: z.ZodTypeAny;
  DirectiveDraftResponseSchema: z.ZodTypeAny;
  DirectiveCoherenceVerdictSchema: z.ZodTypeAny;
  DirectiveListResponseSchema: z.ZodTypeAny;
  RoutineDefinitionCreateRequestSchema: z.ZodTypeAny;
  RoutineDraftAssistRequestSchema: z.ZodTypeAny;
  RoutineDraftAssistResponseSchema: z.ZodTypeAny;
  RoutineDefinitionGetResponseSchema: z.ZodTypeAny;
  RoutineDefinitionListResponseSchema: z.ZodTypeAny;
  RoutineDefinitionParamsSchema: RouteParameterSchema;
  RoutineDefinitionLifecycleResponseSchema: z.ZodTypeAny;
  RoutineDefinitionPublishResponseSchema: z.ZodTypeAny;
  RoutineDefinitionPublishRejectedResponseSchema: z.ZodTypeAny;
  PortableRoutineDocumentEnvelopeSchema: z.ZodTypeAny;
  PortableRoutineDocumentCreateResponseSchema: z.ZodTypeAny;
  PortableRoutineParseDiagnosticSchema: z.ZodTypeAny;
  PortableRoutineParseDiagnosticsResponseSchema: z.ZodTypeAny;
  RoutineDirectiveScopeOrphanSchema: z.ZodTypeAny;
  RoutineDefinitionResponseSchema: z.ZodTypeAny;
  RoutineDefinitionSaveResponseSchema: z.ZodTypeAny;
  RoutineDefinitionUpdateRequestSchema: z.ZodTypeAny;
  RoutineDefinitionValidateResponseSchema: z.ZodTypeAny;
  RoutineSkillCatalogResponseSchema: z.ZodTypeAny;
  SkillAuthoringDescriptorSchema: z.ZodTypeAny;
  RoutineValidationResultSchema: z.ZodTypeAny;
  AnswerSegmentSchema: z.ZodTypeAny;
  AnswerFeedbackEntrySchema: z.ZodTypeAny;
  AnswerFeedbackRequestSchema: z.ZodTypeAny;
  AnswerFeedbackResponseSchema: z.ZodTypeAny;
  answerFeedbackParamsSchema: RouteParameterSchema;
  AppliedConstraintSchema: z.ZodTypeAny;
  AssistantChatRequestSchema: z.ZodTypeAny;
  AssistantChatResponseSchema: z.ZodTypeAny;
  AssistantLogoUploadRequestSchema: z.ZodTypeAny;
  AssistantRouteDiagnosticsSchema: z.ZodTypeAny;
  AssistantRouteSchema: z.ZodTypeAny;
  AssistantSettingsSectionSchema: z.ZodTypeAny;
  CandidateCountsSchema: z.ZodTypeAny;
  ChatBootstrapResponseSchema: z.ZodTypeAny;
  ChatConversationDetailSchema: z.ZodTypeAny;
  ChatConversationMessageDebugSchema: z.ZodTypeAny;
  ChatConversationMessageSchema: z.ZodTypeAny;
  ChatConversationTailSchema: z.ZodTypeAny;
  ClearAnswerFeedbackResponseSchema: z.ZodTypeAny;
  ChatConversationSummarySchema: z.ZodTypeAny;
  ChatHistoryListResponseSchema: z.ZodTypeAny;
  ChatResponseSchema: z.ZodTypeAny;
  ChatSuggestionActionSchema: z.ZodTypeAny;
  ChatSuggestionSchema: z.ZodTypeAny;
  ConversationOwnershipResponseSchema: z.ZodTypeAny;
  ConversationOwnershipSchema: z.ZodTypeAny;
  ContextVariableCreateRequestSchema: z.ZodTypeAny;
  ContextVariableListResponseSchema: z.ZodTypeAny;
  ContextVariableParamsSchema: RouteParameterSchema;
  ContextVariableResponseSchema: z.ZodTypeAny;
  ContextVariableSigningKeyResponseSchema: z.ZodTypeAny;
  ContextVariableUpdateRequestSchema: z.ZodTypeAny;
  ContextVariableValueDeleteRequestSchema: z.ZodTypeAny;
  ContextVariableValueQuerySchema: RouteParameterSchema;
  ContextVariableValueResponseSchema: z.ZodTypeAny;
  ContextVariableValueUpsertRequestSchema: z.ZodTypeAny;
  CitationSchema: z.ZodTypeAny;
  ConnectorConfigUpdateSchema: z.ZodTypeAny;
  ConnectorConflictSchema: z.ZodTypeAny;
  ConnectorDetailSchema: z.ZodTypeAny;
  ConnectorFieldSchema: z.ZodTypeAny;
  connectorIdPathParamsSchema: RouteParameterSchema;
  ConnectorListResponseSchema: z.ZodTypeAny;
  ConnectorSyncResponseSchema: z.ZodTypeAny;
  ConnectorSummarySchema: z.ZodTypeAny;
  ConnectorValidationErrorSchema: z.ZodTypeAny;
  ConnectorValidationIssueSchema: z.ZodTypeAny;
  ConversationAgentRequestSchema: z.ZodTypeAny;
  ConversationAgentSchema: z.ZodTypeAny;
  ConversationAgentSurfaceSettingsSchema: z.ZodTypeAny;
  conversationParamsSchema: RouteParameterSchema;
  CreateAccountInvitationResponseSchema: z.ZodTypeAny;
  DocumentCreateRequestSchema: z.ZodTypeAny;
  DocumentDetailsSchema: z.ZodTypeAny;
  DocumentEnrichmentSchema: z.ZodTypeAny;
  DocumentImportRequestSchema: z.ZodTypeAny;
  DocumentListResponseSchema: z.ZodTypeAny;
  DocumentOperationResponseSchema: z.ZodTypeAny;
  documentParamsSchema: RouteParameterSchema;
  documentSchema: z.ZodTypeAny;
  DocumentSearchActionSchema: z.ZodTypeAny;
  DocumentSearchHistoryEntrySchema: z.ZodTypeAny;
  DocumentSearchHistoryListResponseSchema: z.ZodTypeAny;
  documentSearchHistoryParamsSchema: RouteParameterSchema;
  DocumentSearchRequestSchema: z.ZodTypeAny;
  DocumentSearchResponseSchema: z.ZodTypeAny;
  DocumentSearchResultSchema: z.ZodTypeAny;
  DocumentSourceDocumentsQuerySchema: RouteParameterSchema;
  DocumentSourceSummarySchema: z.ZodTypeAny;
  DocumentSourceCrawlSettingsSchema: z.ZodTypeAny;
  DocumentSourceListItemSchema: z.ZodTypeAny;
  DocumentSourceUpdateRequestSchema: z.ZodTypeAny;
  DocumentReprocessRequestSchema: z.ZodTypeAny;
  SourceReprocessResponseSchema: z.ZodTypeAny;
  DocumentSourceListResponseSchema: z.ZodTypeAny;
  DocumentStatusSchema: z.ZodTypeAny;
  sourceParamsSchema: RouteParameterSchema;
  DocumentSummarySchema: z.ZodTypeAny;
  ErrorResponseSchema: z.ZodTypeAny;
  FlatErrorResponseSchema: z.ZodTypeAny;
  GeneralSettingsResponseSchema: z.ZodTypeAny;
  HealthResponseSchema: z.ZodTypeAny;
  HistoryItemSchema: z.ZodTypeAny;
  HistoryItemsResponseSchema: z.ZodTypeAny;
  HumanReplyMessageResponseSchema: z.ZodTypeAny;
  HumanReplyMessageSchema: z.ZodTypeAny;
  LowQualityTurnSchema: z.ZodTypeAny;
  LowQualityTurnsPageSchema: z.ZodTypeAny;
  QualityFeedbackCommentSchema: z.ZodTypeAny;
  QualityFeedbackSummarySchema: z.ZodTypeAny;
  QualityFeedbackValueSchema: z.ZodTypeAny;
  QualitySkillStatusSchema: z.ZodTypeAny;
  QualityTriageStateSchema: z.ZodTypeAny;
  QualityTriageRecordSchema: z.ZodTypeAny;
  SetQualityTriageRequestSchema: z.ZodTypeAny;
  UsageTrendBucketSchema: z.ZodTypeAny;
  UsageTrendGranularitySchema: z.ZodTypeAny;
  UsageTrendsQuerySchema: RouteParameterSchema;
  UsageTrendsResponseSchema: z.ZodTypeAny;
  IngestionSettingsSchema: z.ZodTypeAny;
  ReprocessIngestionRequestSchema: z.ZodTypeAny;
  InvitationAcceptRequestSchema: z.ZodTypeAny;
  InvitationDetailsResponseSchema: z.ZodTypeAny;
  invitationTokenParamsSchema: RouteParameterSchema;
  AcceptedResponseSchema: z.ZodTypeAny;
  EmailVerificationResendRequestSchema: z.ZodTypeAny;
  EmailVerificationVerifyRequestSchema: z.ZodTypeAny;
  EmailVerificationVerifyResponseSchema: z.ZodTypeAny;
  LoginRequestSchema: z.ZodTypeAny;
  LoginResponseSchema: z.ZodTypeAny;
  PasswordResetConfirmRequestSchema: z.ZodTypeAny;
  PasswordResetConfirmResponseSchema: z.ZodTypeAny;
  PasswordResetRequestSchema: z.ZodTypeAny;
  ParsedQuerySchema: z.ZodTypeAny;
  PlatformChannelsSettingsSectionSchema: z.ZodTypeAny;
  PlatformSettingsResponseSchema: z.ZodTypeAny;
  PublicChatRequestSchema: z.ZodTypeAny;
  PublicChatSessionRequestSchema: z.ZodTypeAny;
  PublicChatSessionResponseSchema: z.ZodTypeAny;
  PublicChatConversationTailSchema: z.ZodTypeAny;
  PublicConversationListResponseSchema: z.ZodTypeAny;
  publicConversationParamsSchema: z.AnyZodObject;
  PublicConversationSummarySchema: z.ZodTypeAny;
  RagStatusSchema: z.ZodTypeAny;
  RateLimitExceededSchema: z.ZodTypeAny;
  RegisterRequestSchema: z.ZodTypeAny;
  RegisterResponseSchema: z.ZodTypeAny;
  RetrievalAnswerEvidenceSchema: z.ZodTypeAny;
  RetrievalAnswerRequestSchema: z.ZodTypeAny;
  RetrievalAnswerResponseSchema: z.ZodTypeAny;
  RetrievalAnswerSuccessSchema: z.ZodTypeAny;
  RetrievalExecutionMetadataSchema: z.ZodTypeAny;
  ActivitySummarySchema: z.ZodTypeAny;
  RetrievalMetadataRuleSchema: z.ZodTypeAny;
  RetrievalSearchEvidenceSchema: z.ZodTypeAny;
  RetrievalSearchRequestSchema: z.ZodTypeAny;
  RetrievalSearchResponseSchema: z.ZodTypeAny;
  RetrievalDefaultsResponseSchema: z.ZodTypeAny;
  RetrievalSubquerySchema: z.ZodTypeAny;
  ActivityLinkSchema: z.ZodTypeAny;
  ActivityTraceSchema: z.ZodTypeAny;
  ActivityStageSchema: z.ZodTypeAny;
  RewriteInfoSchema: z.ZodTypeAny;
  SkillAvailabilitySchema: z.ZodTypeAny;
  SkillCatalogEntrySchema: z.ZodTypeAny;
  SkillCatalogResponseSchema: z.ZodTypeAny;
  SkillContractReferenceSchema: z.ZodTypeAny;
  SkillDiagnosticDefinitionSchema: z.ZodTypeAny;
  SkillDiagnosticEvidenceSchema: z.ZodTypeAny;
  SkillDiagnosticsSummarySchema: z.ZodTypeAny;
  SkillOutcomeDefinitionSchema: z.ZodTypeAny;
  SkillParamsSchema: RouteParameterSchema;
  tokenPathParamsSchema: z.AnyZodObject;
  TriggerAnalysisRuleSchema: z.ZodTypeAny;
  TriggerAnalysisSchema: z.ZodTypeAny;
  TriggerBackoffSchema: z.ZodTypeAny;
  UpdateGeneralSettingsRequestSchema: z.ZodTypeAny;
  UpdateIngestionSettingsRequestSchema: z.ZodTypeAny;
  UpdatePlatformSettingsRequestSchema: z.ZodTypeAny;
  WebsiteCrawlJobListQuerySchema: RouteParameterSchema;
  WebsiteCrawlJobListResponseSchema: z.ZodTypeAny;
  WebsiteCrawlJobResponseSchema: z.ZodTypeAny;
  WebsiteCrawlJobStatusSchema: z.ZodTypeAny;
  CrawlPageFailureSchema: z.ZodTypeAny;
  WebsiteCrawlJobSummarySchema: z.ZodTypeAny;
  WebsiteCrawlPublicationResponseSchema: z.ZodTypeAny;
  WebsiteCrawlRequestSchema: z.ZodTypeAny;
  WorkspaceCreateRequestSchema: z.ZodTypeAny;
  workspaceGrantParamsSchema: RouteParameterSchema;
  WorkspaceGrantRequestSchema: z.ZodTypeAny;
  WorkspaceGrantSchema: z.ZodTypeAny;
  WorkspaceIngestionReprocessResponseSchema: z.ZodTypeAny;
  workspaceKeyParamsSchema: RouteParameterSchema;
  WorkspaceListResponseSchema: z.ZodTypeAny;
  WorkspaceMcpContextResponseSchema: z.ZodTypeAny;
  WorkspaceProviderCredentialSummarySchema: z.ZodTypeAny;
  WorkspaceProviderCredentialsResponseSchema: z.ZodTypeAny;
  SetWorkspaceProviderCredentialRequestSchema: z.ZodTypeAny;
  WebhookDestinationSchema: z.ZodTypeAny;
  WebhookDestinationListResponseSchema: z.ZodTypeAny;
  WebhookDestinationResponseSchema: z.ZodTypeAny;
  WebhookDestinationCreateResponseSchema: z.ZodTypeAny;
  WebhookDestinationRequestSchema: z.ZodTypeAny;
  WebhookDestinationParamsSchema: RouteParameterSchema;
  WorkspaceLlmCapabilityPreferenceSchema: z.ZodTypeAny;
  WorkspaceLlmModelsResponseSchema: z.ZodTypeAny;
  UpdateWorkspaceLlmModelsRequestSchema: z.ZodTypeAny;
  workspaceParamsSchema: RouteParameterSchema;
  WorkspaceRenameRequestSchema: z.ZodTypeAny;
  WorkspaceRouteResolutionResponseSchema: z.ZodTypeAny;
  WorkspaceSchema: z.ZodTypeAny;
  WorkspaceSummaryResponseSchema: z.ZodTypeAny;
  WorkspaceTokenResponseSchema: z.ZodTypeAny;
}

export const createOpenApiRegistry = () => {
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
  const schemas = {} as OpenApiSchemaCatalog;

  registerCommonSchemas(registry, schemas);
  registerIdentitySchemas(registry, schemas);
  registerSettingsSchemas(registry, schemas);
  registerAgentSchemas(registry, schemas);
  registerDocumentRetrievalSchemas(registry, schemas);
  registerAssistantHistorySchemas(registry, schemas);
  registerConnectorSchemas(registry, schemas);
  registerQualitySchemas(registry, schemas);
  registerUsageTrendSchemas(registry, schemas);
  registerContextVariableSchemas(registry, schemas);

  return {
    registry,
    schemas,
    security: {
      anonymousSessionCookieScheme,
      bearerAuthScheme,
      sessionCookieScheme,
      workspaceAdminSecurity,
      workspaceSelectionScheme,
    },
  };
};

export type OpenApiRegistryBundle = ReturnType<typeof createOpenApiRegistry>;
export type OpenApiSchemas = OpenApiRegistryBundle["schemas"];
export type OpenApiSecurity = OpenApiRegistryBundle["security"];
