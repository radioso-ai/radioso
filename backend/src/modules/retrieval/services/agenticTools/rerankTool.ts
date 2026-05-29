import { z } from "zod";

import type { ModelCallUsageContext } from "../../../../shared/domain/modelCallUsageContext.js";
import type { AgentTool } from "../../../../shared/agent-runtime/index.js";
import type { LlmCapabilityResolveInput } from "../../../../shared/infra/llm/workspaceContext.js";
import type { RetrievalSource, RetrievedCandidate } from "../../domain/retrievalPipelineTypes.js";
import type { RerankGateway } from "../rerankService.js";
import type { ChunkRegistry, RegisteredChunk } from "./chunkRegistry.js";

export interface RerankToolDeps {
  readonly rerankGateway: RerankGateway;
  readonly registry: ChunkRegistry;
  readonly workspaceContext?: LlmCapabilityResolveInput;
  readonly usageContext?: Omit<ModelCallUsageContext, "operation">;
}

const inputSchema = z.object({
  query: z.string().min(1, "query must not be empty"),
  chunkIds: z.array(z.string()).min(1, "must include at least one chunkId").max(50),
});

const outputSchema = z.object({
  ranked: z.array(
    z.object({
      chunkId: z.string(),
      relevanceScore: z.number(),
    }),
  ),
  unknownChunkIds: z.array(z.string()),
});

type RerankInput = z.infer<typeof inputSchema>;
type RerankOutput = z.infer<typeof outputSchema>;

const toRetrievedCandidate = (chunk: RegisteredChunk): RetrievedCandidate => {
  const retrievalSources: RetrievalSource[] = ["semantic_rewritten"];
  return {
    chunkId: chunk.chunkId,
    documentId: chunk.documentId,
    title: chunk.title,
    content: chunk.fullContent,
    searchText: chunk.searchText,
    similarity: chunk.similarity,
    chunkIndex: chunk.chunkIndex,
    metadata: chunk.metadata,
    retrievalSources,
    retrievalText: chunk.fullContent,
    semanticScore: chunk.similarity,
    lexicalScore: 0,
  };
};

export const createRerankTool = (deps: RerankToolDeps): AgentTool<RerankInput, RerankOutput> => ({
  name: "rerank",
  description:
    "Reorder previously retrieved chunks by relevance to a query. Does not fetch new chunk bodies; operates only on chunks already returned by prior search calls.",
  inputSchema,
  outputSchema,
  async invoke(input, ctx) {
    const resolved = deps.registry.resolve(input.chunkIds);
    const resolvedIds = new Set(resolved.map((chunk) => chunk.chunkId));
    const unknownChunkIds = input.chunkIds.filter((id) => !resolvedIds.has(id));

    if (resolved.length === 0) {
      return { ranked: [], unknownChunkIds };
    }

    const candidates = resolved.map(toRetrievedCandidate);
    const scores = await deps.rerankGateway.rerank({
      query: input.query,
      contexts: candidates,
      workspaceContext: deps.workspaceContext,
      usageContext: deps.usageContext
        ? {
            ...deps.usageContext,
            operation: "rerank",
            attemptKey: `rerank_tool:${ctx.stepIndex}:${ctx.callId}`,
          }
        : undefined,
    });

    const scoreByChunkId = new Map(scores.map((score) => [score.chunkId, score.relevanceScore]));
    const ranked = resolved
      .map((chunk) => ({
        chunkId: chunk.chunkId,
        relevanceScore: scoreByChunkId.get(chunk.chunkId) ?? chunk.similarity,
      }))
      .sort((a, b) => b.relevanceScore - a.relevanceScore);

    return { ranked, unknownChunkIds };
  },
});
