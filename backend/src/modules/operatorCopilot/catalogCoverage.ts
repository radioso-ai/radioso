type CatalogCoverageEntry = string | { readonly excluded: string };

const catalogToolCoverage = {
  listAgents: "agent_configuration",
  getAgent: "agent_configuration",
  listAgentDirectives: "agent_configuration",
  listAgentRoutines: "routine_definition",
  getAgentRoutine: "routine_definition",
  getHistoryConversation: "conversation_trace",
  tailHistoryConversation: "conversation_trace",
  getLegacyHistoryConversation: "conversation_trace",
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
} as const;

const excludedOperationIds = [
  "getHealth", "createPublicChatSession", "getRegistrationAvailability", "registerAccount", "loginAccount", "requestPasswordReset", "confirmPasswordReset", "verifyEmail", "resendEmailVerification", "getAccountInvitation", "acceptAccountInvitation", "getAccountUsageTrends", "getAccountUsageMessages", "getAccountInternalUsage", "createAdditionalOrganization", "listAccessibleAccounts", "listAccountUsers", "createAccountInvitation", "revokeAccountInvitation", "updateAccountUserRole", "removeAccountUser", "setWorkspaceGrant", "removeWorkspaceGrant", "switchAccount", "getWorkspaceApiToken", "rotateWorkspaceApiToken", "getWorkspaceMcpContext", "listWorkspaces", "createWorkspace", "getWorkspaceSummary", "resolveWorkspaceRouteKey", "renameWorkspace", "deleteWorkspace", "listWebhookDestinations", "createWebhookDestination", "getWebhookDestination", "updateWebhookDestination", "deleteWebhookDestination", "rotateWebhookDestinationSecret", "getPlatformSettings", "updatePlatformSettings", "getSettingsRetrievalDefaults", "getIngestionSettings", "updateIngestionSettings", "cancelPendingEmbeddingModel", "reprocessWorkspaceIngestion", "getGeneralSettings", "updateGeneralSettings", "rotateAnonymousChatToken", "rotateWebsiteEmbedToken", "uploadAssistantLogo", "deleteAssistantLogo", "listWorkspaceProviderCredentials", "setWorkspaceProviderCredential", "removeWorkspaceProviderCredential", "getWorkspaceLlmModels", "updateWorkspaceLlmModels", "createAgent", "updateAgent", "getAgentChannelsLifecycle", "issueAgentMcpConverseGrant", "listAgentMcpConverseGrants", "rotateAgentMcpConverseGrant", "revokeAgentMcpConverseGrant", "createAgentDirective", "draftAgentDirective", "updateAgentDirective", "deleteAgentDirective", "listAgentRoutineSkillCatalog", "createAgentRoutine", "updateAgentRoutine", "deleteAgentRoutine", "draftAgentRoutineFromProcedure", "validateAgentRoutine", "publishAgentRoutine", "reviseAgentRoutine", "archiveAgentRoutine", "restoreAgentRoutine", "uploadAgentAssistantLogo", "deleteAgentAssistantLogo", "setDefaultAgent", "createContextVariable", "listContextVariables", "getContextVariable", "updateContextVariable", "deleteContextVariable", "listAgentContextVariables", "getAgentContextVariableSigningKey", "upsertAgentContextVariable", "deleteAgentContextVariable", "upsertContextVariableValue", "getContextVariableValue", "deleteContextVariableValue", "searchRetrievalEvidence", "listSkills", "getSkill", "createMcpConnection", "discoverMcpConnectionTools", "deleteMcpConnection", "updateMcpConnection", "createExternalSkill", "deleteExternalSkill", "updateExternalSkill", "startMcpConnectionOauth", "completeMcpConnectionOauth", "createWorkspaceOauthConnection", "listWorkspaceOauthConnections", "getWorkspaceOauthConnection", "reauthorizeWorkspaceOauthConnection", "completeWorkspaceOauthCallback", "listWorkspaceEmailSkillActivity", "listWorkspaceEmailConnections", "createWorkspaceEmailConnection", "listWorkspaceEmailOauthConnections", "updateWorkspaceEmailConnection", "deleteWorkspaceEmailConnection", "checkWorkspaceEmailConnectionHealth", "listAgentEmailSkills", "createAgentEmailSkill", "getAgentEmailSkill", "updateAgentEmailSkill", "deleteAgentEmailSkill", "startWorkspaceSlackInstall", "getWorkspaceSlackInstallStatus", "getWorkspaceSlackManifest", "getWorkspaceSlackBinding", "setWorkspaceSlackBinding", "deleteWorkspaceSlackChannelBinding", "listWorkspaceSlackBindings", "disconnectWorkspaceSlackInstallation", "listAgentWebhookSkills", "createAgentWebhookSkill", "getAgentWebhookSkill", "updateAgentWebhookSkill", "deleteAgentWebhookSkill", "listAgentSlackSkills", "createAgentSlackSkill", "getAgentSlackSkill", "updateAgentSlackSkill", "deleteAgentSlackSkill", "createAgentSkill", "updateAgentSkill", "deleteAgentSkill", "createRetrievalAnswer", "listDocumentSearchHistory", "getDocumentSearchHistory", "createDocument", "updateDocumentSource", "deleteDocumentSource", "recrawlDocumentSource", "pauseDocumentSourceCrawl", "resumeDocumentSourceCrawl", "importDocument", "crawlWebsiteDocuments", "listWebsiteCrawlJobs", "deleteWebsiteCrawlJob", "updateDocument", "updateDocumentRetrieval", "deleteDocument", "reprocessDocumentSource", "reprocessDocument", "createAssistantChatResponse", "upsertAnswerFeedback", "clearAnswerFeedback", "upsertPublicAnswerFeedback", "clearPublicAnswerFeedback", "takeOverConversation", "replyToConversation", "transferConversationOwnership", "handBackConversation", "forkConversation", "listPendingDecisions", "resolveDecision", "listConnectors", "getConnectorDetail", "updateConnectorConfig", "enableConnector", "disableConnector", "syncConnector", "setQualityTurnTriage", "refreshAudiencePulse", "getAudiencePulseEvidenceAnchor", "getCopilotAvailability", "listCopilotConversations", "getCopilotConversation", "deleteCopilotConversation", "createCopilotTurn", "deleteEvalCase", "createEvalRun", "createMcpConverseSession", "validateMcpConverseSession", "askMcpConverseAgent", "answerMcpConverseGrounded", "listMcpConverseResources", "readMcpConverseResource", "createPublicChatResponse", "listPublicChatHistory", "getPublicChatHistoryConversation", "tailPublicChatHistoryConversation", "streamPublicChatConversationEvents",
] as const;

const excluded = { excluded: "Outside the initial read-only operator copilot catalog." } as const;

/** Every OpenAPI operation is deliberately reachable through a family reader or excluded. */
export const catalogCoverage: Record<string, CatalogCoverageEntry> = {
  ...catalogToolCoverage,
  ...Object.fromEntries(excludedOperationIds.map((operationId) => [operationId, excluded])),
  createAgentDirective: "propose_directive",
  updateAgentDirective: "propose_directive",
  updateAgent: "propose_agent_setting",
  createAgentRoutine: "propose_routine",
  updateAgentRoutine: { excluded: "Routine proposals create drafts only; editing remains in the routine editor." },
  draftAgentRoutineFromProcedure: { excluded: "Routine proposals create drafts only; editing remains in the routine editor." },
  validateAgentRoutine: { excluded: "Routine validation remains in the routine editor." },
  publishAgentRoutine: { excluded: "Routine proposals create drafts only; publishing remains in the routine editor." },
  reviseAgentRoutine: { excluded: "Routine proposals create drafts only; revision remains in the routine editor." },
  archiveAgentRoutine: { excluded: "Routine lifecycle changes remain in the routine editor." },
  restoreAgentRoutine: { excluded: "Routine lifecycle changes remain in the routine editor." },
  getCopilotProposal: { excluded: "Operator proposal preview is a read-only UI endpoint, not a catalog tool." },
  applyCopilotProposal: { excluded: "Operator-confirmed proposal application is intentionally outside the tool loop." },
  dismissCopilotProposal: { excluded: "Operator proposal dismissal is intentionally outside the tool loop." },
};
