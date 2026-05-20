import { RESPONSE_INTENT } from "../domain/retrievalPipelineTypes.js";
import type { ParsedQueryInterpretation } from "../domain/queryConstraintTypes.js";
import { RETRIEVAL_BEHAVIOR } from "../../../shared/domain/behaviorConfig.js";
import { QueryRewriteService } from "./queryRewriteService.js";
import { SharedAnswerInstructionBuilder } from "./sharedAnswerInstructionBuilder.js";
import type { QueryInterpretationStage as QueryInterpretationStageContract, RetrievalContextStageResult } from "./retrievalPipelineStages.js";

export class QueryInterpretationStageService implements QueryInterpretationStageContract {
  private readonly answerInstructionBuilder = new SharedAnswerInstructionBuilder();

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
    const rewrittenQuery = await this.queryRewriteService.rewrite({
      query: input.request.query,
      contextWindow: input.contextWindow,
      enabled: input.settings.queryRewriteEnabled,
      semanticRewriteInstructions: input.settings.semanticRewriteInstructions,
      lexicalRewriteInstructions: input.settings.lexicalRewriteInstructions,
      answerScopeReference: this.buildAnswerScopeReference(input),
    });
    const responseIntent = rewrittenQuery.responseIntent;
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
    const triggerAnalysis = responseIntent === RESPONSE_INTENT.RETRIEVAL
      ? await this.queryRewriteService.analyzeTriggers({
          query: input.request.query,
          activeQuery,
          contextMessages: [],
          metadataRules: input.settings.metadataRules ?? [],
        })
      : {
          status: "skipped_non_retrieval" as const,
          consideredRules: [],
          matchedRuleIds: [],
          unmatchedRuleIds: [],
          matchCount: 0,
          matcherVersion: "non_retrieval",
        };

    return {
      ...input,
      originalParsedQuery,
      originalPreparedQuery,
      rewrittenQuery,
      responseIntent,
      activeQuery,
      activeParsedQuery,
      activeSemanticQuery: activeParsedQuery.semanticQuery || activeQuery,
      activeRetrievalSubqueries,
      triggerAnalysis,
      promptHistory,
      promptHistoryReset: shouldResetPromptHistory,
      continuityDecision,
    };
  }

  private buildAnswerScopeReference(input: RetrievalContextStageResult): string | undefined {
    const includeResponseBehavior = input.request.responseBehaviorEnabled ?? input.request.responseIdentity !== null;
    if (!includeResponseBehavior) {
      return undefined;
    }

    const customInstruction = input.request.responseBehavior?.customInstruction ?? input.settings.customInstruction;
    const block = this.answerInstructionBuilder.buildScopeReferenceBlock({
      responseIdentity: input.request.responseIdentity,
      customInstruction,
    });

    return block.trim() ? block : undefined;
  }
}
