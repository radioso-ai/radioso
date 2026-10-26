import { randomUUID } from "node:crypto";

import { ActivitySummaryPresenter } from "./activitySummaryPresenter.js";
import { ActivityTracePresenter } from "./activityTracePresenter.js";
import type { RetrievalPipelinePort } from "./retrievalPipelineService.js";
import type { RetrievalSearchRequest, RetrievalSearchResult } from "../domain/retrievalCapabilityTypes.js";
import { resolveScopedRetrievalRun } from "./scopedRetrievalRun.js";
import type { AgentRetrievalScopePort } from "../domain/agentRetrievalScope.js";
import { datesFromMetadata, positionInDateRange, type RequestedDateRange } from "../domain/temporal/requestedDateRange.js";

export class RetrievalSearchService {
  private readonly activitySummaryPresenter = new ActivitySummaryPresenter();
  private readonly activityTracePresenter = new ActivityTracePresenter();

  constructor(
    private readonly retrievalPipeline: RetrievalPipelinePort,
    private readonly agentRetrievalScope?: AgentRetrievalScopePort,
  ) {}

  async search(input: RetrievalSearchRequest): Promise<RetrievalSearchResult> {
    const executionSurface = input.executionSurface ?? "retrieval";
    const requestId = input.requestId ?? randomUUID();
    const scoped = await resolveScopedRetrievalRun(this.agentRetrievalScope, input);
    const result = await this.retrievalPipeline.run({
      workspaceId: input.workspaceId,
      query: input.query,
      history: [],
      responseIdentity: null,
      metadataFilter: input.metadataFilter,
      ...scoped.inputs,
      usageContext: {
        accountId: input.accountId ?? null,
        workspaceId: input.workspaceId,
        requestId,
        surface: executionSurface === "mcp_capability" ? "mcp_capability" : "retrieval",
        attemptKey: requestId,
      },
    });
    const activitySummary = this.activitySummaryPresenter.present(result.diagnostics, {
      execution: {
        surface: executionSurface,
        path: "retrieval_search",
        retrievalInvoked: true,
      },
    });

    const requestedDateRange: RequestedDateRange | null = result.diagnostics.temporalDateRange ?? null;
    const requestedDateRangeDropReason = requestedDateRange
      ? null
      : result.diagnostics.rewriteProposal?.requestedDateRangeDropReason ?? null;
    // A requested range always runs through the structured lookup (see
    // candidateRetrievalStage.ts's planTemporalLookup); the one way it does not is the
    // workspace-level toggle that turns the whole structured lookup off.
    const requestedRangeLookupRan = requestedDateRange !== null && result.diagnostics.temporalStructuredLookupEnabled !== false;

    return {
      outcome: "results",
      agentScope: scoped.attribution,
      rewrittenQuery: {
        semantic: result.diagnostics.parsedQuery?.semanticQuery ?? result.rewrittenQuery,
        lexical: result.diagnostics.parsedQuery?.lexicalQuery ?? result.rewrittenQuery,
      },
      requestedDateRange,
      requestedDateRangeDropReason,
      requestedRangeLookup: {
        ran: requestedRangeLookupRan,
        candidateCount: requestedRangeLookupRan ? result.diagnostics.temporalCandidateCount ?? 0 : 0,
      },
      results: result.contexts
        .slice(0, input.topK ?? result.contexts.length)
        .map((context) => {
          const dates = datesFromMetadata(context.metadata);
          return {
            documentId: context.documentId,
            chunkId: context.chunkId,
            title: context.title,
            content: context.content,
            metadata: context.metadata,
            score: context.relevanceScore ?? context.similarity,
            dateFrom: dates.dateFrom ?? null,
            dateTo: dates.dateTo ?? null,
            datedInRequestedRange: requestedDateRange
              ? positionInDateRange(dates, requestedDateRange) === "within"
              : null,
            fromRequestedRangeLookup: requestedDateRange !== null && context.retrievalSources.includes("temporal"),
          };
        }),
      activitySummary,
      activityTrace: this.activityTracePresenter.present(result.trace, activitySummary),
    };
  }
}
