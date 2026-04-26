import { RetrievalInfoPresenter } from "./retrievalInfoPresenter.js";
import { RetrievalTracePresenter } from "./retrievalTracePresenter.js";
import type { RetrievalPipelineService } from "./retrievalPipelineService.js";
import type { RetrievalSearchRequest, RetrievalSearchResult } from "../domain/retrievalCapabilityTypes.js";

export class RetrievalSearchService {
  private readonly retrievalInfoPresenter = new RetrievalInfoPresenter();
  private readonly retrievalTracePresenter = new RetrievalTracePresenter();

  constructor(private readonly retrievalPipeline: RetrievalPipelineService) {}

  async search(input: RetrievalSearchRequest): Promise<RetrievalSearchResult> {
    const result = await this.retrievalPipeline.run({
      workspaceId: input.workspaceId,
      query: input.query,
      history: [],
      responseIdentity: null,
      metadataFilter: input.metadataFilter,
    });
    const retrievalInfo = this.retrievalInfoPresenter.present(result.diagnostics, {
      execution: {
        surface: input.executionSurface ?? "retrieval",
        path: "retrieval_search",
        retrievalInvoked: true,
      },
    });

    return {
      outcome: "results",
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
      retrievalInfo,
      retrievalTrace: this.retrievalTracePresenter.present(result.trace, retrievalInfo),
    };
  }
}
