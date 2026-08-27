import {
  createCopilotToolDescriptors,
  type CopilotAgentPort,
  type CopilotAgentSkillsPort,
  type CopilotConversationHistoryPort,
  type CopilotAgentTurnProbePort,
  type CopilotDocumentSearchPort,
  type CopilotDocumentSourceStatusPort,
  type CopilotDocumentStatusPort,
  type CopilotEvalResultsPort,
  type CopilotPendingApprovalsPort,
  type CopilotQualitySignalsPort,
  type CopilotTriageLogPort,
  type CopilotRoutineDefinitionPort,
  type CopilotSkillCapabilityTargetsPort,
  type CopilotAudiencePulsePort,
  type CopilotWorkspaceSettingsPort,
} from "../../modules/operatorCopilot/tools/index.js";
import type {
  CopilotAgentSettingProposalAdapter,
  CopilotAgentSkillProposalAdapter,
  CopilotDirectiveProposalAdapter,
  CopilotEvalCaseCapturePort,
  CopilotEvalCaseReplayPort,
  ProposalEvidenceDependencies,
  CopilotEvalSuiteProbePort,
  CopilotRoutineProposalAdapter,
  CopilotWorkspaceRouteKeyResolver,
} from "../../modules/operatorCopilot/public.js";
import type { CopilotToolDescriptor } from "../../modules/operatorCopilot/public.js";
import type { CopilotRepositoryPort } from "../../modules/operatorCopilot/public.js";
import type { CopilotAuditPort } from "../../modules/operatorCopilot/public.js";
import { enrichCopilotToolCatalog } from "../../modules/operatorCopilot/catalog.js";
import type { WorkspaceRepositoryPort } from "../../db/repositories/workspaceRepository.js";

/** Composition assembles module-owned reader contributions; it owns no tool behavior. */
export const createCopilotWorkspaceRouteKeyResolver = (
  deps: { readonly workspaceRepository: Pick<WorkspaceRepositoryPort, "findById"> },
): CopilotWorkspaceRouteKeyResolver => ({
  resolveWorkspaceKey: async (workspaceId) => {
    const workspace = await deps.workspaceRepository.findById(workspaceId);
    if (!workspace) throw new Error("Copilot workspace no longer exists");
    return workspace.publicRouteKey;
  },
});

export const createCopilotToolCatalog = (deps: {
  readonly agentService: CopilotAgentPort;
  readonly routineDefinitionService: CopilotRoutineDefinitionPort;
  readonly chatHistoryService: CopilotConversationHistoryPort;
  readonly agentTurnProbe: CopilotAgentTurnProbePort;
  readonly documentSearchService: CopilotDocumentSearchPort;
  readonly evalResultsService: CopilotEvalResultsPort;
  readonly pendingApprovals: CopilotPendingApprovalsPort;
  readonly evalCaseCapture: CopilotEvalCaseCapturePort;
  readonly evalSuiteProbe: CopilotEvalSuiteProbePort;
  readonly evalCaseReplay: CopilotEvalCaseReplayPort;
  readonly proposalEvidence: ProposalEvidenceDependencies;
  readonly qualitySignalsService: CopilotQualitySignalsPort;
  readonly audiencePulseService: CopilotAudiencePulsePort;
  readonly documentStatusService: CopilotDocumentStatusPort;
  readonly documentSourceStatusService: CopilotDocumentSourceStatusPort;
  readonly agentSkillsService: CopilotAgentSkillsPort;
  readonly skillCapabilityRegistry: CopilotSkillCapabilityTargetsPort;
  readonly workspaceSettings: CopilotWorkspaceSettingsPort;
  readonly proposalRepository: Pick<CopilotRepositoryPort, "createProposal">;
  readonly proposalAdapters: ReadonlyArray<CopilotDirectiveProposalAdapter | CopilotAgentSettingProposalAdapter | CopilotRoutineProposalAdapter | CopilotAgentSkillProposalAdapter>;
  readonly auditService: CopilotAuditPort;
  readonly workspaceRouteKeyResolver: CopilotWorkspaceRouteKeyResolver;
  readonly logger?: CopilotTriageLogPort;
}): ReadonlyArray<CopilotToolDescriptor> => enrichCopilotToolCatalog(createCopilotToolDescriptors(deps), deps.workspaceRouteKeyResolver);
