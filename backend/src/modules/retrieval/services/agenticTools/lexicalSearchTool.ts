import { z } from "zod";

import type { AgentTool } from "../../../../shared/agent-runtime/index.js";
import type { RetrievalSourceFilter } from "../../domain/retrievalSourceFilter.js";
import type { LexicalSearchPort } from "../../infra/lexicalSearch.js";
import { fromRetrievedChunk, type ChunkRegistry } from "./chunkRegistry.js";
import { mergeMetadataFilters } from "./semanticSearchTool.js";

const DEFAULT_TOP_K = 5;
const MAX_TOP_K = 20;

export interface LexicalSearchToolDeps {
  readonly workspaceId: string;
  readonly lexicalSearch: LexicalSearchPort;
  readonly registry: ChunkRegistry;
  readonly sourceFilter?: RetrievalSourceFilter;
  readonly snippetChars?: number;
  /** See SemanticSearchToolDeps.callerMetadataFilter — same contract here. */
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

type LexicalSearchInput = z.infer<typeof inputSchema>;
type LexicalSearchOutput = z.infer<typeof outputSchema>;

export const createLexicalSearchTool = (
  deps: LexicalSearchToolDeps,
): AgentTool<LexicalSearchInput, LexicalSearchOutput> => ({
  name: "lexical_search",
  description:
    "Find chunks via BM25-style keyword search. Returns short snippets, not full bodies. Use fetch_chunk to read a chunk in full.",
  inputSchema,
  outputSchema,
  async invoke(input) {
    const topK = input.topK ?? DEFAULT_TOP_K;
    const chunks = await deps.lexicalSearch.search({
      workspaceId: deps.workspaceId,
      query: input.query,
      topK,
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
