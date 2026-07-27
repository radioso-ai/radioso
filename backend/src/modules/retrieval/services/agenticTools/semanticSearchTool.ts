import { z } from "zod";

import type {
  QueryEmbeddingPort,
} from "../../../embeddingProfiles/contracts/embeddingConsumers.js";
import { type Clock, systemClock } from "../../../../shared/domain/clock.js";
import type { ModelCallUsageContext } from "../../../../shared/domain/modelCallUsageContext.js";
import type { AgentTool } from "../../../../shared/agent-runtime/index.js";
import type { VectorCandidateSearchPort } from "../../domain/vectorAdapter.js";
import type { RetrievalSourceFilter } from "../../domain/retrievalSourceFilter.js";
import { mergeVectorMetadataFilters, type VectorMetadataFilter } from "../../domain/vectorFilter.js";
import type { ChunkCandidateHydratorPort } from "../../infra/chunkCandidateHydrator.js";
import { fromRetrievedChunk, type ChunkRegistry } from "./chunkRegistry.js";

const DEFAULT_TOP_K = 5;
const MAX_TOP_K = 20;
const DEFAULT_SIMILARITY_THRESHOLD = 0.2;

export interface SemanticSearchToolDeps {
  readonly workspaceId: string;
  readonly queryEmbeddings: QueryEmbeddingPort;
  readonly vectorSearch: VectorCandidateSearchPort;
  readonly chunkHydrator: ChunkCandidateHydratorPort;
  readonly registry: ChunkRegistry;
  readonly sourceFilter?: RetrievalSourceFilter;
  readonly similarityThreshold?: number;
  readonly snippetChars?: number;
  readonly clock?: Clock;
  readonly usageContext?: Omit<ModelCallUsageContext, "operation">;
  /**
   * The caller-supplied metadata filter from the retrieval request. Always
   * applied — the model cannot widen this constraint. If the model also
   * supplies a metadataFilter argument, the two are merged with the caller's
   * keys taking precedence on conflict (the model may add narrower filters but
   * cannot relax or override the caller's scope).
   */
  readonly callerMetadataFilter?: VectorMetadataFilter;
}

const inputSchema = z.object({
  query: z.string().min(1, "query must not be empty"),
  topK: z.number().int().min(1).max(MAX_TOP_K).optional(),
  metadataFilter: z.record(z.unknown()).optional(),
});

const outputSchema = z.object({
  results: z.array(
    z.object({
      chunkId: z.string(),
      documentId: z.string(),
      title: z.string(),
      snippet: z.string(),
      score: z.number(),
    }),
  ),
});

type SemanticSearchInput = z.infer<typeof inputSchema>;
type SemanticSearchOutput = z.infer<typeof outputSchema>;

/**
 * Merge model-supplied and caller-supplied metadata filters. The caller's
 * filter (from the retrieval request) is a scoping/security boundary that
 * MUST always apply; the model can only narrow further. Returns undefined
 * when both are empty so the search layer receives no filter at all.
 */
export const mergeMetadataFilters = (
  modelFilter: Record<string, unknown> | undefined,
  callerFilter: Record<string, unknown> | undefined,
): VectorMetadataFilter | undefined => {
  return mergeVectorMetadataFilters(modelFilter, callerFilter);
};

export const createSemanticSearchTool = (
  deps: SemanticSearchToolDeps,
): AgentTool<SemanticSearchInput, SemanticSearchOutput> => ({
  name: "semantic_search",
  description:
    "Find chunks semantically similar to a query. Returns short snippets, not full bodies. Use fetch_chunk to read a chunk in full.",
  inputSchema,
  outputSchema,
  async invoke(input, ctx) {
    const topK = input.topK ?? DEFAULT_TOP_K;
    const embeddingResult = await deps.queryEmbeddings.embedQueries({
      workspaceId: deps.workspaceId,
      texts: [input.query],
      usageContext: deps.usageContext
        ? {
            ...deps.usageContext,
            operation: "query_embedding",
            attemptKey: `semantic_search:${ctx.stepIndex}:${ctx.callId}`,
          }
        : undefined,
    });
    const queryEmbedding = embeddingResult.vectors[0];
    if (!queryEmbedding) {
      return { results: [] };
    }
    const metadataFilter = mergeMetadataFilters(input.metadataFilter, deps.callerMetadataFilter);
    const candidates = await deps.vectorSearch.search({
      workspaceId: deps.workspaceId,
      space: embeddingResult.space,
      queryVector: queryEmbedding,
      topK,
      minimumScore: deps.similarityThreshold ?? DEFAULT_SIMILARITY_THRESHOLD,
      filter: {
        metadataContains: metadataFilter,
        source: deps.sourceFilter,
        retrievalEnabled: true,
        notExpiredAt: (deps.clock ?? systemClock)().toISOString(),
      },
    });
    const chunks = await deps.chunkHydrator.hydrate({
      workspaceId: deps.workspaceId,
      candidates,
      metadataFilter,
      sourceFilter: deps.sourceFilter,
    });
    const registered = chunks.map((chunk) => fromRetrievedChunk(chunk, deps.snippetChars));
    deps.registry.record(registered);
    return {
      results: registered.map((chunk) => ({
        chunkId: chunk.chunkId,
        documentId: chunk.documentId,
        title: chunk.title,
        snippet: chunk.snippet,
        score: chunk.similarity,
      })),
    };
  },
});
