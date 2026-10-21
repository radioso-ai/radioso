import { RerankService } from "./rerankService.js";
import { PromptContextSelectorService } from "./promptContextSelectorService.js";
import { answerCandidatePoolSize } from "../domain/answerCandidatePool.js";
import { RETRIEVAL_BEHAVIOR } from "../../../shared/domain/behaviorConfig.js";
import { type Clock, formatIsoDateUtc, systemClock } from "../../../shared/domain/clock.js";
import type { CandidatePreparationStageResult, ContextSelectionStage as ContextSelectionStageContract } from "./retrievalPipelineStages.js";
import { getContextSelectionClauses } from "./retrievalShapeResolver.js";
import type {
  FinalPromptContext,
  RerankedCandidate,
  RerankStatus,
  RetrievedCandidate,
} from "../domain/retrievalPipelineTypes.js";
import type { RequestedDateRange } from "../domain/temporal/requestedDateRange.js";
import { orderTemporalPromptContexts } from "./temporal/temporalContextOrdering.js";
import { composeRangeAnswerPool, rangeAnswerSelectionStages } from "./temporal/rangeAnswerComposer.js";

interface SelectedContexts {
  rerankedContexts: RerankedCandidate[];
  rerankStatus: RerankStatus;
  temporalOrdering: { applied: boolean; today: string; datedContextCount: number };
  contexts: FinalPromptContext[];
}

export class ContextSelectionStageService implements ContextSelectionStageContract {
  constructor(
    private readonly rerankService: RerankService,
    private readonly promptContextSelectorService: PromptContextSelectorService,
    private readonly clock: Clock = systemClock,
  ) {}

  async execute(input: CandidatePreparationStageResult) {
    const rangeCandidates = input.rangeCandidates ?? [];
    const selection = rangeCandidates.length > 0 && input.temporalDateRange
      ? await this.selectRangeAnswer(input, rangeCandidates, input.temporalDateRange)
      : await this.selectAnswer(input);

    return {
      ...input,
      rerankedContexts: selection.rerankedContexts,
      rerankStatus: selection.rerankStatus,
      temporalDeterministicSortEnabled: input.settings.temporalDeterministicSortEnabled ?? true,
      temporalDeterministicSortApplied: selection.temporalOrdering.applied,
      temporalDeterministicSortToday: selection.temporalOrdering.today,
      temporalDeterministicSortDatedContextCount: selection.temporalOrdering.datedContextCount,
      contexts: selection.contexts,
    };
  }

  // Order, then select: an upcoming listing keeps its soonest events through the cut.
  private async selectAnswer(input: CandidatePreparationStageResult): Promise<SelectedContexts> {
    const contextTopK = RETRIEVAL_BEHAVIOR.finalContextTopK;
    const poolSize = answerCandidatePoolSize(input.settings.rerankTopK, contextTopK);
    const reranked = await this.rank(input, input.scoredCandidates.slice(0, poolSize), { keepPoolOrder: false });
    const temporalOrdering = this.orderForPrompt(input, reranked.contexts);
    return {
      rerankedContexts: reranked.contexts,
      rerankStatus: reranked.status,
      temporalOrdering,
      contexts: this.promptContextSelectorService.select({ contexts: temporalOrdering.orderedContexts, topK: contextTopK }),
    };
  }

  // Select, then order: the range's most relevant passages, and the best candidates outside it,
  // reach the answer under the composer's quotas, and only the selected passages are put in
  // date order for the prompt.
  private async selectRangeAnswer(
    input: CandidatePreparationStageResult,
    rangeCandidates: RetrievedCandidate[],
    range: RequestedDateRange,
  ): Promise<SelectedContexts> {
    const { dateRangeListingContextTopK, dateRangeReservedOutsidePassages } = RETRIEVAL_BEHAVIOR.temporal;
    const plan = composeRangeAnswerPool({
      rangeCandidates,
      generalCandidates: input.scoredCandidates,
      range,
      poolSize: answerCandidatePoolSize(input.settings.rerankTopK, dateRangeListingContextTopK),
      reservedCount: dateRangeReservedOutsidePassages,
    });
    // The pool's own order is the relevance order when reranking is off: the lookup's
    // similarity for the range, the ranked order outside it.
    const reranked = await this.rank(input, plan.pool, { keepPoolOrder: true });
    const selected = this.promptContextSelectorService.selectInStages(rangeAnswerSelectionStages({
      ranked: reranked.contexts,
      rangeChunkIds: plan.rangeChunkIds,
      reservedCount: dateRangeReservedOutsidePassages,
      maxPassages: dateRangeListingContextTopK,
      minPassages: RETRIEVAL_BEHAVIOR.finalContextTopK,
    }));
    const rangeFirst = [
      ...selected.filter((context) => plan.rangeChunkIds.has(context.chunkId)),
      ...selected.filter((context) => !plan.rangeChunkIds.has(context.chunkId)),
    ];
    const temporalOrdering = this.orderForPrompt(input, rangeFirst);
    return {
      rerankedContexts: reranked.contexts,
      rerankStatus: reranked.status,
      temporalOrdering,
      contexts: temporalOrdering.orderedContexts.map((context, promptPosition) => ({ ...context, promptPosition })),
    };
  }

  private async rank(
    input: CandidatePreparationStageResult,
    pool: RetrievedCandidate[],
    options: { keepPoolOrder: boolean },
  ): Promise<{ contexts: RerankedCandidate[]; status: RerankStatus }> {
    const clauses = getContextSelectionClauses(input.shapeSelection?.resolvedRun);
    const rerankEnabled = clauses.ranking.rerankMode === "disabled"
      ? false
      : input.settings.rerankEnabled;
    if (!rerankEnabled && (options.keepPoolOrder || clauses.ranking.lexicalBias === "preferred")) {
      return { contexts: this.keepPreparedOrder(pool, pool.length), status: "skipped" };
    }
    return this.rerankService.rerank({
      query: input.activeParsedQuery.semanticQuery || input.activeQuery,
      contexts: pool,
      enabled: rerankEnabled,
      topK: pool.length,
      workspaceContext: { workspaceId: input.request.workspaceId },
      usageContext: input.request.usageContext,
    });
  }

  private orderForPrompt<T extends RerankedCandidate>(input: CandidatePreparationStageResult, contexts: T[]) {
    return orderTemporalPromptContexts({
      contexts,
      enabled: input.settings.temporalDeterministicSortEnabled ?? true,
      queryShape: input.rewrittenQuery?.structuredResult?.queryShape ?? input.shapeSelection?.queryShape,
      temporalQueryMode: input.temporalQueryMode ?? input.rewrittenQuery?.structuredResult?.temporalQueryMode,
      today: formatIsoDateUtc(this.clock()),
      dateRange: input.temporalDateRange,
    });
  }

  private keepPreparedOrder(contexts: RetrievedCandidate[], topK: number): RerankedCandidate[] {
    return contexts.slice(0, topK).map((context, index) => ({
      ...context,
      relevanceScore: context.similarity,
      rerankPosition: index,
    }));
  }
}
