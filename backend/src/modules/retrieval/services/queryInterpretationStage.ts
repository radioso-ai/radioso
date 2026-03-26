import type { ParsedQueryInterpretation } from "../domain/structuredAttributes.js";
import { parseQueryConstraints } from "./queryConstraintParser.js";
import { QueryRewriteService } from "./queryRewriteService.js";
import type { RetrievalSignalPolicy } from "../../settings/domain/retrievalSettings.js";
import type { QueryInterpretationStage as QueryInterpretationStageContract, RetrievalContextStageResult } from "./retrievalPipelineStages.js";
import { mergeParsedQueries, stripEnabledConstraintLiterals } from "./retrievalPipelineStages.js";

export class QueryInterpretationStageService implements QueryInterpretationStageContract {
  constructor(private readonly queryRewriteService: QueryRewriteService) {}

  async execute(input: RetrievalContextStageResult) {
    const originalParsedQuery = parseQueryConstraints(input.request.query, input.settings.signalPolicies);
    const originalPreparedQuery = this.applySignalPoliciesToQuery(
      originalParsedQuery,
      input.settings.signalPolicies,
    );
    const rewrittenQuery = await this.queryRewriteService.rewrite({
      query: input.request.query,
      contextWindow: input.contextWindow,
      enabled: input.settings.queryRewriteEnabled,
    });
    const rewrittenParsedQuery = rewrittenQuery.retrievalEligible
      ? parseQueryConstraints(rewrittenQuery.effectiveQuery, input.settings.signalPolicies)
      : originalParsedQuery;
    const parsedQuery = this.applySignalPoliciesToQuery(
      rewrittenQuery.retrievalEligible
        ? mergeParsedQueries(originalParsedQuery, rewrittenParsedQuery)
        : rewrittenParsedQuery,
      input.settings.signalPolicies,
    );
    const activeQuery = rewrittenQuery.retrievalEligible ? rewrittenQuery.effectiveQuery : input.request.query;
    const activeParsedQuery = rewrittenQuery.retrievalEligible ? parsedQuery : originalPreparedQuery;

    const continuityDecision =
      rewrittenQuery.structuredResult?.unresolved
        ? ("unresolved" as const)
        : rewrittenQuery.retrievalEligible
          ? ("updated" as const)
          : rewrittenQuery.rejectionReason
            ? ("rejected" as const)
            : ("unchanged" as const);

    return {
      ...input,
      originalParsedQuery,
      originalPreparedQuery,
      rewrittenQuery,
      activeQuery,
      activeParsedQuery,
      activeSemanticQuery: activeParsedQuery.semanticQuery || activeQuery,
      continuityDecision,
    };
  }

  private applySignalPoliciesToQuery(
    parsedQuery: ParsedQueryInterpretation,
    signalPolicies: RetrievalSignalPolicy[],
  ): ParsedQueryInterpretation {
    const hardFilterSignals = new Set(
      signalPolicies
        .filter((policy) => policy.enabled && policy.mode === "hard_filter")
        .map((policy) => policy.signalKey),
    );

    return {
      ...parsedQuery,
      semanticQuery: stripEnabledConstraintLiterals(parsedQuery.semanticQuery, parsedQuery, hardFilterSignals),
      lexicalQuery: stripEnabledConstraintLiterals(parsedQuery.lexicalQuery, parsedQuery, hardFilterSignals),
    };
  }
}
