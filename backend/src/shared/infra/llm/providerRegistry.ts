import { ModelChatGateway, ModelGroundedMissResponseComposer } from "../../../modules/chat/llmAdapters.js";
import {
  ModelEmbeddingGateway,
  ModelQueryRewriteGateway,
  ModelRerankGateway,
  ModelTriggerAnalysisGateway,
  OpenAISemanticRerankGateway,
} from "../../../modules/retrieval/public.js";
import { ClaudeTextGenerationClient } from "./claudeProvider.js";
import { GeminiEmbeddingClient, GeminiTextGenerationClient } from "./geminiProvider.js";
import { createOpenAIClient, OpenAIEmbeddingClient, OpenAITextGenerationClient } from "./openaiProvider.js";
import type { AppLogger } from "../../observability/logger.js";
import {
  type EmbeddingClient,
  type LlmCapabilityConfig,
  type LlmCapabilityName,
  type LlmProviderName,
  type LlmProviderMetadata,
  ProviderConfigurationError,
  type ResolvedLlmConfig,
  type TextGenerationClient,
} from "./providerTypes.js";

export { ProviderConfigurationError } from "./providerTypes.js";

const supportsEmbeddings = (config: LlmCapabilityConfig): boolean =>
  config.provider === "openai" || config.provider === "openai-compatible" || config.provider === "gemini";

const providerFamilyForEmbeddingModel = (model: string): "gemini" | "openai-like" | undefined => {
  if (model.startsWith("gemini-")) {
    return "gemini";
  }
  if (model.startsWith("text-embedding-")) {
    return "openai-like";
  }
  return undefined;
};

const configMatchesEmbeddingFamily = (config: LlmCapabilityConfig, family: "gemini" | "openai-like"): boolean => {
  if (family === "gemini") {
    return config.provider === "gemini";
  }

  return config.provider === "openai" || config.provider === "openai-compatible";
};

class RoutedEmbeddingClient implements EmbeddingClient {
  readonly metadata;
  private readonly clients = new Map<LlmProviderName, EmbeddingClient>();

  constructor(
    private readonly primaryConfig: LlmCapabilityConfig,
    private readonly configs: LlmCapabilityConfig[],
    private readonly clientFactory: (config: LlmCapabilityConfig) => EmbeddingClient,
  ) {
    this.metadata = {
      capability: primaryConfig.capability,
      provider: primaryConfig.provider,
      model: primaryConfig.model,
    };
  }

  async embedTexts(texts: string[], options?: { model?: string }): Promise<number[][]> {
    return this.clientForModel(options?.model ?? this.primaryConfig.model).embedTexts(texts, options);
  }

  private clientForModel(model: string): EmbeddingClient {
    const config = this.configForModel(model);
    const existing = this.clients.get(config.provider);
    if (existing) {
      return existing;
    }

    const client = this.clientFactory(config);
    this.clients.set(config.provider, client);
    return client;
  }

  private configForModel(model: string): LlmCapabilityConfig {
    const providerFamily = providerFamilyForEmbeddingModel(model);
    if (!providerFamily || configMatchesEmbeddingFamily(this.primaryConfig, providerFamily)) {
      return this.primaryConfig;
    }

    const config = this.configs.find((candidate) => configMatchesEmbeddingFamily(candidate, providerFamily));
    if (config) {
      return config;
    }

    throw new ProviderConfigurationError(`No configured embedding provider can serve model ${model}`);
  }
}

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

  createChatTextClient(): TextGenerationClient {
    return this.createTextClient(this.config.chat);
  }

  createGroundedMissResponseComposer() {
    return new ModelGroundedMissResponseComposer(this.createTextClient(this.config.chat));
  }

  createRewriteGateway() {
    return new ModelQueryRewriteGateway(this.createTextClient(this.config.rewrite));
  }

  createTriggerAnalysisGateway() {
    return new ModelTriggerAnalysisGateway(this.createTextClient(this.config.rewrite));
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
    return new ModelEmbeddingGateway(
      new RoutedEmbeddingClient(
        this.config.embeddings,
        this.config.embeddingProviderConfigs,
        (config) => this.createEmbeddingClient(config),
      ),
    );
  }

  canServeEmbeddingModel(model: string): boolean {
    const providerFamily = providerFamilyForEmbeddingModel(model);
    if (!providerFamily) {
      return supportsEmbeddings(this.config.embeddings);
    }

    return [this.config.embeddings, ...this.config.embeddingProviderConfigs]
      .some((config) => supportsEmbeddings(config) && configMatchesEmbeddingFamily(config, providerFamily));
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
        return new GeminiEmbeddingClient(config);
      case "claude":
        throw new ProviderConfigurationError(`Provider ${config.provider} does not support embeddings`);
    }
  }
}
