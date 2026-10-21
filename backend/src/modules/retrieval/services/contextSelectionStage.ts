import { RerankService } from "./rerankService.js";
import { PromptContextSelectorService } from "./promptContextSelectorService.js";
import { answerCandidatePoolSize, answerContextTopK } from "../domain/answerCandidatePool.js";
import { type Clock, formatIsoDateUtc, systemClock } from "../../../shared/domain/clock.js";
import type { CandidatePreparationStageResult, ContextSelectionStage as ContextSelectionStageContract } from "./retrievalPipelineStages.js";
import { getContextSelectionClauses } from "./retrievalShapeResolver.js";
import type { RerankedCandidate, RetrievedCandidate } from "../domain/retrievalPipelineTypes.js";
import { orderTemporalPromptContexts } from "./temporal/temporalContextOrdering.js";

export class ContextSelectionStageService implements ContextSelectionStageContract {
  constructor(
    private readonly rerankService: RerankService,
    private readonly promptContextSelectorService: PromptContextSelectorService,
    private readonly clock: Clock = systemClock,
  ) {}

  async execute(input: CandidatePreparationStageResult) {
    // A listing whose structured lookup found passages in the requested range answers from
    // them, so its prompt and the pool feeding it are sized to how many it found.
    const contextTopK = answerContextTopK(
      input.temporalQueryMode === "listing" && input.temporalDateRange !== undefined
        ? { requestedRangePassageCount: input.temporalContexts?.length ?? 0 }
        : {},
    );
    const clauses = getContextSelectionClauses(input.shapeSelection?.resolvedRun);
    const rerankEnabled = clauses.ranking.rerankMode === "disabled"
      ? false
      : input.settings.rerankEnabled;
    const rerankCandidateCount = answerCandidatePoolSize(input.settings.rerankTopK, contextTopK);
    const rerankCandidates = input.scoredCandidates.slice(0, rerankCandidateCount);
    const reranked = !rerankEnabled && clauses.ranking.lexicalBias === "preferred"
      ? {
          contexts: this.keepPreparedOrder(rerankCandidates, rerankCandidateCount),
          status: "skipped" as const,
        }
      : await this.rerankService.rerank({
          query: input.activeParsedQuery.semanticQuery || input.activeQuery,
          contexts: rerankCandidates,
          enabled: rerankEnabled,
          topK: rerankCandidateCount,
          workspaceContext: { workspaceId: input.request.workspaceId },
          usageContext: input.request.usageContext,
        });
    const temporalOrdering = orderTemporalPromptContexts({
      contexts: reranked.contexts,
      enabled: input.settings.temporalDeterministicSortEnabled ?? true,
      queryShape: input.rewrittenQuery?.structuredResult?.queryShape ?? input.shapeSelection?.queryShape,
      temporalQueryMode: input.temporalQueryMode ?? input.rewrittenQuery?.structuredResult?.temporalQueryMode,
      today: formatIsoDateUtc(this.clock()),
      dateRange: input.temporalDateRange,
    });
    const contexts = this.promptContextSelectorService.select({
      contexts: temporalOrdering.orderedContexts,
      topK: contextTopK,
    });

    return {
      ...input,
      rerankedContexts: reranked.contexts,
      rerankStatus: reranked.status,
      temporalDeterministicSortEnabled: input.settings.temporalDeterministicSortEnabled ?? true,
      temporalDeterministicSortApplied: temporalOrdering.applied,
      temporalDeterministicSortToday: temporalOrdering.today,
      temporalDeterministicSortDatedContextCount: temporalOrdering.datedContextCount,
      contexts,
    };
  }

  private keepPreparedOrder(contexts: RetrievedCandidate[], topK: number): RerankedCandidate[] {
    return contexts.slice(0, topK).map((context, index) => ({
      ...context,
      relevanceScore: context.similarity,
      rerankPosition: index,
    }));
  }
}
