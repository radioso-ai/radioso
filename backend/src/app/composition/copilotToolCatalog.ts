import type { AgentService } from "../../modules/agents/public.js";
import type { RoutineDefinitionService } from "../../modules/routines/public.js";
import {
  createUs1CopilotTools,
  createUs2CopilotTools,
  createUs3CopilotTools,
  type CopilotAgentSettingProposalAdapter,
  type CopilotConversationHistoryPort,
  type CopilotDocumentSearchPort,
  type CopilotDirectiveProposalAdapter,
  type CopilotEvalResultsPort,
  type CopilotQualitySignalsPort,
  type CopilotAudiencePulsePort,
} from "../../modules/operatorCopilot/tools.js";
import type { CopilotToolDescriptor } from "../../modules/operatorCopilot/public.js";
import type { CopilotRepositoryPort } from "../../modules/operatorCopilot/public.js";
import type { CopilotAuditPort } from "../../modules/operatorCopilot/public.js";

/** Composition assembles module-owned reader contributions; it owns no tool behavior. */
export const createCopilotToolCatalog = (deps: {
  readonly agentService: Pick<AgentService, "get">;
  readonly routineDefinitionService: Pick<RoutineDefinitionService, "get">;
  readonly chatHistoryService: CopilotConversationHistoryPort;
  readonly documentSearchService: CopilotDocumentSearchPort;
  readonly evalResultsService: CopilotEvalResultsPort;
  readonly qualitySignalsService: CopilotQualitySignalsPort;
  readonly audiencePulseService: CopilotAudiencePulsePort;
  readonly proposalRepository: Pick<CopilotRepositoryPort, "createProposal">;
  readonly proposalAdapters: ReadonlyArray<CopilotDirectiveProposalAdapter | CopilotAgentSettingProposalAdapter>;
  readonly auditService: CopilotAuditPort;
}): ReadonlyArray<CopilotToolDescriptor> => [
  ...createUs1CopilotTools(deps),
  ...createUs2CopilotTools(deps),
  ...createUs3CopilotTools(deps),
];
