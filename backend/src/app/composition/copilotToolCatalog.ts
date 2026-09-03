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
  type CopilotReplyDraftPort,
  type CopilotQualityTriagePort,
  type CopilotRetrievalProbePort,
  type CopilotTriageLogPort,
  type CopilotRoutineDefinitionPort,
  type CopilotSkillCapabilityTargetsPort,
  type CopilotAudiencePulsePort,
  type CopilotContextVariablesPort,
  type CopilotWorkspaceSettingsPort,
} from "../../modules/operatorCopilot/tools/index.js";
import type { CopilotWebsiteAnalysisProbePort } from "../../modules/operatorCopilot/contracts/agentAuthoring.js";
import type {
  CopilotAgentSettingProposalAdapter,
  CopilotAgentSkillProposalAdapter,
  CopilotContextVariableProposalAdapter,
  CopilotDirectiveProposalAdapter,
  CopilotEvalCaseCapturePort,
  CopilotEvalCaseReplayPort,
  ProposalEvidenceDependencies,
  CopilotEvalSuiteProbePort,
  CopilotProposalAdapterRegistry,
  CopilotWorkspaceRouteKeyResolver,
} from "../../modules/operatorCopilot/public.js";
import type { CopilotDocumentAuthoringPort, CopilotDocumentSummary, CopilotWorkspaceAccountResolver } from "../../modules/operatorCopilot/contracts/documentAuthoring.js";
import type { CopilotWorkspaceSettingPort } from "../../modules/operatorCopilot/contracts/workspaceSettingAuthoring.js";
import type { PlatformSettingsService } from "../../modules/settings/composition.js";
import { websiteCrawlerCopilotPrimitives } from "../../modules/websiteCrawler/public.js";
import type { CopilotToolContribution, CopilotToolDescriptor } from "../../modules/operatorCopilot/public.js";
import { copilotApplicationPrimitiveRegistry, resolveCopilotToolContributions } from "../../modules/operatorCopilot/public.js";
import type { CopilotRepositoryPort } from "../../modules/operatorCopilot/public.js";
import type { CopilotAuditPort } from "../../modules/operatorCopilot/public.js";
import { enrichCopilotToolCatalog } from "../../modules/operatorCopilot/catalog.js";
import { assertCopilotCapabilityProvenance, assertCopilotCapabilityProvenanceRegistry } from "../../modules/operatorCopilot/capabilityProvenance.js";
import { createOpenApiDocument } from "../http/openapi/openApiDocument.js";
import { operationPermissionRequirements } from "../http/openapi/operationPermissionRequirements.js";
import { agentCopilotPrimitives } from "../../modules/agents/public.js";
import { agentWizardCopilotPrimitives } from "../../modules/agentWizard/public.js";
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
/**
 * Projects the ingestion service down to what the copilot may see. The port's type already omits a
 * document's body, but a type is a compile-time claim: the object composition injects still carries
 * `content` at runtime, so anything that reached it through a widening cast or a JSON dump would
 * carry the body with it. Selecting the fields here makes the boundary a runtime fact.
 */
export const createCopilotDocumentAuthoringPort = (
  documentIngestionService: {
    getDocument(workspaceId: string, documentId: string): Promise<CopilotDocumentSummary>;
    ingest: CopilotDocumentAuthoringPort["ingest"];
    updateRetrievalSettings: CopilotDocumentAuthoringPort["updateRetrievalSettings"];
  },
): CopilotDocumentAuthoringPort => ({
  getDocument: async (workspaceId, documentId) => {
    const document = await documentIngestionService.getDocument(workspaceId, documentId);
    return {
      id: document.id,
      title: document.title,
      status: document.status,
      metadata: document.metadata,
      retrievalEnabled: document.retrievalEnabled,
      retrievalExpiresAt: document.retrievalExpiresAt,
      updatedAt: document.updatedAt,
    };
  },
  ingest: (input) => documentIngestionService.ingest(input),
  updateRetrievalSettings: (input) => documentIngestionService.updateRetrievalSettings(input),
});

/**
 * Projects the platform settings service down to what the copilot may propose. Two things are
 * happening here, and both are boundaries rather than plumbing.
 *
 * The read drops the anonymous-chat and website-embed tokens and the embed snippet that carries
 * one. The port's type already omits them, but a type is a compile-time claim: selecting the
 * fields makes it a runtime fact, so no widening cast or JSON dump can put a token in a model
 * context.
 *
 * The write goes through the same service the dashboard's own settings page writes through, so an
 * applied proposal gets the embed validation and the channel audit events an operator's edit gets.
 * It names no rotation flag, which is why applying a proposal can never rotate a token.
 */
export const createCopilotWorkspaceSettingPort = (
  platformSettingsService: Pick<PlatformSettingsService, "getVersionedForWorkspace" | "applyForWorkspace">,
  workspaceAccount: CopilotWorkspaceAccountResolver,
): CopilotWorkspaceSettingPort => ({
  getForWorkspace: async (workspaceId) => {
    const { settings, updatedAt } = await platformSettingsService.getVersionedForWorkspace(workspaceId);
    return {
      assistantName: settings.assistant.assistantName,
      greetingInstruction: settings.assistant.greetingInstruction,
      assistantDefaultLocale: settings.assistant.assistantDefaultLocale,
      proactiveGreetingEnabled: settings.assistant.proactiveGreetingEnabled,
      suggestedQuestionsEnabled: settings.assistant.suggestedQuestionsEnabled,
      customInstruction: settings.assistant.customInstruction,
      anonymousChatEnabled: settings.channels.anonymousChatEnabled,
      websiteEmbedEnabled: settings.channels.websiteEmbedEnabled,
      websiteEmbedAllowedOrigins: settings.channels.websiteEmbedAllowedOrigins,
      websiteEmbedLauncherLabel: settings.channels.websiteEmbedLauncherLabel,
      websiteEmbedLauncherPosition: settings.channels.websiteEmbedLauncherPosition,
      updatedAt,
    };
  },
  updateForWorkspace: async (workspaceId, input, options) => platformSettingsService.applyForWorkspace(
    workspaceId,
    {
      assistant: {
        assistantName: input.assistantName,
        greetingInstruction: input.greetingInstruction,
        assistantDefaultLocale: input.assistantDefaultLocale,
        proactiveGreetingEnabled: input.proactiveGreetingEnabled,
        suggestedQuestionsEnabled: input.suggestedQuestionsEnabled,
        customInstruction: input.customInstruction,
      },
      channels: {
        anonymousChatEnabled: input.anonymousChatEnabled,
        websiteEmbedEnabled: input.websiteEmbedEnabled,
        websiteEmbedAllowedOrigins: [...input.websiteEmbedAllowedOrigins],
        websiteEmbedLauncherLabel: input.websiteEmbedLauncherLabel,
        websiteEmbedLauncherPosition: input.websiteEmbedLauncherPosition,
      },
    },
    {
      // Enabling a public channel writes an audit event, and an operator reviewing account activity
      // reads those by account. The dashboard route stamps this from the session; a proposal is
      // applied outside one, so the account is resolved from the workspace instead of left null.
      accountId: await workspaceAccount.resolveAccountId(workspaceId),
      ...(options?.expectedUpdatedAt ? { expectedUpdatedAt: options.expectedUpdatedAt } : {}),
    },
  ),
});

export const createCopilotWorkspaceAccountResolver = (
  deps: { readonly workspaceRepository: Pick<WorkspaceRepositoryPort, "findById"> },
): CopilotWorkspaceAccountResolver => ({
  resolveAccountId: async (workspaceId) => {
    const workspace = await deps.workspaceRepository.findById(workspaceId);
    if (!workspace) throw new Error("Copilot workspace no longer exists");
    return workspace.accountId;
  },
});

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
  readonly replyDraft: CopilotReplyDraftPort;
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
  readonly qualityTriageService: CopilotQualityTriagePort;
  readonly retrievalProbe: CopilotRetrievalProbePort;
  readonly websiteAnalysisProbe: CopilotWebsiteAnalysisProbePort;
  readonly audiencePulseService: CopilotAudiencePulsePort;
  readonly documentStatusService: CopilotDocumentStatusPort;
  readonly documentSourceStatusService: CopilotDocumentSourceStatusPort;
  readonly agentSkillsService: CopilotAgentSkillsPort;
  readonly skillCapabilityRegistry: CopilotSkillCapabilityTargetsPort;
  readonly contextVariables: CopilotContextVariablesPort;
  readonly workspaceSettings: CopilotWorkspaceSettingsPort;
  readonly proposalRepository: Pick<CopilotRepositoryPort, "createProposal">;
  readonly proposalAdapters: CopilotProposalAdapterRegistry;
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
    ...agentWizardCopilotPrimitives,
    ...agentSkillsCopilotPrimitives,
    ...chatCopilotPrimitives,
    ...contextVariableCopilotPrimitives,
    ...documentCopilotPrimitives,
    ...embeddingProfileCopilotPrimitives,
    ...evalCopilotPrimitives,
    ...retrievalCopilotPrimitives,
    ...routineCopilotPrimitives,
    ...settingsCopilotPrimitives,
    ...websiteCrawlerCopilotPrimitives,
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
