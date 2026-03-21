import { RerankService } from "./rerankService.js";
import { PromptContextSelectorService } from "./promptContextSelectorService.js";
import type { CandidatePreparationStageResult, ContextSelectionStage as ContextSelectionStageContract } from "./retrievalPipelineStages.js";

export class ContextSelectionStageService implements ContextSelectionStageContract {
  constructor(
    private readonly rerankService: RerankService,
    private readonly promptContextSelectorService: PromptContextSelectorService,
  ) {}

  async execute(input: CandidatePreparationStageResult) {
    const reranked = await this.rerankService.rerank({
      query: input.activeParsedQuery.semanticQuery || input.activeQuery,
      contexts: input.scoredCandidates,
      enabled: input.settings.rerankEnabled,
      topK: input.settings.rerankTopK,
    });
    const contexts = this.promptContextSelectorService.select({
      contexts: reranked.contexts,
      topK: input.settings.rerankTopK,
    });

    return {
      ...input,
      rerankedContexts: reranked.contexts,
      rerankStatus: reranked.status,
      contexts,
    };
  }
}
