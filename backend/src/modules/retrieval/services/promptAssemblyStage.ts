import { PromptBuilder } from "./promptBuilder.js";
import type { ContextSelectionStageResult, PromptAssemblyStage as PromptAssemblyStageContract } from "./retrievalPipelineStages.js";

export class PromptAssemblyStageService implements PromptAssemblyStageContract {
  constructor(private readonly promptBuilder: PromptBuilder) {}

  execute(input: ContextSelectionStageResult) {
    const prompt = this.promptBuilder.build({
      query: input.request.query,
      history: input.promptHistory,
      settings: {
        assistantIdentity: input.request.assistantIdentity,
        customInstruction: input.settings.customInstruction,
        conversationMode: input.settings.conversationMode,
        responseLanguagePolicy: input.rewrittenQuery.responseLanguagePolicy ?? "match_user_question",
      },
      contexts: input.contexts,
    });

    return {
      ...input,
      prompt: prompt.prompt,
      citations: prompt.citations,
      responseSettings: {
        citationDisplayEnabled: input.settings.citationDisplayEnabled,
        answerSupportPolicy: input.settings.answerSupportPolicy,
        conversationMode: input.settings.conversationMode,
        suggestedQuestionsEnabled: input.settings.suggestedQuestionsEnabled,
        suggestedQuestionsCount: input.settings.suggestedQuestionsCount,
        customInstruction: input.settings.customInstruction,
        responseLanguagePolicy: input.rewrittenQuery.responseLanguagePolicy ?? "match_user_question",
      },
    };
  }
}
