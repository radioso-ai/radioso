import { z } from "zod";

import type { AgentTool } from "../../../../shared/agent-runtime/index.js";
import type { ChunkRegistry } from "./chunkRegistry.js";

export interface FetchChunkToolDeps {
  readonly registry: ChunkRegistry;
}

const inputSchema = z.object({
  chunkId: z.string().min(1, "chunkId must not be empty"),
});

const outputSchema = z.union([
  z.object({
    chunkId: z.string(),
    documentId: z.string(),
    title: z.string(),
    content: z.string(),
  }),
  z.object({
    chunkId: z.string(),
    error: z.literal("unknown_chunk"),
  }),
]);

type FetchChunkInput = z.infer<typeof inputSchema>;
type FetchChunkOutput = z.infer<typeof outputSchema>;

export const createFetchChunkTool = (deps: FetchChunkToolDeps): AgentTool<FetchChunkInput, FetchChunkOutput> => ({
  name: "fetch_chunk",
  description:
    "Read the full body of a chunk previously surfaced by semantic_search or lexical_search. Only chunks the agent has already seen via search are available; unknown chunkIds return an error.",
  inputSchema,
  outputSchema,
  async invoke(input) {
    const [chunk] = deps.registry.resolve([input.chunkId]);
    if (!chunk) {
      return { chunkId: input.chunkId, error: "unknown_chunk" as const };
    }
    return {
      chunkId: chunk.chunkId,
      documentId: chunk.documentId,
      title: chunk.title,
      content: chunk.fullContent,
    };
  },
});
