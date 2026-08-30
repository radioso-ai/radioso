import type { CopilotCapabilityProvenance, CopilotToolDescriptor } from "./contracts.js";
import { copilotApplicationPrimitiveRegistry, copilotRayOwnedPrimitiveIds } from "./applicationPrimitiveRegistry.js";

type ProductionDescriptorName =
  | "agent_configuration" | "agent_skills" | "audience_topics" | "context_variables"
  | "conversation_history_search"
  | "conversation_transcript" | "create_eval_case_from_turn" | "document_search" | "document_status"
  | "eval_results" | "propose_agent_setting" | "propose_context_variable" | "propose_directive"
  | "propose_directive_removal" | "propose_routine"
  | "propose_routine_edit" | "propose_routine_lifecycle" | "propose_skill_config" | "quality_signals"
  | "replay_eval_case"
  | "routine_definition" | "run_eval_suite" | "test_agent_turn" | "turn_trace" | "validate_routine"
  | "workspace_settings" | "workspace_triage";

const rayOnly = (reason: string) => ({ rayOnly: { reason } }) as const;

/**
 * Catalog-owned declarations keep descriptor factories focused on their model
 * shape and owner ports. The complete production assembly applies this map and
 * governance rejects any descriptor omitted from it.
 */
export const copilotCapabilityProvenance: Readonly<Record<ProductionDescriptorName, CopilotCapabilityProvenance>> = {
  agent_configuration: { backingOperationIds: ["listAgents", "getAgent", "listAgentDirectives"], applicationPrimitiveIds: ["agents.configuration.read"] },
  agent_skills: { backingOperationIds: ["listAgentSkills", "listAgentSkillCapabilities"], applicationPrimitiveIds: ["agents.configuration.read"] },
  audience_topics: { backingOperationIds: ["getAudiencePulse", "getAudiencePulseRefreshStatus"] },
  context_variables: { backingOperationIds: ["listContextVariables", "listAgentContextVariables"], applicationPrimitiveIds: ["agents.configuration.read"] },
  conversation_history_search: { backingOperationIds: ["listHistory", "listChatHistory", "listHistorySearches", "getHistorySearch"] },
  conversation_transcript: { backingOperationIds: ["getHistoryConversation", "tailHistoryConversation", "getLegacyHistoryConversation"], applicationPrimitiveIds: ["chat.conversation.identity.read"] },
  create_eval_case_from_turn: { backingOperationIds: ["getOrCreateEvalCaseBySourceMessage"], applicationPrimitiveIds: ["eval.case.capture"] },
  document_search: { backingOperationIds: ["searchDocuments", "getDocument"], applicationPrimitiveIds: ["documents.source-status.read"] },
  document_status: { backingOperationIds: ["listDocuments", "listDocumentSources", "listDocumentsBySource"], applicationPrimitiveIds: ["documents.status.read", "documents.source-status.read"] },
  eval_results: { backingOperationIds: ["listEvalCases"] },
  propose_agent_setting: { backingOperationIds: ["updateAgent"], applicationPrimitiveIds: ["agents.setting.propose", "operatorCopilot.proposal.create"], ...rayOnly("Ray persists an operator-reviewable draft before the agent service receives a setting mutation.") },
  propose_context_variable: { backingOperationIds: ["createContextVariable", "updateContextVariable", "upsertAgentContextVariable"], applicationPrimitiveIds: ["contextVariables.definition.propose", "operatorCopilot.proposal.create"], ...rayOnly("Ray persists an operator-reviewable draft before the context-variable service applies a definition or enablement mutation.") },
  propose_directive: { backingOperationIds: ["createAgentDirective", "updateAgentDirective"], applicationPrimitiveIds: ["agents.directive.propose", "operatorCopilot.proposal.create"], ...rayOnly("Ray presents directive coaching as a pending, operator-confirmed proposal.") },
  propose_directive_removal: { backingOperationIds: ["deleteAgentDirective"], applicationPrimitiveIds: ["agents.directive.propose", "operatorCopilot.proposal.create"], ...rayOnly("Ray presents directive removal as a pending, operator-confirmed proposal, the same as any other directive change.") },
  propose_routine: { backingOperationIds: ["createAgentRoutine"], applicationPrimitiveIds: ["routines.proposal.prepare", "operatorCopilot.proposal.create"], ...rayOnly("Ray drafts routine evidence and review state; routine lifecycle authority remains in the routine service.") },
  propose_routine_edit: { backingOperationIds: ["updateAgentRoutine", "reviseAgentRoutine"], applicationPrimitiveIds: ["routines.proposal.prepare", "operatorCopilot.proposal.create"], ...rayOnly("Ray-specific stale-draft guards protect a proposal without expanding routine mutation authority.") },
  propose_routine_lifecycle: { backingOperationIds: ["publishAgentRoutine", "archiveAgentRoutine", "restoreAgentRoutine"], applicationPrimitiveIds: ["routines.proposal.prepare", "operatorCopilot.proposal.create"], ...rayOnly("Ray records an operator-confirmed lifecycle proposal while the routine service enforces transitions.") },
  propose_skill_config: { backingOperationIds: ["createAgentSkill", "updateAgentSkill"], applicationPrimitiveIds: ["agentSkills.config.propose", "operatorCopilot.proposal.create"], ...rayOnly("Ray persists an operator-reviewable draft before the agent skill service receives a configuration mutation.") },
  quality_signals: { backingOperationIds: ["listLowQualityTurns", "getQualityStats"] },
  replay_eval_case: { backingOperationIds: ["createEvalRun"], applicationPrimitiveIds: ["eval.case.replay"], ...rayOnly("Ray replays a selected case and carries bounded proposal evidence rather than exposing a general eval-run surface.") },
  routine_definition: { backingOperationIds: ["listAgentRoutines", "getAgentRoutine"], applicationPrimitiveIds: ["routines.definition.read"] },
  run_eval_suite: { backingOperationIds: ["runEvalCases"], applicationPrimitiveIds: ["eval.suite.run"] },
  test_agent_turn: { backingOperationIds: ["createAssistantChatResponse"], applicationPrimitiveIds: ["operatorCopilot.safe-test.orchestration"], ...rayOnly("Ray adds operator provenance, bounded projection, and proposal evidence to the generic safe-test turn.") },
  turn_trace: { applicationPrimitiveIds: ["chat.conversation.trace.read"] },
  validate_routine: { backingOperationIds: ["validateAgentRoutine"], applicationPrimitiveIds: ["routines.validation"] },
  workspace_settings: { backingOperationIds: ["getPlatformSettings", "getSettingsRetrievalDefaults", "getIngestionSettings", "getEmbeddingCoverage", "getGeneralSettings", "getWorkspaceLlmModels"], applicationPrimitiveIds: ["settings.workspace.read", "embedding.coverage.read"] },
  workspace_triage: { applicationPrimitiveIds: ["operatorCopilot.workspace-triage"], ...rayOnly("Ray composes authorized source summaries into a ranked operator triage projection.") },
};

export const attachCopilotCapabilityProvenance = (
  descriptors: ReadonlyArray<CopilotToolDescriptor>,
): ReadonlyArray<CopilotToolDescriptor> => descriptors.map((descriptor) => ({
  ...descriptor,
  capabilityProvenance: copilotCapabilityProvenance[descriptor.name as ProductionDescriptorName],
}));

/**
 * The registry is reviewed coverage, so it must be a bijection with the assembled catalog:
 * missing entries leave a descriptor ungoverned and stale entries turn a removed capability into
 * false coverage. Keep this separate from per-descriptor validation so focused fixture tests can
 * validate individual declarations without pretending to assemble production.
 */
export const assertCopilotCapabilityProvenanceRegistry = (
  descriptors: ReadonlyArray<CopilotToolDescriptor>,
  provenance: Readonly<Record<string, CopilotCapabilityProvenance>> = copilotCapabilityProvenance,
): void => {
  const descriptorNames = new Set(descriptors.map((descriptor) => descriptor.name));
  const provenanceNames = new Set(Object.keys(provenance));
  const missing = [...descriptorNames].filter((name) => !provenanceNames.has(name));
  if (missing.length > 0) throw new Error(`Missing copilot capability provenance: ${missing.sort().join(", ")}`);
  const stale = [...provenanceNames].filter((name) => !descriptorNames.has(name));
  if (stale.length > 0) throw new Error(`Stale copilot capability provenance: ${stale.sort().join(", ")}`);
};

export const assertCopilotCapabilityProvenance = (
  descriptors: ReadonlyArray<CopilotToolDescriptor>,
  publicOperationIds: ReadonlySet<string>,
  operationPermissions: Readonly<Record<string, readonly string[]>> = {},
  ownerExportedPrimitiveIds: ReadonlySet<string> = new Set(),
): void => {
  const seen = new Set<string>();
  for (const descriptor of descriptors) {
    if (seen.has(descriptor.name)) throw new Error(`Duplicate copilot descriptor: ${descriptor.name}`);
    seen.add(descriptor.name);
    const provenance = descriptor.capabilityProvenance;
    if (!provenance) throw new Error(`Missing capability provenance for copilot descriptor: ${descriptor.name}`);
    const operationIds = provenance.backingOperationIds ?? [];
    const primitiveIds = provenance.applicationPrimitiveIds ?? [];
    const reason = provenance.rayOnly?.reason.trim();
    if (provenance.rayOnly && !reason) throw new Error(`Copilot descriptor ${descriptor.name} has an empty Ray-only reason`);
    if (operationIds.length === 0 && primitiveIds.length === 0 && !reason) throw new Error(`Copilot descriptor ${descriptor.name} has no backing identity or Ray-only reason`);
    if (new Set(operationIds).size !== operationIds.length || new Set(primitiveIds).size !== primitiveIds.length) throw new Error(`Copilot descriptor ${descriptor.name} declares duplicate capability identities`);
    for (const operationId of operationIds) if (!publicOperationIds.has(operationId)) throw new Error(`Unknown public operation identity: ${operationId}`);
    // Supplementary owner primitives and Ray-only safety may explain composition, but never
    // weaken a descriptor's ordinary authorization when it represents one public operation.
    if (operationIds.length === 1) {
      const requiredByOperation = operationPermissions[operationIds[0]!];
      if (!requiredByOperation) throw new Error(`Missing HTTP permission requirement for one-to-one operation: ${operationIds[0]}`);
      if (!requiredByOperation.every((permission) => descriptor.requiredPermissions.includes(permission as never))) {
        throw new Error(`Copilot descriptor ${descriptor.name} weakens permission parity for ${operationIds[0]}`);
      }
    }
    for (const primitiveId of primitiveIds) {
      if (!(primitiveId in copilotApplicationPrimitiveRegistry)) throw new Error(`Unknown application primitive identity: ${primitiveId}`);
      if (!copilotRayOwnedPrimitiveIds.includes(primitiveId as never) && !ownerExportedPrimitiveIds.has(primitiveId)) {
        throw new Error(`Application primitive is not exported by its owning module: ${primitiveId}`);
      }
    }
  }
};
