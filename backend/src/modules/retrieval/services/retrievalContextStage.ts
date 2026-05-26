import type { RetrievalSettingsService } from "../../settings/contracts/services.js";
import { ConversationContextService } from "./conversationContextService.js";
import type { RetrievalContextStage as RetrievalContextStageContract, RetrievalPipelineRequest } from "./retrievalPipelineStages.js";

export class RetrievalContextStageService implements RetrievalContextStageContract {
  constructor(
    private readonly retrievalSettingsService: RetrievalSettingsService,
    private readonly conversationContextService: ConversationContextService,
  ) {}

  async execute(input: RetrievalPipelineRequest) {
    const baseSettings = await this.retrievalSettingsService.getForWorkspace(input.workspaceId);
    const settings = input.retrievalSettingsOverride
      ? { ...baseSettings, ...input.retrievalSettingsOverride, workspaceId: baseSettings.workspaceId }
      : baseSettings;
    const contextWindow = this.conversationContextService.select({
      history: input.history,
    });

    return {
      request: input,
      settings,
      contextWindow,
    };
  }
}
