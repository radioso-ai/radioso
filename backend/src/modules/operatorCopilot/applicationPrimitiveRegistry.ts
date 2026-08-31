/**
 * Stable identities for application capabilities consumed by the catalog.
 * Their owner modules export the non-Ray identities, and application
 * composition supplies that machine-checkable set when it assembles Ray.
 */
export const copilotRayOwnedPrimitiveIds = [
  "operatorCopilot.proposal.create",
  "operatorCopilot.safe-test.orchestration",
  "operatorCopilot.workspace-triage",
] as const;

export const copilotApplicationPrimitiveRegistry = {
  "agentSkills.config.propose": { owningModule: "agentSkills", exportedPort: "AgentSkillsService" },
  "agents.configuration.read": { owningModule: "agents", exportedPort: "AgentService" },
  "agents.directive.propose": { owningModule: "agents", exportedPort: "AuthoredDirectiveService" },
  "agents.setting.propose": { owningModule: "agents", exportedPort: "AgentService" },
  "chat.conversation.trace.read": { owningModule: "chat", exportedPort: "ChatHistoryService" },
  "chat.conversation.identity.read": { owningModule: "chat", exportedPort: "ChatHistoryService" },
  "documents.status.read": { owningModule: "documents", exportedPort: "DocumentIngestionService" },
  "documents.chunks.read": { owningModule: "documents", exportedPort: "ChunkRepositoryPort" },
  "documents.reprocess.act": { owningModule: "documents", exportedPort: "DocumentIngestionService" },
  "documents.source-reprocess.act": { owningModule: "documents", exportedPort: "DocumentSourceReprocessService" },
  "documents.source-recrawl.act": { owningModule: "documents", exportedPort: "DocumentSourceRecrawlService" },
  "contextVariables.definition.propose": { owningModule: "contextVariables", exportedPort: "ContextVariableService" },
  "documents.source-status.read": { owningModule: "documents", exportedPort: "DocumentSourceStatusPort" },
  "embedding.coverage.read": { owningModule: "embeddingProfiles", exportedPort: "EmbeddingCoverageReadPort" },
  "eval.case.capture": { owningModule: "eval", exportedPort: "EvalMessageCaseService" },
  "eval.case.replay": { owningModule: "eval", exportedPort: "EvalRunService" },
  "eval.suite.run": { owningModule: "eval", exportedPort: "EvalSuiteService" },
  "operatorCopilot.proposal.create": { owningModule: "operatorCopilot", exportedPort: "CopilotRepositoryPort" },
  "operatorCopilot.safe-test.orchestration": { owningModule: "operatorCopilot", exportedPort: "CopilotAgentTurnProbePort" },
  "operatorCopilot.workspace-triage": { owningModule: "operatorCopilot", exportedPort: "WorkspaceTriageCopilotToolDependencies" },
  "retrieval.evidence.probe": { owningModule: "retrieval", exportedPort: "RetrievalSearchService" },
  "routines.definition.read": { owningModule: "routines", exportedPort: "RoutineDefinitionService" },
  "routines.proposal.prepare": { owningModule: "routines", exportedPort: "RoutineDraftAssistService" },
  "routines.validation": { owningModule: "routines", exportedPort: "RoutineDefinitionService" },
  "settings.workspace.read": { owningModule: "settings", exportedPort: "PlatformSettingsService" },
} as const;

export type CopilotApplicationPrimitiveId = keyof typeof copilotApplicationPrimitiveRegistry;
