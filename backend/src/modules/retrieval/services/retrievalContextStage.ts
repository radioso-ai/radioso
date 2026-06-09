import type { RetrievalSettingsRecord } from "../../settings/contracts/retrieval.js";
import type { RetrievalDefaultsProvider } from "../domain/retrievalDefaultsProvider.js";
import { ConversationContextService } from "./conversationContextService.js";
import type { RetrievalContextStage as RetrievalContextStageContract, RetrievalPipelineRequest } from "./retrievalPipelineStages.js";

export interface SkillSettingsResolver {
  resolve(skill: string, defaults: RetrievalSettingsRecord, agentOverride: unknown): RetrievalSettingsRecord;
}

export class RetrievalContextStageService implements RetrievalContextStageContract {
  constructor(
    private readonly retrievalDefaultsProvider: RetrievalDefaultsProvider,
    private readonly conversationContextService: ConversationContextService,
    private readonly skillSettingsResolver?: SkillSettingsResolver,
  ) {}

  async execute(input: RetrievalPipelineRequest) {
    const baseSettings = this.retrievalDefaultsProvider.getDefaults(input.workspaceId);
    const agentResolvedSettings = this.skillSettingsResolver
      ? this.skillSettingsResolver.resolve(
          "retrieval.answer",
          baseSettings,
          input.agentSkillSettings?.["retrieval.answer"],
        )
      : baseSettings;
    const settings = input.retrievalSettingsOverride
      ? { ...agentResolvedSettings, ...input.retrievalSettingsOverride, workspaceId: input.workspaceId }
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
