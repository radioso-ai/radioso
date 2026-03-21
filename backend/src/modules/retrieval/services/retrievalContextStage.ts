import type { RetrievalSettingsService } from "../../settings/services/retrievalSettingsService.js";
import { ConversationContextService } from "./conversationContextService.js";
import type { RetrievalContextStage as RetrievalContextStageContract, RetrievalPipelineRequest } from "./retrievalPipelineStages.js";

export class RetrievalContextStageService implements RetrievalContextStageContract {
  constructor(
    private readonly retrievalSettingsService: RetrievalSettingsService,
    private readonly conversationContextService: ConversationContextService,
  ) {}

  async execute(input: RetrievalPipelineRequest) {
    const settings = await this.retrievalSettingsService.getForWorkspace(input.workspaceId);
    const contextWindow = this.conversationContextService.select({
      history: input.history,
      query: input.query,
      rewriteCarryForwardLiterals: input.rewriteCarryForwardLiterals,
    });

    return {
      request: input,
      settings,
      contextWindow,
    };
  }
}
