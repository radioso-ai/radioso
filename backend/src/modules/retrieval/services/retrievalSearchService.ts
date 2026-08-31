import { randomUUID } from "node:crypto";

import { ActivitySummaryPresenter } from "./activitySummaryPresenter.js";
import { ActivityTracePresenter } from "./activityTracePresenter.js";
import type { RetrievalPipelinePort } from "./retrievalPipelineService.js";
import type { RetrievalSearchRequest, RetrievalSearchResult } from "../domain/retrievalCapabilityTypes.js";
import { resolveScopedRetrievalRun } from "./scopedRetrievalRun.js";
import type { AgentRetrievalScopePort } from "../domain/agentRetrievalScope.js";

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

    return {
      outcome: "results",
      agentScope: scoped.attribution,
      rewrittenQuery: {
        semantic: result.diagnostics.parsedQuery?.semanticQuery ?? result.rewrittenQuery,
        lexical: result.diagnostics.parsedQuery?.lexicalQuery ?? result.rewrittenQuery,
      },
      results: result.contexts
        .slice(0, input.topK ?? result.contexts.length)
        .map((context) => ({
          documentId: context.documentId,
          chunkId: context.chunkId,
          title: context.title,
          content: context.content,
          metadata: context.metadata,
          score: context.relevanceScore ?? context.similarity,
        })),
      activitySummary,
      activityTrace: this.activityTracePresenter.present(result.trace, activitySummary),
    };
  }
}
