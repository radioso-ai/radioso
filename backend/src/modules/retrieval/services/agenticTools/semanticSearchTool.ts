import { z } from "zod";

import type { AgentTool } from "../../../../shared/agent-runtime/index.js";
import type { RetrievalSourceFilter } from "../../domain/retrievalSourceFilter.js";
import type { VectorSearchPort } from "../../domain/vectorSearch.js";
import type { EmbeddingGateway } from "../embeddingService.js";
import { fromRetrievedChunk, type ChunkRegistry } from "./chunkRegistry.js";

const DEFAULT_TOP_K = 5;
const MAX_TOP_K = 20;
const DEFAULT_SIMILARITY_THRESHOLD = 0.2;

export interface SemanticSearchToolDeps {
  readonly workspaceId: string;
  readonly embeddings: EmbeddingGateway;
  readonly vectorSearch: VectorSearchPort;
  readonly registry: ChunkRegistry;
  readonly sourceFilter?: RetrievalSourceFilter;
  readonly embeddingModel?: string;
  readonly similarityThreshold?: number;
  readonly snippetChars?: number;
  /**
   * The caller-supplied metadata filter from the retrieval request. Always
   * applied — the model cannot widen this constraint. If the model also
   * supplies a metadataFilter argument, the two are merged with the caller's
   * keys taking precedence on conflict (the model may add narrower filters but
   * cannot relax or override the caller's scope).
   */
  readonly callerMetadataFilter?: Record<string, unknown>;
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
): Record<string, unknown> | undefined => {
  if (!modelFilter && !callerFilter) {
    return undefined;
  }
  // Caller keys spread last so they win on conflict.
  return { ...(modelFilter ?? {}), ...(callerFilter ?? {}) };
};

export const createSemanticSearchTool = (
  deps: SemanticSearchToolDeps,
): AgentTool<SemanticSearchInput, SemanticSearchOutput> => ({
  name: "semantic_search",
  description:
    "Find chunks semantically similar to a query. Returns short snippets, not full bodies. Use fetch_chunk to read a chunk in full.",
  inputSchema,
  outputSchema,
  async invoke(input) {
    const topK = input.topK ?? DEFAULT_TOP_K;
    const [queryEmbedding] = await deps.embeddings.embedTexts([input.query], { model: deps.embeddingModel });
    if (!queryEmbedding) {
      return { results: [] };
    }
    const chunks = await deps.vectorSearch.search({
      workspaceId: deps.workspaceId,
      queryEmbedding,
      topK,
      similarityThreshold: deps.similarityThreshold ?? DEFAULT_SIMILARITY_THRESHOLD,
      embeddingModel: deps.embeddingModel,
      metadataFilter: mergeMetadataFilters(input.metadataFilter, deps.callerMetadataFilter),
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
