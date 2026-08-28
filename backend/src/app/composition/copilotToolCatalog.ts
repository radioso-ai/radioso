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
import { assertCopilotCapabilityProvenance, assertCopilotCapabilityProvenanceRegistry } from "../../modules/operatorCopilot/capabilityProvenance.js";
import { createOpenApiDocument } from "../http/openapi/openApiDocument.js";
import { operationPermissionRequirements } from "../http/openapi/operationPermissionRequirements.js";
import { agentCopilotPrimitives } from "../../modules/agents/public.js";
import { chatCopilotPrimitives } from "../../modules/chat/public.js";
import { documentCopilotPrimitives } from "../../modules/documents/public.js";
import { embeddingProfileCopilotPrimitives } from "../../modules/embeddingProfiles/public.js";
import { evalCopilotPrimitives } from "../../modules/eval/public.js";
import { routineCopilotPrimitives } from "../../modules/routines/public.js";
import { settingsCopilotPrimitives } from "../../modules/settings/public.js";
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
  readonly proposalAdapters: ReadonlyArray<CopilotDirectiveProposalAdapter | CopilotAgentSettingProposalAdapter | CopilotRoutineProposalAdapter>;
  readonly auditService: CopilotAuditPort;
  readonly workspaceRouteKeyResolver: CopilotWorkspaceRouteKeyResolver;
  readonly logger?: CopilotTriageLogPort;
}): ReadonlyArray<CopilotToolDescriptor> => {
  const descriptors = createCopilotToolDescriptors(deps);
  const publicOperationIds = new Set(Object.values(createOpenApiDocument().paths ?? {})
    .flatMap((path) => Object.values(path ?? {}))
    .flatMap((operation) => operation && typeof operation === "object" && "operationId" in operation && typeof operation.operationId === "string"
      ? [operation.operationId]
      : []));
  const ownerExportedPrimitiveIds = new Set([
    ...agentCopilotPrimitives,
    ...chatCopilotPrimitives,
    ...documentCopilotPrimitives,
    ...embeddingProfileCopilotPrimitives,
    ...evalCopilotPrimitives,
    ...routineCopilotPrimitives,
    ...settingsCopilotPrimitives,
  ]);
  assertCopilotCapabilityProvenanceRegistry(descriptors);
  assertCopilotCapabilityProvenance(descriptors, publicOperationIds, operationPermissionRequirements, ownerExportedPrimitiveIds);
  return enrichCopilotToolCatalog(descriptors, deps.workspaceRouteKeyResolver);
};
