import {
  createCopilotToolDescriptors,
  type CopilotAgentPort,
  type CopilotAgentSkillsPort,
  type CopilotConversationHistoryPort,
  type CopilotAgentTurnProbePort,
  type CopilotDocumentSearchPort,
  type CopilotDocumentChunksPort,
  type CopilotDocumentMaintenancePort,
  type CopilotDocumentSourceStatusPort,
  type CopilotDocumentStatusPort,
  type CopilotEvalResultsPort,
  type CopilotPendingApprovalsPort,
  type CopilotQualitySignalsPort,
  type CopilotRetrievalProbePort,
  type CopilotTriageLogPort,
  type CopilotRoutineDefinitionPort,
  type CopilotSkillCapabilityTargetsPort,
  type CopilotAudiencePulsePort,
  type CopilotContextVariablesPort,
  type CopilotWorkspaceSettingsPort,
} from "../../modules/operatorCopilot/tools/index.js";
import type {
  CopilotAgentSettingProposalAdapter,
  CopilotAgentSkillProposalAdapter,
  CopilotContextVariableProposalAdapter,
  CopilotDirectiveProposalAdapter,
  CopilotEvalCaseCapturePort,
  CopilotEvalCaseReplayPort,
  ProposalEvidenceDependencies,
  CopilotEvalSuiteProbePort,
  CopilotRoutineProposalAdapter,
  CopilotWorkspaceRouteKeyResolver,
} from "../../modules/operatorCopilot/public.js";
import type { CopilotToolContribution, CopilotToolDescriptor } from "../../modules/operatorCopilot/public.js";
import { copilotApplicationPrimitiveRegistry, resolveCopilotToolContributions } from "../../modules/operatorCopilot/public.js";
import type { CopilotRepositoryPort } from "../../modules/operatorCopilot/public.js";
import type { CopilotAuditPort } from "../../modules/operatorCopilot/public.js";
import { enrichCopilotToolCatalog } from "../../modules/operatorCopilot/catalog.js";
import { assertCopilotCapabilityProvenance, assertCopilotCapabilityProvenanceRegistry } from "../../modules/operatorCopilot/capabilityProvenance.js";
import { createOpenApiDocument } from "../http/openapi/openApiDocument.js";
import { operationPermissionRequirements } from "../http/openapi/operationPermissionRequirements.js";
import { agentCopilotPrimitives } from "../../modules/agents/public.js";
import { agentSkillsCopilotPrimitives } from "../../modules/agentSkills/public.js";
import { chatCopilotPrimitives } from "../../modules/chat/public.js";
import { documentCopilotPrimitives } from "../../modules/documents/public.js";
import { embeddingProfileCopilotPrimitives } from "../../modules/embeddingProfiles/public.js";
import { evalCopilotPrimitives } from "../../modules/eval/public.js";
import { retrievalCopilotPrimitives } from "../../modules/retrieval/public.js";
import { routineCopilotPrimitives } from "../../modules/routines/public.js";
import { settingsCopilotPrimitives } from "../../modules/settings/public.js";
import { contextVariableCopilotPrimitives } from "../../modules/context-variables/public.js";
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
  readonly documentChunks: CopilotDocumentChunksPort;
  readonly documentMaintenance: CopilotDocumentMaintenancePort;
  readonly evalResultsService: CopilotEvalResultsPort;
  readonly pendingApprovals: CopilotPendingApprovalsPort;
  readonly evalCaseCapture: CopilotEvalCaseCapturePort;
  readonly evalSuiteProbe: CopilotEvalSuiteProbePort;
  readonly evalCaseReplay: CopilotEvalCaseReplayPort;
  readonly proposalEvidence: ProposalEvidenceDependencies;
  readonly qualitySignalsService: CopilotQualitySignalsPort;
  readonly retrievalProbe: CopilotRetrievalProbePort;
  readonly audiencePulseService: CopilotAudiencePulsePort;
  readonly documentStatusService: CopilotDocumentStatusPort;
  readonly documentSourceStatusService: CopilotDocumentSourceStatusPort;
  readonly agentSkillsService: CopilotAgentSkillsPort;
  readonly skillCapabilityRegistry: CopilotSkillCapabilityTargetsPort;
  readonly contextVariables: CopilotContextVariablesPort;
  readonly workspaceSettings: CopilotWorkspaceSettingsPort;
  readonly proposalRepository: Pick<CopilotRepositoryPort, "createProposal">;
  readonly proposalAdapters: ReadonlyArray<CopilotDirectiveProposalAdapter | CopilotAgentSettingProposalAdapter | CopilotRoutineProposalAdapter | CopilotAgentSkillProposalAdapter | CopilotContextVariableProposalAdapter>;
  readonly auditService: CopilotAuditPort;
  readonly workspaceRouteKeyResolver: CopilotWorkspaceRouteKeyResolver;
  readonly logger?: CopilotTriageLogPort;
  /**
   * Tools contributed by application modules outside this repository's first-party catalog. They
   * are merged before governance and enrichment so permission filtering, authorization re-checks,
   * duplicate-name rejection, and dashboard handoffs apply to them with no special case.
   */
  readonly toolContributions?: ReadonlyArray<CopilotToolContribution>;
}): ReadonlyArray<CopilotToolDescriptor> => {
  const firstPartyDescriptors = createCopilotToolDescriptors(deps);
  const publicOperationIds = new Set(Object.values(createOpenApiDocument().paths ?? {})
    .flatMap((path) => Object.values(path ?? {}))
    .flatMap((operation) => operation && typeof operation === "object" && "operationId" in operation && typeof operation.operationId === "string"
      ? [operation.operationId]
      : []));
  const ownerExportedPrimitiveIds = new Set([
    ...agentCopilotPrimitives,
    ...agentSkillsCopilotPrimitives,
    ...chatCopilotPrimitives,
    ...contextVariableCopilotPrimitives,
    ...documentCopilotPrimitives,
    ...embeddingProfileCopilotPrimitives,
    ...evalCopilotPrimitives,
    ...retrievalCopilotPrimitives,
    ...routineCopilotPrimitives,
    ...settingsCopilotPrimitives,
  ]);
  // Reviewed first-party coverage, so it stays a bijection with the first-party descriptors alone.
  // Running it over the merged catalog would report every contributed descriptor as ungoverned and
  // force this repository to enumerate identities it does not own.
  assertCopilotCapabilityProvenanceRegistry(firstPartyDescriptors);
  const contributed = resolveCopilotToolContributions(deps.toolContributions ?? [], {
    operationIds: publicOperationIds,
    applicationPrimitiveIds: new Set(Object.keys(copilotApplicationPrimitiveRegistry)),
  });
  const descriptors = [...firstPartyDescriptors, ...contributed.descriptors];
  assertCopilotCapabilityProvenance(descriptors, {
    publicOperationIds: new Set([...publicOperationIds, ...contributed.operationIds]),
    operationPermissions: { ...operationPermissionRequirements, ...contributed.operationPermissions },
    ownerExportedPrimitiveIds: new Set([...ownerExportedPrimitiveIds, ...contributed.applicationPrimitiveIds]),
    applicationPrimitiveIds: new Set([...Object.keys(copilotApplicationPrimitiveRegistry), ...contributed.applicationPrimitiveIds]),
  });
  return enrichCopilotToolCatalog(descriptors, deps.workspaceRouteKeyResolver);
};
