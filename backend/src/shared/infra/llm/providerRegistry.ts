import { ModelChatGateway } from "../../../modules/chat/services/chatService.js";
import { ModelEmbeddingGateway } from "../../../modules/retrieval/services/embeddingService.js";
import { ModelQueryRewriteGateway } from "../../../modules/retrieval/services/queryRewriteService.js";
import { ModelRerankGateway } from "../../../modules/retrieval/services/rerankService.js";
import { ClaudeTextGenerationClient } from "./claudeProvider.js";
import { GeminiEmbeddingClient, GeminiTextGenerationClient } from "./geminiProvider.js";
import { OpenAIEmbeddingClient, OpenAITextGenerationClient } from "./openaiProvider.js";
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

const supportsEmbeddings = (config: LlmCapabilityConfig): boolean => config.provider !== "claude";

export class LlmProviderRegistry {
  constructor(private readonly config: ResolvedLlmConfig) {
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

  createRewriteGateway() {
    return new ModelQueryRewriteGateway(this.createTextClient(this.config.rewrite));
  }

  createRerankGateway() {
    return new ModelRerankGateway(this.createTextClient(this.config.rerank));
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
        return new OpenAIEmbeddingClient(config);
      case "gemini":
        return new GeminiEmbeddingClient(config);
      case "claude":
        throw new ProviderConfigurationError(`Provider ${config.provider} does not support embeddings`);
    }
  }
}
