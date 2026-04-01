import { PromptBuilder } from "./promptBuilder.js";
import type { ContextSelectionStageResult, PromptAssemblyStage as PromptAssemblyStageContract } from "./retrievalPipelineStages.js";

export class PromptAssemblyStageService implements PromptAssemblyStageContract {
  constructor(private readonly promptBuilder: PromptBuilder) {}

  execute(input: ContextSelectionStageResult) {
    const prompt = this.promptBuilder.build({
      query: input.request.query,
      history: input.promptHistory,
      settings: {
        warmthLevel: input.settings.warmthLevel,
        customInstruction: input.settings.customInstruction,
      },
      contexts: input.contexts,
    });

    return {
      ...input,
      prompt: prompt.prompt,
      citations: prompt.citations,
      responseSettings: {
        warmthLevel: input.settings.warmthLevel,
        citationDisplayEnabled: input.settings.citationDisplayEnabled,
        answerSupportPolicy: input.settings.answerSupportPolicy,
      },
    };
  }
}
