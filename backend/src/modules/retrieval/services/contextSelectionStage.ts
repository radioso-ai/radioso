import { RerankService } from "./rerankService.js";
import { PromptContextSelectorService } from "./promptContextSelectorService.js";
import { RETRIEVAL_BEHAVIOR } from "../../../shared/domain/behaviorConfig.js";
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
    const finalContextTopK = RETRIEVAL_BEHAVIOR.finalContextTopK;
    const clauses = getContextSelectionClauses(input.shapeSelection?.resolvedRun);
    const rerankEnabled = clauses.ranking.rerankMode === "disabled"
      ? false
      : input.settings.rerankEnabled;
    const rerankCandidateCount = Math.min(
      Math.max(input.settings.rerankTopK, finalContextTopK),
      RETRIEVAL_BEHAVIOR.rerank.candidateLimit,
    );
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
    });
    const contexts = this.promptContextSelectorService.select({
      contexts: temporalOrdering.orderedContexts,
      topK: finalContextTopK,
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
