import { PromptBuilder } from "./promptBuilder.js";
import type { ContextSelectionStageResult, PromptAssemblyStage as PromptAssemblyStageContract } from "./retrievalPipelineStages.js";

export class PromptAssemblyStageService implements PromptAssemblyStageContract {
  constructor(private readonly promptBuilder: PromptBuilder) {}

  execute(input: ContextSelectionStageResult) {
    const includeResponseBehavior = input.request.responseBehaviorEnabled ?? input.request.responseIdentity !== null;
    const responseBehavior = input.request.responseBehavior;
    const suggestedQuestionsEnabled = responseBehavior?.suggestedQuestionsEnabled ?? input.settings.suggestedQuestionsEnabled;
    const suggestedQuestionsCount = responseBehavior?.suggestedQuestionsCount ?? input.settings.suggestedQuestionsCount;
    const customInstruction = responseBehavior?.customInstruction ?? input.settings.customInstruction;
    const prompt = this.promptBuilder.build({
      query: input.request.query,
      retrievalQuery: input.activeQuery,
      history: input.promptHistory,
      settings: {
        responseIdentity: input.request.responseIdentity,
        customInstruction: includeResponseBehavior ? customInstruction : undefined,
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
        suggestedQuestionsEnabled: includeResponseBehavior ? suggestedQuestionsEnabled : false,
        suggestedQuestionsCount: includeResponseBehavior ? suggestedQuestionsCount : 0,
        customInstruction: includeResponseBehavior ? customInstruction : undefined,
        responseLanguagePolicy: input.rewrittenQuery.responseLanguagePolicy ?? "match_user_question",
      },
    };
  }
}
