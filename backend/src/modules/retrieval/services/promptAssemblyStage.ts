import { PromptBuilder } from "./promptBuilder.js";
import type { ContextSelectionStageResult, PromptAssemblyStage as PromptAssemblyStageContract } from "./retrievalPipelineStages.js";

export class PromptAssemblyStageService implements PromptAssemblyStageContract {
  constructor(private readonly promptBuilder: PromptBuilder) {}

  execute(input: ContextSelectionStageResult) {
    const includeResponseBehavior = input.request.responseBehaviorEnabled ?? input.request.responseIdentity !== null;
    const prompt = this.promptBuilder.build({
      query: input.request.query,
      retrievalQuery: input.activeQuery,
      history: input.promptHistory,
      settings: {
        responseIdentity: input.request.responseIdentity,
        customInstruction: includeResponseBehavior ? input.settings.customInstruction : undefined,
        conversationMode: includeResponseBehavior ? input.settings.conversationMode : undefined,
        responseLanguagePolicy: input.rewrittenQuery.responseLanguagePolicy ?? "match_user_question",
        responseLanguage: input.rewrittenQuery.structuredResult?.responseLanguage,
      },
      intentTopic: input.rewrittenQuery.structuredResult?.intentTopic,
      inScopeRequest: input.rewrittenQuery.structuredResult?.inScopeRequest,
      outsideScopeRequest: input.rewrittenQuery.structuredResult?.outsideScopeRequest,
      contexts: input.contexts,
    });

    return {
      ...input,
      systemPrompt: prompt.systemPrompt,
      prompt: prompt.prompt,
      citations: prompt.citations,
      responseSettings: {
        citationDisplayEnabled: input.settings.citationDisplayEnabled,
        answerSupportValidationEnabled: input.settings.answerSupportValidationEnabled ?? true,
        conversationMode: includeResponseBehavior ? input.settings.conversationMode : "factual",
        suggestedQuestionsEnabled: includeResponseBehavior ? input.settings.suggestedQuestionsEnabled : false,
        suggestedQuestionsCount: includeResponseBehavior ? input.settings.suggestedQuestionsCount : 0,
        customInstruction: includeResponseBehavior ? input.settings.customInstruction : undefined,
        responseLanguagePolicy: input.rewrittenQuery.responseLanguagePolicy ?? "match_user_question",
      },
    };
  }
}
