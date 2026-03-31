import type { ParsedQueryInterpretation } from "../domain/structuredAttributes.js";
import { parseQueryConstraints } from "./queryConstraintParser.js";
import { QueryRewriteService } from "./queryRewriteService.js";
import type { QueryInterpretationStage as QueryInterpretationStageContract, RetrievalContextStageResult } from "./retrievalPipelineStages.js";
import { mergeParsedQueries, stripEnabledConstraintLiterals } from "./retrievalPipelineStages.js";
import { defaultAttributeControls } from "../../settings/domain/retrievalSettings.js";

export class QueryInterpretationStageService implements QueryInterpretationStageContract {
  constructor(private readonly queryRewriteService: QueryRewriteService) {}

  async execute(input: RetrievalContextStageResult) {
    const originalParsedQuery = parseQueryConstraints(input.request.query);
    const signalPolicies =
      (input.settings as { signalPolicies?: Array<{ signalKey: string; enabled: boolean; mode: "boost_only" | "hard_filter" }> })
        .signalPolicies ?? defaultAttributeControls();
    const hardFilterSignalKeys = new Set(
      signalPolicies.filter((policy) => policy.enabled && policy.mode === "hard_filter").map((policy) => policy.signalKey),
    );
    const prepareQueries = (
      parsedQuery: ParsedQueryInterpretation,
      semanticQuery: string,
      lexicalQuery: string,
    ): ParsedQueryInterpretation => ({
      ...parsedQuery,
      semanticQuery:
        hardFilterSignalKeys.size > 0
          ? stripEnabledConstraintLiterals(semanticQuery, parsedQuery, hardFilterSignalKeys)
          : semanticQuery,
      lexicalQuery:
        hardFilterSignalKeys.size > 0
          ? stripEnabledConstraintLiterals(lexicalQuery, parsedQuery, hardFilterSignalKeys)
          : lexicalQuery,
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
    const rewrittenParsedQuery = rewrittenQuery.retrievalEligible
      ? parseQueryConstraints(rewrittenQuery.effectiveQuery)
      : originalParsedQuery;
    const parsedQueryBase =
      rewrittenQuery.retrievalEligible
        ? mergeParsedQueries(originalParsedQuery, rewrittenParsedQuery)
        : rewrittenParsedQuery;
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

    return {
      ...input,
      originalParsedQuery,
      originalPreparedQuery,
      rewrittenQuery,
      activeQuery,
      activeParsedQuery,
      activeSemanticQuery: activeParsedQuery.semanticQuery || activeQuery,
      promptHistory,
      continuityDecision,
    };
  }
}
