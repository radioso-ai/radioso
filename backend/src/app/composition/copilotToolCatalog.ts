import type { AgentService } from "../../modules/agents/public.js";
import type { RoutineDefinitionService } from "../../modules/routines/public.js";
import type { ChatHistoryService } from "../../modules/chat/services/chatHistoryService.js";
import type { DocumentSearchService } from "../../modules/documents/services/documentSearchService.js";
import { createUs1CopilotTools } from "../../modules/operatorCopilot/tools.js";
import type { CopilotToolDescriptor } from "../../modules/operatorCopilot/public.js";

/** Composition assembles module-owned reader contributions; it owns no tool behavior. */
export const createCopilotToolCatalog = (deps: {
  readonly agentService: Pick<AgentService, "get">;
  readonly routineDefinitionService: Pick<RoutineDefinitionService, "get">;
  readonly chatHistoryService: Pick<ChatHistoryService, "getConversation" | "listConversations">;
  readonly documentSearchService: Pick<DocumentSearchService, "search">;
}): ReadonlyArray<CopilotToolDescriptor> => createUs1CopilotTools(deps);
