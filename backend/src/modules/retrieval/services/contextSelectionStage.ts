import { RerankService } from "./rerankService.js";
import { PromptContextSelectorService } from "./promptContextSelectorService.js";
import { RETRIEVAL_BEHAVIOR } from "../../../shared/domain/behaviorConfig.js";
import type { CandidatePreparationStageResult, ContextSelectionStage as ContextSelectionStageContract } from "./retrievalPipelineStages.js";

export class ContextSelectionStageService implements ContextSelectionStageContract {
  constructor(
    private readonly rerankService: RerankService,
    private readonly promptContextSelectorService: PromptContextSelectorService,
  ) {}

  async execute(input: CandidatePreparationStageResult) {
    const rerankCandidateCount = Math.min(input.settings.rerankTopK, RETRIEVAL_BEHAVIOR.rerank.candidateLimit);
    const rerankCandidates = input.scoredCandidates.slice(0, rerankCandidateCount);
    const reranked = await this.rerankService.rerank({
      query: input.activeParsedQuery.semanticQuery || input.activeQuery,
      contexts: rerankCandidates,
      enabled: input.settings.rerankEnabled,
      topK: input.settings.rerankTopK,
    });
    const contexts = this.promptContextSelectorService.select({
      contexts: reranked.contexts,
      topK: RETRIEVAL_BEHAVIOR.finalContextTopK,
    });

    return {
      ...input,
      rerankedContexts: reranked.contexts,
      rerankStatus: reranked.status,
      contexts,
    };
  }
}
