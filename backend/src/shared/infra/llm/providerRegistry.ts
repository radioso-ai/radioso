import { ModelChatGateway } from "../../../modules/chat/services/chatService.js";
import { ModelGroundedMissResponseComposer } from "../../../modules/chat/services/groundedMissResponseComposer.js";
import { ModelEmbeddingGateway } from "../../../modules/retrieval/services/embeddingService.js";
import { ModelQueryRewriteGateway } from "../../../modules/retrieval/services/queryRewriteService.js";
import { ModelRerankGateway, OpenAISemanticRerankGateway } from "../../../modules/retrieval/services/rerankService.js";
import { ClaudeTextGenerationClient } from "./claudeProvider.js";
import { GeminiTextGenerationClient } from "./geminiProvider.js";
import { createOpenAIClient, OpenAIEmbeddingClient, OpenAITextGenerationClient } from "./openaiProvider.js";
import type { AppLogger } from "../../observability/logger.js";
import {
  type EmbeddingClient,
  type LlmCapabilityConfig,
  type LlmCapabilityName,
  type LlmProviderMetadata,
  ProviderConfigurationError,
  type ResolvedLlmConfig,
  type TextGenerationClient,
} from "./providerTypes.js";

export { ProviderConfigurationError } from "./providerTypes.js";

const supportsEmbeddings = (config: LlmCapabilityConfig): boolean =>
  config.provider === "openai" || config.provider === "openai-compatible";

export class LlmProviderRegistry {
  constructor(
    private readonly config: ResolvedLlmConfig,
    private readonly logger?: AppLogger,
  ) {
    if (!supportsEmbeddings(config.embeddings)) {
      throw new ProviderConfigurationError(`Provider ${config.embeddings.provider} does not support embeddings`);
    }
  }

  describe(): Record<LlmCapabilityName, LlmProviderMetadata> {
    return {
      chat: this.metadataFor(this.config.chat),
      rewrite: this.metadataFor(this.config.rewrite),
      rerank: this.metadataFor(this.config.rerank),
      embeddings: this.metadataFor(this.config.embeddings),
    };
  }

  createChatGateway() {
    return new ModelChatGateway(this.createTextClient(this.config.chat));
  }

  createGroundedMissResponseComposer() {
    return new ModelGroundedMissResponseComposer(this.createTextClient(this.config.chat));
  }

  createRewriteGateway() {
    return new ModelQueryRewriteGateway(this.createTextClient(this.config.rewrite));
  }

  createRerankGateway() {
    if (this.config.rerank.provider === "openai") {
      return new OpenAISemanticRerankGateway(
        createOpenAIClient(this.config.rerank),
        this.config.rerank.model,
        this.logger,
      );
    }

    return new ModelRerankGateway(this.createTextClient(this.config.rerank), this.logger);
  }

  createEmbeddingGateway() {
    return new ModelEmbeddingGateway(this.createEmbeddingClient(this.config.embeddings));
  }

  private metadataFor(config: LlmCapabilityConfig): LlmProviderMetadata {
    return {
      capability: config.capability,
      provider: config.provider,
      model: config.model,
    };
  }

  private createTextClient(config: LlmCapabilityConfig): TextGenerationClient {
    switch (config.provider) {
      case "openai":
      case "openai-compatible":
        return new OpenAITextGenerationClient(config);
      case "gemini":
        return new GeminiTextGenerationClient(config);
      case "claude":
        return new ClaudeTextGenerationClient(config);
    }
  }

  private createEmbeddingClient(config: LlmCapabilityConfig): EmbeddingClient {
    switch (config.provider) {
      case "openai":
      case "openai-compatible":
        return new OpenAIEmbeddingClient(config, this.logger);
      case "gemini":
      case "claude":
        throw new ProviderConfigurationError(`Provider ${config.provider} does not support embeddings`);
    }
  }
}
