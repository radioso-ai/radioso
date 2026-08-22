import { copilotNeverList, neverListExclusion, type CopilotNeverListEntry } from "../../../src/modules/operatorCopilot/neverList.js";

interface CatalogCoverageExclusion {
  readonly disposition: "deferred" | "permanent";
  readonly reason: string;
  readonly neverListEntry?: CopilotNeverListEntry;
}

type CatalogCoverageEntry = string | CatalogCoverageExclusion;

const deferred = (reason: string): CatalogCoverageExclusion => ({ disposition: "deferred", reason });
const permanent = (reason: string): CatalogCoverageExclusion => ({ disposition: "permanent", reason });
const coverage = (operationIds: ReadonlyArray<string>, entry: CatalogCoverageExclusion): Record<string, CatalogCoverageExclusion> =>
  Object.fromEntries(operationIds.map((operationId) => [operationId, entry]));

const catalogToolCoverage = {
  listAgents: "agent_configuration",
  getAgent: "agent_configuration",
  listAgentDirectives: "agent_configuration",
  listAgentRoutines: "routine_definition",
  getAgentRoutine: "routine_definition",
  getHistoryConversation: "conversation_transcript",
  tailHistoryConversation: "conversation_transcript",
  getLegacyHistoryConversation: "conversation_transcript",
  listHistory: "conversation_history_search",
  listChatHistory: "conversation_history_search",
  listHistorySearches: "conversation_history_search",
  getHistorySearch: "conversation_history_search",
  searchDocuments: "document_search",
  getDocument: "document_search",
  listDocuments: "document_status",
  listDocumentSources: "document_status",
  listDocumentsBySource: "document_status",
  listAgentSkills: "agent_skills",
  listAgentSkillCapabilities: "agent_skills",
  listMcpConnections: "agent_skills",
  getMcpConnection: "agent_skills",
  listExternalSkills: "agent_skills",
  getExternalSkill: "agent_skills",
  getEvalCaseBySourceMessage: "eval_results",
  getOrCreateEvalCaseBySourceMessage: "eval_results",
  listLowQualityTurns: "quality_signals",
  getQualityStats: "quality_signals",
  getAudiencePulse: "audience_topics",
  getPlatformSettings: "workspace_settings",
  getSettingsRetrievalDefaults: "workspace_settings",
  getIngestionSettings: "workspace_settings",
  getGeneralSettings: "workspace_settings",
  listWorkspaceProviderCredentials: "workspace_settings",
  getWorkspaceLlmModels: "workspace_settings",
} as const;

const wave2BehaviorAuthoring = deferred("Deferred to Wave 2 behavior authoring: Ray will create operator-confirmed proposals, not edit live behavior directly.");
const wave3KnowledgeBase = deferred("Deferred to Wave 3 knowledge base work: document and source changes need their own bounded proposal flows.");
// Ingestion settings become proposable in Wave 3. Only the embedding-model switch inside such a
// proposal stays never-list, because it triggers a bulk re-embed; cancelling a pending switch is a
// safe de-escalation and is deliberately not treated as a boundary.
const wave3IngestionSettings = deferred(
  `Deferred to Wave 3 ingestion settings proposals. ${copilotNeverList.embedding_model_switch_without_typed_confirmation.reason}`,
);
const wave4Serving = deferred("Deferred to Wave 4 serving work: operator serving controls need an explicit runtime safety model.");
const wave5WorkspaceConfig = deferred("Deferred to Wave 5 workspace configuration: these settings need bounded, operator-confirmed configuration flows.");
// A permanent exclusion is the strongest claim this map makes — it is what a future implementer
// reads to decide whether something may be built at all. These were previously one bucket reasoned
// as "identity, authorization, and secret-bearing administration", which conflated four unrelated
// grounds and twice misfiled a harmless read (see listWorkspaceProviderCredentials, corrected when
// workspace_settings landed). Each ground is now stated separately so a wrong permanent is visible.
const secretBearingRead = permanent("Permanent exclusion: the response carries secret material itself, so it must never enter a model context.");
const identityAdministration = permanent("Permanent exclusion: Ray does not administer identity, accounts, or authorization.");
const accountScope = permanent("Permanent exclusion: this is account-scoped rather than workspace-scoped, and Ray operates on one workspace.");
const tokenIntegrationSurface = permanent("Permanent exclusion: this serves workspace-token integration clients, not the operator dashboard surface Ray runs on.");
const endUserSurface = permanent("Permanent exclusion: this is an end-user or inbound integration surface, not an operator-copilot tool.");
const authOrRegistration = permanent("Permanent exclusion: authentication and registration are not an operator-copilot surface.");
const copilotUiOnly = permanent("Permanent exclusion: this endpoint is the operator copilot UI/control surface, not a tool Ray may call.");
const transportOnly = permanent("Permanent exclusion: this is a long-lived dashboard event transport, not a bounded operator-copilot tool or data reader.");

/** Every OpenAPI operation is deliberately reachable through a family reader or explicitly planned/excluded. */
export const catalogCoverage: Record<string, CatalogCoverageEntry> = {
  ...catalogToolCoverage,

  ...coverage([
    "getHealth",
    "createPublicChatSession",
    "getRegistrationAvailability",
    "registerAccount",
    "loginAccount",
    "requestPasswordReset",
    "confirmPasswordReset",
    "verifyEmail",
    "resendEmailVerification",
    "getAccountInvitation",
    "acceptAccountInvitation",
  ], authOrRegistration),
  ...coverage([
    "getWorkspaceApiToken",
    "getAgentContextVariableSigningKey",
  ], secretBearingRead),
  ...coverage([
    "createAdditionalOrganization",
    "switchAccount",
  ], identityAdministration),
  ...coverage([
    "listAccessibleAccounts",
    "listAccountUsers",
  ], accountScope),
  ...coverage(["getWorkspaceMcpContext"], tokenIntegrationSurface),
  // Grant metadata, not grant tokens: this endpoint documents its own response as "returned without
  // token material". Its siblings listMcpConnections and getMcpConnection are already agent_skills
  // reads, so treating the grants as a permanent secret boundary was inconsistent on its face.
  // Issuing, rotating and revoking grants remain never-list under access_grants.
  ...coverage(["listAgentMcpConverseGrants"], wave2BehaviorAuthoring),
  ...coverage(["deleteWorkspace"], neverListExclusion("workspace_delete")),
  ...coverage([
    "createAccountInvitation",
    "revokeAccountInvitation",
    "updateAccountUserRole",
    "removeAccountUser",
  ], neverListExclusion("member_management")),
  ...coverage([
    "setWorkspaceGrant",
    "removeWorkspaceGrant",
    "issueAgentMcpConverseGrant",
    "revokeAgentMcpConverseGrant",
  ], neverListExclusion("access_grants")),
  ...coverage([
    "rotateWorkspaceApiToken",
    "rotateWebhookDestinationSecret",
    "rotateAnonymousChatToken",
    "rotateWebsiteEmbedToken",
    "rotateAgentMcpConverseGrant",
  ], neverListExclusion("secret_rotation")),
  ...coverage([
    "setWorkspaceProviderCredential",
    "removeWorkspaceProviderCredential",
  ], neverListExclusion("provider_credential_writes")),
  ...coverage([
    "updateIngestionSettings",
    "cancelPendingEmbeddingModel",
  ], wave3IngestionSettings),
  ...coverage(["replyToConversation"], neverListExclusion("unattended_live_customer_reply")),

  ...coverage([
    "getAccountUsageTrends",
    "getAccountUsageMessages",
    "getAccountInternalUsage",
    "listWorkspaces",
    "createWorkspace",
    "getWorkspaceSummary",
    "resolveWorkspaceRouteKey",
    "renameWorkspace",
    "listWebhookDestinations",
    "createWebhookDestination",
    "getWebhookDestination",
    "updateWebhookDestination",
    "deleteWebhookDestination",
    "updatePlatformSettings",
    "reprocessWorkspaceIngestion",
    "updateGeneralSettings",
    "uploadAssistantLogo",
    "deleteAssistantLogo",
    "updateWorkspaceLlmModels",
    "startMcpConnectionOauth",
    "createWorkspaceOauthConnection",
    "listWorkspaceOauthConnections",
    "getWorkspaceOauthConnection",
    "reauthorizeWorkspaceOauthConnection",
    "listWorkspaceEmailSkillActivity",
    "listWorkspaceEmailConnections",
    "createWorkspaceEmailConnection",
    "listWorkspaceEmailOauthConnections",
    "updateWorkspaceEmailConnection",
    "deleteWorkspaceEmailConnection",
    "checkWorkspaceEmailConnectionHealth",
    "startWorkspaceSlackInstall",
    "getWorkspaceSlackInstallStatus",
    "getWorkspaceSlackManifest",
    "getWorkspaceSlackBinding",
    "setWorkspaceSlackBinding",
    "deleteWorkspaceSlackChannelBinding",
    "listWorkspaceSlackBindings",
    "disconnectWorkspaceSlackInstallation",
    "listConnectors",
    "getConnectorDetail",
    "updateConnectorConfig",
    "enableConnector",
    "disableConnector",
    "syncConnector",
  ], wave5WorkspaceConfig),
  ...coverage([
    "createAgent",
    "updateAgent",
    "getAgentChannelsLifecycle",
    "createAgentDirective",
    "draftAgentDirective",
    "updateAgentDirective",
    "deleteAgentDirective",
    "listAgentRoutineSkillCatalog",
    "createAgentRoutine",
    "updateAgentRoutine",
    "deleteAgentRoutine",
    "draftAgentRoutineFromProcedure",
    "validateAgentRoutine",
    "publishAgentRoutine",
    "reviseAgentRoutine",
    "archiveAgentRoutine",
    "restoreAgentRoutine",
    "uploadAgentAssistantLogo",
    "deleteAgentAssistantLogo",
    "setDefaultAgent",
    "createContextVariable",
    "listContextVariables",
    "getContextVariable",
    "updateContextVariable",
    "deleteContextVariable",
    "listAgentContextVariables",
    "upsertAgentContextVariable",
    "deleteAgentContextVariable",
    "upsertContextVariableValue",
    "getContextVariableValue",
    "deleteContextVariableValue",
    "listSkills",
    "getSkill",
    "createMcpConnection",
    "discoverMcpConnectionTools",
    "deleteMcpConnection",
    "updateMcpConnection",
    "createExternalSkill",
    "deleteExternalSkill",
    "updateExternalSkill",
    "listAgentEmailSkills",
    "createAgentEmailSkill",
    "getAgentEmailSkill",
    "updateAgentEmailSkill",
    "deleteAgentEmailSkill",
    "listAgentWebhookSkills",
    "createAgentWebhookSkill",
    "getAgentWebhookSkill",
    "updateAgentWebhookSkill",
    "deleteAgentWebhookSkill",
    "listAgentSlackSkills",
    "createAgentSlackSkill",
    "getAgentSlackSkill",
    "updateAgentSlackSkill",
    "deleteAgentSlackSkill",
    "createAgentSkill",
    "updateAgentSkill",
    "deleteAgentSkill",
    "deleteEvalCase",
    "createEvalRun",
  ], wave2BehaviorAuthoring),
  ...coverage([
    "searchRetrievalEvidence",
    "listDocumentSearchHistory",
    "getDocumentSearchHistory",
    "createDocument",
    "updateDocumentSource",
    "deleteDocumentSource",
    "recrawlDocumentSource",
    "pauseDocumentSourceCrawl",
    "resumeDocumentSourceCrawl",
    "importDocument",
    "crawlWebsiteDocuments",
    "listWebsiteCrawlJobs",
    "deleteWebsiteCrawlJob",
    "updateDocument",
    "updateDocumentRetrieval",
    "deleteDocument",
    "reprocessDocumentSource",
    "reprocessDocument",
  ], wave3KnowledgeBase),
  ...coverage([
    "createRetrievalAnswer",
    "setQualityTurnTriage",
    "refreshAudiencePulse",
    "getAudiencePulseEvidenceAnchor",
  ], wave4Serving),
  ...coverage([
    "completeMcpConnectionOauth",
    "completeWorkspaceOauthCallback",
    "createAssistantChatResponse",
    "upsertAnswerFeedback",
    "clearAnswerFeedback",
    "upsertPublicAnswerFeedback",
    "clearPublicAnswerFeedback",
    "takeOverConversation",
    "transferConversationOwnership",
    "handBackConversation",
    "forkConversation",
    "listPendingDecisions",
    "resolveDecision",
    "createMcpConverseSession",
    "validateMcpConverseSession",
    "askMcpConverseAgent",
    "answerMcpConverseGrounded",
    "listMcpConverseResources",
    "readMcpConverseResource",
    "createPublicChatResponse",
    "listPublicChatHistory",
    "getPublicChatHistoryConversation",
    "tailPublicChatHistoryConversation",
    "streamPublicChatConversationEvents",
  ], endUserSurface),
  ...coverage(["streamWorkspaceEvents"], transportOnly),

  createAgentDirective: "propose_directive",
  updateAgentDirective: "propose_directive",
  updateAgent: "propose_agent_setting",
  createAgentRoutine: "propose_routine",
  updateAgentRoutine: deferred("Deferred to Wave 2 behavior authoring: routine proposals create drafts only; editing remains in the routine editor."),
  draftAgentRoutineFromProcedure: deferred("Deferred to Wave 2 behavior authoring: routine proposals create drafts only; drafting remains in the routine editor."),
  validateAgentRoutine: deferred("Deferred to Wave 2 behavior authoring: routine validation remains in the routine editor."),
  publishAgentRoutine: deferred("Deferred to Wave 2 behavior authoring: publishing remains in the routine editor."),
  reviseAgentRoutine: deferred("Deferred to Wave 2 behavior authoring: revision remains in the routine editor."),
  archiveAgentRoutine: deferred("Deferred to Wave 2 behavior authoring: lifecycle changes remain in the routine editor."),
  restoreAgentRoutine: deferred("Deferred to Wave 2 behavior authoring: lifecycle changes remain in the routine editor."),
  getCopilotAvailability: copilotUiOnly,
  listCopilotConversations: copilotUiOnly,
  getCopilotConversation: copilotUiOnly,
  deleteCopilotConversation: copilotUiOnly,
  createCopilotTurn: copilotUiOnly,
  getCopilotProposal: copilotUiOnly,
  applyCopilotProposal: copilotUiOnly,
  dismissCopilotProposal: copilotUiOnly,
};
