import type { CopilotToolDescriptor } from "../contracts.js";
import { attachCopilotCapabilityProvenance } from "../capabilityProvenance.js";
import { createAgentConfigurationCopilotTools, createAgentSettingProposalCopilotTools } from "./agents.js";
import type { AgentConfigurationCopilotToolDependencies, AgentSettingProposalCopilotToolDependencies, CopilotAgentConfigurationPort } from "./agents.js";
import { createAgentProposalCopilotTools, createWebsiteAnalysisProbeCopilotTools } from "./agentProposals.js";
import type { AgentProposalCopilotToolDependencies, WebsiteAnalysisProbeCopilotToolDependencies } from "./agentProposals.js";
import { createAgentSkillConfigProposalCopilotTools, createAgentSkillsCopilotTools } from "./agentSkills.js";
import type { AgentSkillConfigProposalCopilotToolDependencies, AgentSkillsCopilotToolDependencies, CopilotAgentSkillsAgentPort, CopilotAgentSkillsPort, CopilotSkillCapabilityTargetsPort } from "./agentSkills.js";
import { createAudiencePulseCopilotTools } from "./audiencePulse.js";
import { createContextVariableProposalCopilotTools, createContextVariablesCopilotTools } from "./contextVariables.js";
import type { ContextVariableProposalCopilotToolDependencies, ContextVariablesCopilotToolDependencies, CopilotContextVariablesAgentPort } from "./contextVariables.js";
import type { AudiencePulseCopilotToolDependencies, CopilotAudiencePulsePort } from "./audiencePulse.js";
import { createChatCopilotTools } from "./chat.js";
import type { ChatCopilotToolDependencies, CopilotConversationHistoryPort } from "./chat.js";
import { createAgentTurnProbeCopilotTools } from "./agentTurnProbe.js";
import type { AgentTurnProbeCopilotToolDependencies, CopilotAgentTurnProbePort } from "./agentTurnProbe.js";
import { createDirectiveProposalCopilotTools } from "./directives.js";
import type { DirectiveProposalCopilotToolDependencies } from "./directives.js";
import { createDocumentKnowledgeCopilotTools, createDocumentSearchCopilotTools, createDocumentStatusCopilotTools } from "./documents.js";
import type { DocumentKnowledgeCopilotToolDependencies, DocumentSearchCopilotToolDependencies, DocumentStatusCopilotToolDependencies, CopilotDocumentChunksPort, CopilotDocumentMaintenancePort, CopilotDocumentSearchPort, CopilotDocumentSourceStatusPort, CopilotDocumentStatusPort } from "./documents.js";
import { createDocumentProposalCopilotTools } from "./documentProposals.js";
import type { DocumentProposalCopilotToolDependencies } from "./documentProposals.js";
import { createWebsiteCrawlProposalCopilotTools } from "./websiteCrawlProposals.js";
import type { WebsiteCrawlProposalCopilotToolDependencies } from "./websiteCrawlProposals.js";
import { createIngestionSettingsProposalCopilotTools } from "./ingestionSettingsProposals.js";
import type { IngestionSettingsProposalCopilotToolDependencies } from "./ingestionSettingsProposals.js";
import { createEvalCopilotTools, createEvalVerificationCopilotTools } from "./eval.js";
import type { CopilotEvalResultsPort, EvalCopilotToolDependencies, EvalVerificationCopilotToolDependencies } from "./eval.js";
import { createRetrievalProbeCopilotTools } from "./retrievalProbe.js";
import type { CopilotRetrievalProbePort, RetrievalProbeCopilotToolDependencies } from "./retrievalProbe.js";
import { createQualityCopilotTools, createQualityTriageCopilotTools } from "./quality.js";
import type { CopilotQualitySignalsPort, CopilotQualityTriagePort, QualityCopilotToolDependencies, QualityTriageCopilotToolDependencies } from "./quality.js";
import { createRoutineDefinitionCopilotTools, createRoutineProposalCopilotTools } from "./routines.js";
import type { CopilotRoutineDefinitionPort, RoutineDefinitionCopilotToolDependencies, RoutineProposalCopilotToolDependencies } from "./routines.js";
import { createNeedsAttentionCopilotTools, createWorkspaceTriageCopilotTools } from "./triage.js";
import type { CopilotPendingApprovalsPort, CopilotTriageLogPort, WorkspaceTriageCopilotToolDependencies } from "./triage.js";
import { createWorkspaceSettingsCopilotTools } from "./settings.js";
import type { CopilotWorkspaceSettingsPort } from "./settings.js";

export type CopilotAgentPort = CopilotAgentConfigurationPort & CopilotAgentSkillsAgentPort & CopilotContextVariablesAgentPort;

export type CopilotToolCatalogDependencies = AgentConfigurationCopilotToolDependencies
  & ChatCopilotToolDependencies
  & Omit<AgentTurnProbeCopilotToolDependencies, "agentLookup">
  & DocumentSearchCopilotToolDependencies
  & DocumentStatusCopilotToolDependencies
  & DocumentKnowledgeCopilotToolDependencies
  & EvalCopilotToolDependencies
  & EvalVerificationCopilotToolDependencies
  & Omit<RetrievalProbeCopilotToolDependencies, "agentLookup">
  & QualityCopilotToolDependencies
  & QualityTriageCopilotToolDependencies
  & AudiencePulseCopilotToolDependencies
  & AgentSkillsCopilotToolDependencies
  & ContextVariablesCopilotToolDependencies
  & { readonly workspaceSettings: CopilotWorkspaceSettingsPort }
  & Omit<WorkspaceTriageCopilotToolDependencies, "agentLookup">
  & Omit<RoutineDefinitionCopilotToolDependencies, "agentLookup">
  & Omit<DirectiveProposalCopilotToolDependencies, "agentLookup">
  & Omit<RoutineProposalCopilotToolDependencies, "agentLookup">
  & Omit<AgentSettingProposalCopilotToolDependencies, "agentLookup">
  & Omit<AgentSkillConfigProposalCopilotToolDependencies, "agentLookup">
  & Omit<ContextVariableProposalCopilotToolDependencies, "agentLookup">
  & AgentProposalCopilotToolDependencies
  & WebsiteAnalysisProbeCopilotToolDependencies
  & DocumentProposalCopilotToolDependencies
  & IngestionSettingsProposalCopilotToolDependencies
  & WebsiteCrawlProposalCopilotToolDependencies;

/** Composition-only barrel; each descriptor remains published from its owner module. */
export const createCopilotToolDescriptors = (
  deps: CopilotToolCatalogDependencies,
): ReadonlyArray<CopilotToolDescriptor> => attachCopilotCapabilityProvenance([
  ...createAgentConfigurationCopilotTools(deps),
  ...createRoutineDefinitionCopilotTools({ ...deps, agentLookup: deps.agentService }),
  ...createChatCopilotTools(deps),
  ...createAgentTurnProbeCopilotTools({ ...deps, agentLookup: deps.agentService }),
  ...createDocumentSearchCopilotTools(deps),
  ...createEvalCopilotTools({ ...deps, agentLookup: deps.agentService }),
  ...createEvalVerificationCopilotTools(deps),
  ...createRetrievalProbeCopilotTools({ ...deps, agentLookup: deps.agentService }),
  ...createQualityCopilotTools({ ...deps, agentLookup: deps.agentService }),
  ...createQualityTriageCopilotTools(deps),
  ...createAudiencePulseCopilotTools(deps),
  ...createDocumentStatusCopilotTools(deps),
  ...createDocumentKnowledgeCopilotTools(deps),
  ...createAgentSkillsCopilotTools(deps),
  ...createContextVariablesCopilotTools(deps),
  ...createWorkspaceSettingsCopilotTools(deps),
  ...createWorkspaceTriageCopilotTools({ ...deps, agentLookup: deps.agentService }),
  ...createNeedsAttentionCopilotTools({ ...deps, agentLookup: deps.agentService }),
  ...createDirectiveProposalCopilotTools({ ...deps, agentLookup: deps.agentService }),
  ...createRoutineProposalCopilotTools({ ...deps, agentLookup: deps.agentService }),
  ...createAgentSettingProposalCopilotTools({ ...deps, agentLookup: deps.agentService }),
  ...createAgentSkillConfigProposalCopilotTools({ ...deps, agentLookup: deps.agentService }),
  ...createContextVariableProposalCopilotTools({ ...deps, agentLookup: deps.agentService }),
  ...createWebsiteAnalysisProbeCopilotTools(deps),
  ...createAgentProposalCopilotTools(deps),
  ...createDocumentProposalCopilotTools(deps),
  ...createIngestionSettingsProposalCopilotTools(deps),
  ...createWebsiteCrawlProposalCopilotTools(deps),
]);

export type { CopilotAgentSkillsPort, CopilotSkillCapabilityTargetsPort } from "./agentSkills.js";
export type { CopilotAudiencePulsePort } from "./audiencePulse.js";
export type { CopilotContextVariablesPort } from "./contextVariables.js";
export type { CopilotConversationHistoryPort } from "./chat.js";
export type { CopilotAgentTurnProbePort } from "./agentTurnProbe.js";
export type { CopilotDocumentChunksPort, CopilotDocumentMaintenancePort, CopilotDocumentSearchPort, CopilotDocumentSourceStatusPort, CopilotDocumentStatusPort } from "./documents.js";
export type { CopilotEvalResultsPort } from "./eval.js";
export type { CopilotQualitySignalsPort, CopilotQualityTriagePort } from "./quality.js";
export type { CopilotRetrievalProbePort } from "./retrievalProbe.js";
export type { CopilotRoutineDefinitionPort } from "./routines.js";
export type { CopilotWorkspaceSettingsPort } from "./settings.js";
export type { CopilotPendingApproval, CopilotPendingApprovalsPort, CopilotTriageLogPort } from "./triage.js";
