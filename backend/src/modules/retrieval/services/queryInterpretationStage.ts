import type { ParsedQueryInterpretation } from "../domain/queryConstraintTypes.js";
import type { ModelCallUsageContext } from "../../../shared/domain/modelCallUsageContext.js";
import { RETRIEVAL_BEHAVIOR } from "../../../shared/domain/behaviorConfig.js";
import { QueryRewriteService } from "./queryRewriteService.js";
import type {
  QueryInterpretationStage as QueryInterpretationStageContract,
  QueryInterpretationStageResult,
  RetrievalContextStageResult,
} from "./retrievalPipelineStages.js";

const fallbackUsageContext = (workspaceId: string): Omit<ModelCallUsageContext, "operation"> => ({
  workspaceId,
  surface: "retrieval",
  attemptKey: "query_interpretation",
});

const skippedTriggerAnalysis = (matcherVersion: string) => ({
  status: "skipped_non_retrieval" as const,
  consideredRules: [],
  matchedRuleIds: [],
  unmatchedRuleIds: [],
  matchCount: 0,
  matcherVersion,
});

const DEFER_TRIGGER_ANALYSIS = Symbol("deferTriggerAnalysis");

export const deferTriggerAnalysisForConcurrentPipeline = (
  input: RetrievalContextStageResult,
): RetrievalContextStageResult => {
  Object.defineProperty(input, DEFER_TRIGGER_ANALYSIS, {
    value: true,
    enumerable: false,
  });
  return input;
};

const shouldDeferTriggerAnalysis = (input: RetrievalContextStageResult): boolean =>
  (input as RetrievalContextStageResult & { [DEFER_TRIGGER_ANALYSIS]?: boolean })[DEFER_TRIGGER_ANALYSIS] === true;

export class QueryInterpretationStageService implements QueryInterpretationStageContract {
  constructor(private readonly queryRewriteService: QueryRewriteService) {}

  async execute(input: RetrievalContextStageResult) {
    const originalParsedQuery: ParsedQueryInterpretation = {
      originalQuery: input.request.query,
      semanticQuery: input.request.query,
      lexicalQuery: input.request.query,
      constraints: [],
    };
    const prepareQueries = (
      parsedQuery: ParsedQueryInterpretation,
      semanticQuery: string,
      lexicalQuery: string,
    ): ParsedQueryInterpretation => ({
      ...parsedQuery,
      semanticQuery,
      lexicalQuery,
    });
    const originalPreparedQuery = prepareQueries(
      originalParsedQuery,
      originalParsedQuery.semanticQuery,
      originalParsedQuery.lexicalQuery,
    );
    const workspaceContext = { workspaceId: input.request.workspaceId };
    const usageContext = input.request.usageContext ?? fallbackUsageContext(input.request.workspaceId);
    const rewrittenQuery = input.request.precomputedRewriteProposal
      ? this.queryRewriteService.rewriteFromProposal({
          query: input.request.query,
          contextWindow: input.contextWindow,
          enabled: input.settings.queryRewriteEnabled,
          proposal: input.request.precomputedRewriteProposal,
          unusableFallbackReason: "rewrite_unusable",
        })
      : await this.queryRewriteService.rewrite({
          query: input.request.query,
          contextWindow: input.contextWindow,
          enabled: input.settings.queryRewriteEnabled,
          semanticRewriteInstructions: input.settings.semanticRewriteInstructions,
          lexicalRewriteInstructions: input.settings.lexicalRewriteInstructions,
          workspaceContext,
          usageContext: { ...usageContext, operation: "query_interpretation", attemptKey: "rewrite" },
        });
    const parsedQueryBase = originalParsedQuery;
    const preparedParsedQuery = prepareQueries(
      parsedQueryBase,
      rewrittenQuery.retrievalEligible ? rewrittenQuery.semanticQuery : originalPreparedQuery.semanticQuery,
      rewrittenQuery.retrievalEligible ? rewrittenQuery.lexicalQuery : originalPreparedQuery.lexicalQuery,
    );
    const parsedQuery = {
      ...preparedParsedQuery,
      originalQuery: input.request.query,
    };
    const activeQuery = rewrittenQuery.retrievalEligible ? rewrittenQuery.effectiveQuery : input.request.query;
    const activeParsedQuery = rewrittenQuery.retrievalEligible
      ? parsedQuery
      : { ...originalPreparedQuery, originalQuery: input.request.query };

    const continuityDecision =
      rewrittenQuery.structuredResult?.unresolved
        ? ("unresolved" as const)
        : rewrittenQuery.retrievalEligible
          ? ("updated" as const)
          : rewrittenQuery.rejectionReason
            ? ("rejected" as const)
            : ("unchanged" as const);
    const shouldResetPromptHistory = false;
    const promptHistory = input.contextWindow.selectedMessages.slice(-RETRIEVAL_BEHAVIOR.promptHistoryMaxMessages);
    const activeRetrievalSubqueries =
      rewrittenQuery.retrievalEligible && rewrittenQuery.retrievalSubqueries && rewrittenQuery.retrievalSubqueries.length > 1
        ? rewrittenQuery.retrievalSubqueries.map((subquery) => ({
            ...subquery,
            semanticQuery: subquery.semanticQuery,
            lexicalQuery: subquery.lexicalQuery,
            responseLanguagePolicy: subquery.responseLanguagePolicy ?? rewrittenQuery.responseLanguagePolicy,
          }))
        : [
            {
              id: "primary",
              label: activeQuery,
              semanticQuery: activeParsedQuery.semanticQuery || activeQuery,
              lexicalQuery: activeParsedQuery.lexicalQuery || activeQuery,
              responseLanguagePolicy: rewrittenQuery.responseLanguagePolicy ?? "match_user_question",
            },
          ];
    const result: QueryInterpretationStageResult = {
      ...input,
      interpretationSource: input.request.precomputedRewriteProposal ? "turn_interpretation" : "query_interpretation",
      originalParsedQuery,
      originalPreparedQuery,
      rewrittenQuery,
      activeQuery,
      activeParsedQuery,
      activeSemanticQuery: activeParsedQuery.semanticQuery || activeQuery,
      activeRetrievalSubqueries,
      triggerAnalysis: skippedTriggerAnalysis("pending_retrieval"),
      promptHistory,
      promptHistoryReset: shouldResetPromptHistory,
      continuityDecision,
    };
    if (shouldDeferTriggerAnalysis(input)) {
      return result;
    }
    return {
      ...result,
      triggerAnalysis: await this.analyzeTriggers(result),
    };
  }

  async analyzeTriggers(input: QueryInterpretationStageResult) {
    const usageContext = input.request.usageContext ?? fallbackUsageContext(input.request.workspaceId);
    return this.queryRewriteService.analyzeTriggers({
      query: input.request.query,
      activeQuery: input.activeQuery,
      contextMessages: [],
      metadataRules: input.settings.metadataRules ?? [],
      workspaceContext: { workspaceId: input.request.workspaceId },
      usageContext: { ...usageContext, operation: "trigger_analysis", attemptKey: "trigger_analysis" },
    });
  }
}
