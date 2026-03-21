import type { ParsedQueryInterpretation } from "../domain/structuredAttributes.js";
import { parseQueryConstraints } from "./queryConstraintParser.js";
import { QueryRewriteService } from "./queryRewriteService.js";
import type { AttributeFamilyControl } from "../../settings/domain/retrievalSettings.js";
import type { QueryInterpretationStage as QueryInterpretationStageContract, RetrievalContextStageResult } from "./retrievalPipelineStages.js";
import { mergeParsedQueries, stripEnabledConstraintLiterals } from "./retrievalPipelineStages.js";

export class QueryInterpretationStageService implements QueryInterpretationStageContract {
  constructor(private readonly queryRewriteService: QueryRewriteService) {}

  async execute(input: RetrievalContextStageResult) {
    const originalParsedQuery = parseQueryConstraints(input.request.query);
    const originalPreparedQuery = this.applyAttributeControlsToQuery(
      originalParsedQuery,
      input.settings.attributeControls,
    );
    const rewrittenQuery = await this.queryRewriteService.rewrite({
      query: input.request.query,
      contextWindow: input.contextWindow,
      enabled: input.settings.queryRewriteEnabled,
    });
    const rewrittenParsedQuery = rewrittenQuery.retrievalEligible
      ? parseQueryConstraints(rewrittenQuery.effectiveQuery)
      : originalParsedQuery;
    const parsedQuery = this.applyAttributeControlsToQuery(
      rewrittenQuery.retrievalEligible
        ? mergeParsedQueries(originalParsedQuery, rewrittenParsedQuery)
        : rewrittenParsedQuery,
      input.settings.attributeControls,
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

  private applyAttributeControlsToQuery(
    parsedQuery: ParsedQueryInterpretation,
    attributeControls: AttributeFamilyControl[],
  ): ParsedQueryInterpretation {
    const hardFilterFamilies = new Set(
      attributeControls
        .filter((control) => control.enabled && control.mode === "hard_filter")
        .map((control) => control.family),
    );

    return {
      ...parsedQuery,
      semanticQuery: stripEnabledConstraintLiterals(parsedQuery.semanticQuery, parsedQuery, hardFilterFamilies),
      lexicalQuery: stripEnabledConstraintLiterals(parsedQuery.lexicalQuery, parsedQuery, hardFilterFamilies),
    };
  }
}
