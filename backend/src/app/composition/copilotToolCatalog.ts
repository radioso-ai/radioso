import type { AgentService } from "../../modules/agents/public.js";
import type { RoutineDefinitionService } from "../../modules/routines/public.js";
import {
  createUs1CopilotTools,
  type CopilotConversationHistoryPort,
  type CopilotDocumentSearchPort,
} from "../../modules/operatorCopilot/tools.js";
import type { CopilotToolDescriptor } from "../../modules/operatorCopilot/public.js";

/** Composition assembles module-owned reader contributions; it owns no tool behavior. */
export const createCopilotToolCatalog = (deps: {
  readonly agentService: Pick<AgentService, "get">;
  readonly routineDefinitionService: Pick<RoutineDefinitionService, "get">;
  readonly chatHistoryService: CopilotConversationHistoryPort;
  readonly documentSearchService: CopilotDocumentSearchPort;
}): ReadonlyArray<CopilotToolDescriptor> => createUs1CopilotTools(deps);
