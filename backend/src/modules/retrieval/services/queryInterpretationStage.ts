import type { ParsedQueryInterpretation } from "../domain/queryConstraintTypes.js";
import { QueryRewriteService } from "./queryRewriteService.js";
import type { QueryInterpretationStage as QueryInterpretationStageContract, RetrievalContextStageResult } from "./retrievalPipelineStages.js";

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
    const rewrittenQuery = await this.queryRewriteService.rewrite({
      query: input.request.query,
      contextWindow: input.contextWindow,
      enabled: input.settings.queryRewriteEnabled,
      semanticRewriteInstructions: input.settings.semanticRewriteInstructions,
      lexicalRewriteInstructions: input.settings.lexicalRewriteInstructions,
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
    const shouldResetPromptHistory =
      rewrittenQuery.retrievalEligible &&
      (rewrittenQuery.structuredResult?.turnKind === "fresh_subject" ||
        rewrittenQuery.structuredResult?.turnKind === "explicit_recenter");
    const promptHistory = shouldResetPromptHistory ? [] : input.contextWindow.selectedMessages;
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

    return {
      ...input,
      originalParsedQuery,
      originalPreparedQuery,
      rewrittenQuery,
      activeQuery,
      activeParsedQuery,
      activeSemanticQuery: activeParsedQuery.semanticQuery || activeQuery,
      activeRetrievalSubqueries,
      promptHistory,
      continuityDecision,
    };
  }
}
