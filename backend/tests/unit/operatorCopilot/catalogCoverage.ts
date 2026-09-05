import { neverListExclusion, type CopilotNeverListEntry } from "../../../src/modules/operatorCopilot/neverList.js";

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
  recrawlDocumentSource: "recrawl_source",
  reprocessDocumentSource: "reprocess_document",
  reprocessDocument: "reprocess_document",
  createDocument: "propose_document",
  updateDocumentRetrieval: "propose_document_retrieval",
  deleteDocument: "propose_document_removal",
  listAgentSkills: "agent_skills",
  listAgentSkillCapabilities: "agent_skills",
  listMcpConnections: "agent_skills",
  getMcpConnection: "agent_skills",
  listExternalSkills: "agent_skills",
  getExternalSkill: "agent_skills",
  getEvalCaseBySourceMessage: "eval_results",
  getOrCreateEvalCaseBySourceMessage: "create_eval_case_from_turn",
  runEvalCases: "run_eval_suite",
  listEvalCases: "eval_results",
  listLowQualityTurns: "quality_signals",
  getQualityStats: "quality_signals",
  setQualityTurnTriage: "set_triage_state",
  getAudiencePulse: "audience_topics",
  getAudiencePulseRefreshStatus: "audience_topics",
  getPlatformSettings: "workspace_settings",
  updatePlatformSettings: "propose_workspace_setting",
  getSettingsRetrievalDefaults: "workspace_settings",
  getIngestionSettings: "workspace_settings",
  getEmbeddingCoverage: "workspace_settings",
  getGeneralSettings: "workspace_settings",
  listWorkspaceProviderCredentials: "workspace_settings",
  getWorkspaceLlmModels: "workspace_settings",
  createAssistantChatResponse: "test_agent_turn",
  searchRetrievalEvidence: "retrieval_probe",
  updateIngestionSettings: "propose_ingestion_settings",
  crawlWebsiteDocuments: "start_crawl",
} as const;

const routineStructuralEditing = deferred(
  "Deferred: Ray edits routines by stable id, which cannot add or remove a step, so deleting a routine and reworking its graph stay in the routine editor.",
);
const wave2BehaviorAuthoring = deferred("Deferred to Wave 2 behavior authoring: Ray will create operator-confirmed proposals, not edit live behavior directly.");
const wave3KnowledgeBase = deferred("Deferred to Wave 3 knowledge base work: document source and crawl changes need their own bounded proposal flows.");
// Ray reads documents as search snippets and paged chunks, both derived and partial. This
// operation replaces a document's whole body, so a proposal for it would apply text Ray never
// read in full under a card that says "update". Editing a document body stays with the operator;
// propose_document_retrieval covers the retrieval-facing change Ray can actually justify.
const documentBodyIsOperatorAuthored = permanent(
  "Replacing a document's body is operator-authored: Ray only ever sees snippets and chunks of a document, so it cannot propose a faithful replacement for one.",
);
// Cancelling a pending embedding-model switch is a safe de-escalation rather than a boundary: it
// stops a transition an operator started. It waits on a de-escalation act with its own guards,
// not on the never-list entry that governs starting one.
const pendingEmbeddingSwitchCancel = deferred(
  "Deferred: cancelling a pending embedding-model switch stops a transition an operator started, and needs its own de-escalation act rather than a proposal card.",
);
// The grounded-answer endpoint spends a generation to produce what `test_agent_turn` already
// produces with the agent's own behaviour attached, so exposing it would give Ray two ways to ask
// the same question and one of them would answer as nobody in particular.
const groundedAnswerDuplicatesTurnProbe = deferred(
  "Deferred: createRetrievalAnswer costs a generation and duplicates test_agent_turn, so it waits on a reason to exist alongside it.",
);
const audiencePulseMaintenance = deferred(
  "Deferred: refreshing the audience pulse and resolving its evidence anchors are analytics maintenance acts that need their own cost and freshness guards.",
);
// `replay_eval_case` reaches this operation only through a case: it derives the snapshot from one
// and never attaches the run. Replaying a bare snapshot, and replaying one *into* a case's record,
// are still uncovered, so the operation stays on the ratchet rather than reading as done.
const snapshotOnlyReplay = deferred(
  "Deferred: replay_eval_case covers the case-derived, detached replay only. A snapshot-scoped replay tool would cover the rest.",
);
const workspaceLifecycle = permanent(
  "Permanent exclusion: creating or renaming a workspace changes the container Ray operates inside, not the behaviour it tunes within one.",
);
const dashboardWorkspaceResolution = permanent(
  "Permanent exclusion: this is the dashboard resolving which workspace a URL points at, which Ray is handed already resolved.",
);
const brandAssetIsOperatorSupplied = permanent(
  "Permanent exclusion: the assistant logo is a binary brand asset the operator supplies and approves by looking at it, so Ray can neither produce the bytes nor judge the result.",
);
const interactiveOauthAuthorization = permanent(
  "Permanent exclusion: this starts an interactive OAuth consent flow a person completes elsewhere, so Ray can only ever leave a half-authorized connection behind.",
);
const installationCredentialTeardown = permanent(
  "Permanent exclusion: this deletes the stored installation credential, and only the interactive install Ray may not start can replace it.",
);
const accountWideUsageAnalytics = deferred(
  "Deferred: these report usage for the whole account, and Ray answers for one workspace. The endpoints take a workspaceId filter, so a workspace-scoped usage reader is the shape that would cover them.",
);
const workspaceSetupStateRead = deferred(
  "Deferred: the workspace summary is a setup-state read — document, conversation, and sample-import counts — so it lands with the setup-state reader rather than with configuration writes.",
);
// PUT /settings takes these fields grouped under `assistant`/`channels`; PUT /settings/general
// takes the same fields flat.
const duplicateSettingsWritePath = permanent(
  "Permanent exclusion: this writes flat the same assistant and channel fields updatePlatformSettings writes grouped, through the same service. propose_workspace_setting applies through that one path, and exposing the second shape would let two cards mean the same change while each one's version check saw only its own draft.",
);
const workspaceModelSelection = deferred(
  "Deferred to its own proposal shape: chat, rewrite, and rerank preferences are per-capability rows rather than the one assistant-and-channel surface propose_workspace_setting replaces, and a model whose provider holds no credential would break every answer, so the draft has to refuse one before an operator can apply it. The embedding-model switch stays behind its own never-list entry.",
);
const workspaceWideReprocess = deferred(
  "Deferred: reprocessing every eligible document is the unbounded sibling of reprocess_document, so it needs a cost guard before Ray can spend it.",
);
const webhookDestinationConfiguration = deferred(
  "Deferred to Wave 5 channel configuration: a webhook destination is where the workspace's events leave it, so its name and URL need a proposal card; the reads land with the tool that proposes them.",
);
const webhookDestinationRemoval = deferred(
  "Deferred: deleting a destination silently stops delivery and recreating one mints a new secret the receiver must be reconfigured with, so removal needs its own proposal shape.",
);
const channelConnectionStatusRead = deferred(
  "Deferred to Wave 5 channel configuration: non-secret connection, installation, and binding status that no family reader covers; these land with the channel tools that act on them.",
);
const slackSelfHostManifest = deferred(
  "Deferred: the manifest is a setup artifact an operator pastes into Slack's own console, so its value is a copyable payload rather than something Ray reasons over.",
);
const emailSkillActivityRead = deferred(
  "Deferred: sanitized email skill activity is delivery evidence for the notify path, so it belongs with a delivery-diagnosis reader rather than with the connection writes.",
);
const emailConnectionConfiguration = deferred(
  "Deferred to Wave 5 channel configuration: a customer email connection is a customer-visible channel, so creating or changing one needs a proposal card.",
);
const emailConnectionRemoval = deferred(
  "Deferred: updateWorkspaceEmailConnection disables a connection, which is the reversible equivalent; deleting one drops the mailbox binding outright and needs its own removal shape.",
);
const emailConnectionHealthProbe = deferred(
  "Deferred: the health check is a probe — no persisted change, real work against the mail server — and it lands with the channel tools rather than ahead of them.",
);
const slackAnsweringBinding = deferred(
  "Deferred to Wave 5 channel configuration: a binding decides which agent answers in which Slack channel, which is customer-visible routing and needs a proposal card.",
);
const connectorConfiguration = deferred(
  "Deferred to Wave 5 connector configuration: enabling, disabling, or reconfiguring a connector changes what the agent can reach, so each needs a proposal card.",
);
const connectorManualSync = deferred(
  "Deferred: a manual sync is an act — idempotent, re-derived from the connector's own source of truth — and needs the same cost guard the document maintenance acts carry.",
);
// A permanent exclusion is the strongest claim this map makes — it is what a future implementer
// reads to decide whether something may be built at all. These were previously one bucket reasoned
// as "identity, authorization, and secret-bearing administration", which conflated four unrelated
// grounds and twice misfiled a harmless read (see listWorkspaceProviderCredentials, corrected when
// workspace_settings landed). Each ground is now stated separately so a wrong permanent is visible.
const secretBearingRead = permanent("Permanent exclusion: the response carries secret material itself, so it must never enter a model context.");
const identityAdministration = permanent("Permanent exclusion: Ray does not administer identity, accounts, or authorization.");
const accountScope = permanent("Permanent exclusion: this is account-scoped rather than workspace-scoped, and Ray operates on one workspace.");
const endUserSurface = permanent("Permanent exclusion: this is an end-user or inbound integration surface, not an operator-copilot tool.");
const authOrRegistration = permanent("Permanent exclusion: authentication and registration are not an operator-copilot surface.");
const copilotUiOnly = permanent("Permanent exclusion: this endpoint is the operator copilot UI/control surface, not a tool Ray may call.");
const ambientOperatorRuntime = permanent("Permanent exclusion: this is ambient operator-dashboard runtime transport, not an action Ray may call.");
// A context variable *value* is data written for one session, customer, agent, or workspace scope
// at runtime (by a resolver skill, a pushed API call, or the browser SDK) — it is what a visitor's
// conversation carries, not a setting an operator tunes. propose_context_variable covers the
// variable's definition and an agent's enablement of it; the values themselves stay off Ray's
// catalog on the same ground conversation content does.
const visitorScopedRuntimeData = permanent("Permanent exclusion: this reads or writes a context variable's per-scope runtime value, not agent configuration Ray authors.");
const liveEvalEffects = permanent("Permanent exclusion: Ray may replay and evaluate a case, but never enables the live external effects that a replay can invoke.");

/** Every OpenAPI operation is deliberately reachable through a family reader or explicitly planned/excluded. */
export const catalogCoverage: Record<string, CatalogCoverageEntry> = {
  ...catalogToolCoverage,

  streamWorkspaceEvents: ambientOperatorRuntime,

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
    "acceptAccountInvitationAsCurrentUser",
    "getCurrentSession",
  ], authOrRegistration),
  ...coverage([
    "getAgentContextVariableSigningKey",
  ], secretBearingRead),
  ...coverage([
    "getApiAccessSummary",
    "listPersonalApiTokens",
    "issuePersonalApiToken",
    "relabelPersonalApiToken",
    "rotatePersonalApiToken",
    "revokePersonalApiToken",
    "listServiceAccounts",
    "createServiceAccount",
    "getServiceAccount",
    "updateServiceAccount",
    "disableServiceAccount",
    "enableServiceAccount",
    "archiveServiceAccount",
    "listServiceAccountCredentials",
    "issueServiceAccountCredential",
    "relabelServiceAccountCredential",
    "rotateServiceAccountCredential",
    "revokeServiceAccountCredential",
  ], neverListExclusion("machine_access")),
  ...coverage([
    "createAdditionalOrganization",
    "switchAccount",
  ], identityAdministration),
  ...coverage([
    "listAccessibleAccounts",
    "listAccountUsers",
  ], accountScope),
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
    "createAgentChannelChatResponse",
    "listAgentChannelCredentials",
    "issueAgentChannelCredential",
    "revokeAgentChannelCredential",
  ], neverListExclusion("access_grants")),
  ...coverage([
    "rotateWebhookDestinationSecret",
    "rotateAnonymousChatToken",
    "rotateWebsiteEmbedToken",
    "rotateAgentChannelCredential",
  ], neverListExclusion("secret_rotation")),
  ...coverage([
    "setWorkspaceProviderCredential",
    "removeWorkspaceProviderCredential",
  ], neverListExclusion("provider_credential_writes")),
  ...coverage(["cancelPendingEmbeddingModel"], pendingEmbeddingSwitchCancel),
  ...coverage(["replyToConversation"], neverListExclusion("unattended_live_customer_reply")),

  ...coverage(["getAccountUsageTrends", "getAccountUsageMessages", "getAccountInternalUsage"], accountWideUsageAnalytics),
  ...coverage(["listWorkspaces"], accountScope),
  ...coverage(["createWorkspace", "renameWorkspace"], workspaceLifecycle),
  ...coverage(["resolveWorkspaceRouteKey"], dashboardWorkspaceResolution),
  ...coverage(["getWorkspaceSummary"], workspaceSetupStateRead),
  // Answers with WebhookDestinationCreateResponse, the same one-time plaintext secret the
  // never-listed rotateWebhookDestinationSecret returns. The name-and-URL edit beside it carries none.
  ...coverage(["createWebhookDestination"], secretBearingRead),
  ...coverage([
    "listWebhookDestinations",
    "getWebhookDestination",
    "updateWebhookDestination",
  ], webhookDestinationConfiguration),
  ...coverage(["deleteWebhookDestination"], webhookDestinationRemoval),
  ...coverage(["updateGeneralSettings"], duplicateSettingsWritePath),
  ...coverage(["updateWorkspaceLlmModels"], workspaceModelSelection),
  ...coverage(["reprocessWorkspaceIngestion"], workspaceWideReprocess),
  ...coverage(["uploadAssistantLogo", "deleteAssistantLogo"], brandAssetIsOperatorSupplied),
  ...coverage([
    "startMcpConnectionOauth",
    "createWorkspaceOauthConnection",
    "reauthorizeWorkspaceOauthConnection",
    "startWorkspaceSlackInstall",
  ], interactiveOauthAuthorization),
  ...coverage(["disconnectWorkspaceSlackInstallation"], installationCredentialTeardown),
  ...coverage([
    "listWorkspaceOauthConnections",
    "getWorkspaceOauthConnection",
    "listWorkspaceEmailConnections",
    "listWorkspaceEmailOauthConnections",
    "getWorkspaceSlackInstallStatus",
    "getWorkspaceSlackBinding",
    "listWorkspaceSlackBindings",
    "listConnectors",
    "getConnectorDetail",
  ], channelConnectionStatusRead),
  ...coverage(["getWorkspaceSlackManifest"], slackSelfHostManifest),
  ...coverage(["listWorkspaceEmailSkillActivity"], emailSkillActivityRead),
  ...coverage(["createWorkspaceEmailConnection", "updateWorkspaceEmailConnection"], emailConnectionConfiguration),
  ...coverage(["deleteWorkspaceEmailConnection"], emailConnectionRemoval),
  ...coverage(["checkWorkspaceEmailConnectionHealth"], emailConnectionHealthProbe),
  ...coverage(["setWorkspaceSlackBinding", "deleteWorkspaceSlackChannelBinding"], slackAnsweringBinding),
  ...coverage(["updateConnectorConfig", "enableConnector", "disableConnector"], connectorConfiguration),
  ...coverage(["syncConnector"], connectorManualSync),
  ...coverage(["deleteAgentRoutine"], routineStructuralEditing),
  ...coverage([
    "createEvalSnapshot",
    "getEvalSnapshot",
    "createEvalCase",
    "getEvalCase",
    "renameEvalCase",
    "replaceEvalCaseAssertions",
    "createEvalCaseRun",
  ], wave2BehaviorAuthoring),
  ...coverage([
    "createAgent",
    "updateAgent",
    "getAgentChannelsLifecycle",
    "createAgentDirective",
    "draftAgentDirective",
    "updateAgentDirective",
    "listAgentRoutineSkillCatalog",
    "draftAgentRoutineFromProcedure",
    "uploadAgentAssistantLogo",
    "deleteAgentAssistantLogo",
    "setDefaultAgent",
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
    "deleteEvalCase",
  ], wave2BehaviorAuthoring),
  ...coverage(["createEvalRun"], snapshotOnlyReplay),
  ...coverage([
    "listDocumentSearchHistory",
    "getDocumentSearchHistory",
    "updateDocumentSource",
    "deleteDocumentSource",
    "pauseDocumentSourceCrawl",
    "resumeDocumentSourceCrawl",
    "importDocument",
    "listWebsiteCrawlJobs",
    "deleteWebsiteCrawlJob",
    "getDocumentTypeCatalog",
    "updateDocumentTypeCatalog",
  ], wave3KnowledgeBase),
  ...coverage(["updateDocument"], documentBodyIsOperatorAuthored),
  ...coverage(["createRetrievalAnswer"], groundedAnswerDuplicatesTurnProbe),
  ...coverage(["refreshAudiencePulse", "getAudiencePulseEvidenceAnchor"], audiencePulseMaintenance),
  // Who is answerable to a waiting customer is the operator's decision, and `forkConversation`
  // belongs here rather than with the end-user surfaces: it is an operator control that lifts a
  // live conversation into a test session. Ray reads the queue and drafts a reply; the person
  // holding the conversation claims, releases, and forks it.
  ...coverage([
    "takeOverConversation",
    "transferConversationOwnership",
    "handBackConversation",
    "forkConversation",
  ], neverListExclusion("live_conversation_ownership")),
  ...coverage(["resolveDecision"], neverListExclusion("pending_decision_resolution")),
  ...coverage([
    "completeMcpConnectionOauth",
    "completeWorkspaceOauthCallback",
    "upsertAnswerFeedback",
    "clearAnswerFeedback",
    "upsertPublicAnswerFeedback",
    "clearPublicAnswerFeedback",
    "createMcpConverseSession",
    "validateMcpConverseSession",
    "askMcpConverseAgent",
    "createPublicChatResponse",
    "listPublicChatHistory",
    "getPublicChatHistoryConversation",
    "tailPublicChatHistoryConversation",
    "streamPublicChatConversationEvents",
  ], endUserSurface),

  listPendingDecisions: "workspace_triage",
  createAgentDirective: "propose_directive",
  updateAgentDirective: "propose_directive",
  deleteAgentDirective: "propose_directive_removal",
  updateAgent: "propose_agent_setting",
  analyzeWebsiteForAgentWizard: "analyze_website",
  streamAgentWizardWebsiteAnalysis: "analyze_website",
  createAgentFromWizard: "propose_agent",
  // propose_agent creates from an analyzed website and always queues that site for ingestion, so
  // the bare-create surface - an agent with a name and nothing to ground on - is not one it reaches.
  createAgent: deferred("Deferred: propose_agent creates an agent from an analyzed website; creating a bare agent with no source is a different surface Ray has no bounded flow for."),
  createAgentSkill: "propose_skill_config",
  updateAgentSkill: "propose_skill_config",
  // Disabling a skill is the reversible equivalent already reachable through propose_skill_config
  // (enabled: false); removal is destructive and stays out of Ray's reach for now.
  deleteAgentSkill: deferred("Deferred to Wave 2 behavior authoring: disabling a skill through propose_skill_config is the reversible equivalent; removal is destructive."),
  setEvalCaseExecutionMode: liveEvalEffects,
  listContextVariables: "context_variables",
  getContextVariable: "context_variables",
  listAgentContextVariables: "context_variables",
  createContextVariable: "propose_context_variable",
  updateContextVariable: "propose_context_variable",
  upsertAgentContextVariable: "propose_context_variable",
  // A routine step can bind an input to a context variable by name (routines/validator.ts), with
  // no foreign key enforcing the reference. Deleting the definition an agent's routines already
  // bind to breaks that binding silently until the routine is next validated or run. Disabling the
  // variable for the agent through propose_context_variable (enabled: false) is the reversible
  // equivalent and stays reachable; deleting the definition outright does not.
  deleteContextVariable: deferred("Deferred to Wave 2 behavior authoring: disabling an agent's use of a variable through propose_context_variable is the reversible equivalent; deleting the definition can silently break a routine step bound to it by name."),
  // Same reference risk, scoped to one agent: a routine step's contextVariableRef binding resolves
  // against this agent's enabled variables, so removing the enablement row breaks that binding the
  // same way deleting the definition does. enabled: false through propose_context_variable is the
  // reversible equivalent.
  deleteAgentContextVariable: deferred("Deferred to Wave 2 behavior authoring: disabling through propose_context_variable (enabled: false) is the reversible equivalent; removing the enablement row can silently break a routine step bound to it by name."),
  ...coverage([
    "upsertContextVariableValue",
    "getContextVariableValue",
    "deleteContextVariableValue",
  ], visitorScopedRuntimeData),
  createAgentRoutine: "propose_routine",
  updateAgentRoutine: "propose_routine_edit",
  draftAgentRoutineFromProcedure: deferred("Deferred to Wave 2 behavior authoring: Ray drafts new routines through propose_routine, which reaches this drafting pass through the service rather than the route."),
  validateAgentRoutine: "validate_routine",
  publishAgentRoutine: "propose_routine_lifecycle",
  // Revision is how an edit to a published routine is applied: propose_routine_edit revises it
  // into a draft rather than editing what is serving.
  reviseAgentRoutine: "propose_routine_edit",
  archiveAgentRoutine: "propose_routine_lifecycle",
  restoreAgentRoutine: "propose_routine_lifecycle",
  // Bundle export/import moves a whole agent as a file between workspaces. Export is a
  // bulk dump of what Ray already reads field by field through get_agent, so a tool for
  // it would add reach without adding an operator outcome. Import is the stronger
  // exclusion: it creates a whole agent from a document the operator holds, so the
  // operator supplying that file IS the review step, and there is nothing for Ray to
  // propose that the operator has not already decided.
  exportAgentBundle: permanent("Bulk read of configuration Ray already reads field by field through get_agent; a tool would widen reach without giving the operator a new outcome."),
  importAgentBundle: permanent("Creates a whole agent from an operator-supplied file. The operator choosing the file is the decision; Ray has no bundle to propose and no way to review one it did not author."),
  getCopilotAvailability: copilotUiOnly,
  listCopilotConversations: copilotUiOnly,
  getCopilotConversation: copilotUiOnly,
  deleteCopilotConversation: copilotUiOnly,
  createCopilotTurn: copilotUiOnly,
  getCopilotProposal: copilotUiOnly,
  applyCopilotProposal: copilotUiOnly,
  dismissCopilotProposal: copilotUiOnly,
};
