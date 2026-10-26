import type { QueryEmbeddingPort } from "../../embeddingProfiles/contracts/embeddingConsumers.js";
import type { ModelCallUsageContext } from "../../../shared/domain/modelCallUsageContext.js";
import { dateRangeLookupDepth } from "../domain/answerCandidatePool.js";
import type { RetrievalDefaultsProvider } from "../domain/retrievalDefaultsProvider.js";
import type { RequestedDateRange } from "../domain/temporal/requestedDateRange.js";
import type { RequestedDateRangeLookupStatus } from "../domain/temporal/requestedDateRangeLookupStatus.js";
import type { TemporalCandidateRetrievalPort, TemporalSimilarityQuery } from "../domain/temporal/temporalCandidateRetrieval.js";
import type { RetrievedChunk } from "../domain/vectorSearch.js";

export interface RequestedDateRangeSearchInput {
  workspaceId: string;
  query: string;
  range: RequestedDateRange;
  metadataFilter?: Record<string, unknown>;
  /** The caller's own usage context (requestId, surface, copilot ids); `operation` is this
   * service's to set, since it names the embedding call this service makes internally. */
  usageContext: Omit<ModelCallUsageContext, "operation">;
}

export interface RequestedDateRangeSearchResult {
  status: Exclude<RequestedDateRangeLookupStatus, "not_requested">;
  chunks: RetrievedChunk[];
}

/**
 * The one place that knows how to turn an explicit requested date range into ranked chunks:
 * embeds the query, guards the embedding's dimensions against the active space before trusting
 * it for similarity ranking, degrades to date order rather than failing when embedding is
 * unusable, and never lets a lookup failure escape as a thrown error — callers read `status`
 * instead. Callers outside `retrieval` reach this through `retrieval/public.ts` rather than
 * reimplementing embedding, dimension guarding, or the depth rule themselves.
 */
export interface RequestedDateRangeSearchPort {
  search(input: RequestedDateRangeSearchInput): Promise<RequestedDateRangeSearchResult>;
}

export class RequestedDateRangeSearchService implements RequestedDateRangeSearchPort {
  constructor(
    private readonly queryEmbeddings: QueryEmbeddingPort,
    private readonly temporalCandidateRetrieval: TemporalCandidateRetrievalPort,
    private readonly retrievalDefaultsProvider: RetrievalDefaultsProvider,
  ) {}

  async search(input: RequestedDateRangeSearchInput): Promise<RequestedDateRangeSearchResult> {
    const similarTo = await this.resolveSimilarTo(input);
    const { rerankTopK } = this.retrievalDefaultsProvider.getDefaults(input.workspaceId);

    try {
      const chunks = await this.temporalCandidateRetrieval.findInWindow({
        workspaceId: input.workspaceId,
        window: {
          kind: "requested_range",
          range: input.range,
          ...(similarTo ? { similarTo } : {}),
        },
        topK: dateRangeLookupDepth(rerankTopK),
        ...(input.metadataFilter ? { metadataFilter: input.metadataFilter } : {}),
      });
      return { status: "ran", chunks };
    } catch {
      return { status: "failed", chunks: [] };
    }
  }

  /**
   * Ranks the lookup by the question's own embedding when one is available and usable.
   * An embedding failure, or a vector whose dimensions do not match the active space, degrades
   * to the port's own date-ordered fallback rather than failing the whole search — the same
   * guard `candidateRetrievalStage.ts` applies before trusting an embedding for `similarTo`.
   */
  private async resolveSimilarTo(input: RequestedDateRangeSearchInput): Promise<TemporalSimilarityQuery | undefined> {
    const embeddingResult = await this.queryEmbeddings.embedQueries({
      workspaceId: input.workspaceId,
      texts: [input.query],
      usageContext: {
        ...input.usageContext,
        operation: "query_embedding",
        attemptKey: "requested_date_range",
      },
    }).catch(() => null);
    const queryVector = embeddingResult?.vectors[0];
    return embeddingResult && queryVector && queryVector.length === embeddingResult.space.dimensions
      ? { space: embeddingResult.space, queryVector }
      : undefined;
  }
}
