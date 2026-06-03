import type { RetrievalSettingsService } from "../../settings/contracts/services.js";
import type { RetrievalSettingsRecord } from "../../settings/contracts/retrieval.js";
import { ConversationContextService } from "./conversationContextService.js";
import type { RetrievalContextStage as RetrievalContextStageContract, RetrievalPipelineRequest } from "./retrievalPipelineStages.js";

export interface SkillSettingsResolver {
  resolve(skill: string, defaults: RetrievalSettingsRecord, agentOverride: unknown): RetrievalSettingsRecord;
}

export class RetrievalContextStageService implements RetrievalContextStageContract {
  constructor(
    private readonly retrievalSettingsService: RetrievalSettingsService,
    private readonly conversationContextService: ConversationContextService,
    private readonly skillSettingsResolver?: SkillSettingsResolver,
  ) {}

  async execute(input: RetrievalPipelineRequest) {
    const baseSettings = await this.retrievalSettingsService.getForWorkspace(input.workspaceId);
    const agentResolvedSettings = this.skillSettingsResolver
      ? this.skillSettingsResolver.resolve(
          "retrieval.answer",
          baseSettings,
          input.agentSkillSettings?.["retrieval.answer"],
        )
      : baseSettings;
    const settings = input.retrievalSettingsOverride
      ? { ...agentResolvedSettings, ...input.retrievalSettingsOverride, workspaceId: baseSettings.workspaceId }
      : agentResolvedSettings;
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
