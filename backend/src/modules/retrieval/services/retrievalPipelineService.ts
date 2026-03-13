import type { MessageRecord } from "../../../db/repositories/messageRepository.js";
import type { RetrievalSettingsService } from "../../settings/services/retrievalSettingsService.js";
import type { EmbeddingService } from "./embeddingService.js";
import type { PromptBuildResult } from "./promptBuilder.js";
import { PromptBuilder } from "./promptBuilder.js";
import { QueryRewriteService } from "./queryRewriteService.js";
import { RerankService } from "./rerankService.js";
import type { RetrievedChunk, VectorSearchPort } from "../infra/vectorSearch.js";

export interface RetrievalPipelineResult {
  rewrittenQuery: string;
  contexts: RetrievedChunk[];
  prompt: string;
  citations: PromptBuildResult["citations"];
}

export class RetrievalPipelineService {
  constructor(
    private readonly retrievalSettingsService: RetrievalSettingsService,
    private readonly embeddingService: EmbeddingService,
    private readonly vectorSearch: VectorSearchPort,
    private readonly queryRewriteService: QueryRewriteService,
    private readonly rerankService: RerankService,
    private readonly promptBuilder: PromptBuilder,
  ) {}

  async run(input: {
    accountId: string;
    query: string;
    history: MessageRecord[];
  }): Promise<RetrievalPipelineResult> {
    const settings = await this.retrievalSettingsService.getForAccount(input.accountId);
    const rewrittenQuery = await this.queryRewriteService.rewrite({
      query: input.query,
      history: input.history,
      enabled: settings.queryRewriteEnabled,
    });
    const [queryEmbedding] = await this.embeddingService.embedChunks([rewrittenQuery]);
    const initialContexts = await this.vectorSearch.search({
      accountId: input.accountId,
      queryEmbedding: queryEmbedding ?? [],
      topK: settings.vectorTopK,
      similarityThreshold: settings.similarityThreshold,
    });
    const contexts = this.rerankService.rerank({
      query: rewrittenQuery,
      contexts: initialContexts,
      enabled: settings.rerankEnabled,
      topK: settings.rerankTopK,
    });
    const prompt = this.promptBuilder.build({
      query: input.query,
      history: input.history,
      contexts,
    });

    return {
      rewrittenQuery,
      contexts,
      prompt: prompt.prompt,
      citations: prompt.citations,
    };
  }
}
