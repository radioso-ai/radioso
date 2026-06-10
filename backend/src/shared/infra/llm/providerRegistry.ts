import { ModelChatGateway, ModelFallbackReplyComposer } from "../../../modules/chat/llmAdapters.js";
import {
  TextRoutedToolCallingGateway,
  type ModelToolCallingGateway,
} from "../../agent-runtime/index.js";
import {
  ModelEmbeddingGateway,
  ModelQueryRewriteGateway,
  ModelRerankGateway,
  ModelTriggerAnalysisGateway,
  OpenAISemanticRerankGateway,
} from "../../../modules/retrieval/public.js";
import type { LlmCapabilityResolver } from "./capabilityResolver.js";
import {
  ContextualChatGateway,
  ContextualFallbackReplyComposer,
  ContextualQueryRewriteGateway,
  ContextualRerankGateway,
  ContextualTriggerAnalysisGateway,
} from "./contextualGateways.js";
import { TextGenerationClientCache } from "./textClientFactory.js";
import { ClaudeTextGenerationClient } from "./claudeProvider.js";
import { GeminiEmbeddingClient, GeminiTextGenerationClient } from "./geminiProvider.js";
import { createOpenAIClient, OpenAIEmbeddingClient, OpenAITextGenerationClient } from "./openaiProvider.js";
import type { AppLogger } from "../../observability/logger.js";
import type { UsageEventRecorder } from "../../domain/usageEventRecorder.js";
import { EmbeddingInferencePipelineService } from "./embeddingInferencePipeline.js";
import { ModelInferencePipelineService, type ModelInferencePipeline } from "./modelInferencePipeline.js";
import {
  type EmbeddingClient,
  type EmbeddingResult,
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

  async embedTexts(texts: string[], options?: { model?: string }): Promise<EmbeddingResult> {
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

export interface LlmProviderRegistryOptions {
  /** When provided, gateways become workspace-aware and resolve per-call configs. */
  resolver?: LlmCapabilityResolver;
}

export class LlmProviderRegistry {
  private resolver: LlmCapabilityResolver | undefined;
  private readonly clientCache = new TextGenerationClientCache();

  constructor(
    private readonly config: ResolvedLlmConfig,
    private readonly logger?: AppLogger,
    options: LlmProviderRegistryOptions = {},
  ) {
    if (!supportsEmbeddings(config.embeddings)) {
      throw new ProviderConfigurationError(`Provider ${config.embeddings.provider} does not support embeddings`);
    }
    this.resolver = options.resolver;
  }

  /**
   * Attach a per-workspace capability resolver. Must be called before any
   * `createXGateway()` method that should return a workspace-aware gateway.
   * The embedding gateway is unaffected — embedding stays env-default.
   */
  setResolver(resolver: LlmCapabilityResolver): void {
    this.resolver = resolver;
  }

  describe(): Record<LlmCapabilityName, LlmProviderMetadata> {
    return {
      chat: this.metadataFor(this.config.chat),
      rewrite: this.metadataFor(this.config.rewrite),
      rerank: this.metadataFor(this.config.rerank),
      embeddings: this.metadataFor(this.config.embeddings),
    };
  }

  createChatGateway(usageEventRecorder?: UsageEventRecorder) {
    const fallback = new ModelChatGateway(this.createInferencePipeline(this.config.chat, usageEventRecorder));
    if (!this.resolver) {
      return fallback;
    }
    return new ContextualChatGateway(
      { resolver: this.resolver, clientCache: this.clientCache },
      fallback,
      usageEventRecorder,
    );
  }

  createChatInferencePipeline(usageEventRecorder?: UsageEventRecorder): ModelInferencePipeline {
    return this.createInferencePipeline(this.config.chat, usageEventRecorder);
  }

  /**
   * Inference pipeline for the cheap classifier tier (the `rewrite` capability),
   * used by the turn router. Keeps lightweight per-turn classification off the
   * heavier `chat` answer model.
   */
  createRewriteInferencePipeline(usageEventRecorder?: UsageEventRecorder): ModelInferencePipeline {
    return this.createInferencePipeline(this.config.rewrite, usageEventRecorder);
  }

  /**
   * Returns a provider-agnostic tool-calling gateway for the agentic retrieval
   * runner. Wraps whichever provider is configured for the `chat` capability
   * — the same provider the assistant already uses for its final answer.
   *
   * Workspace-aware resolution is intentionally not threaded through here in
   * v1: agentic mode is a per-workspace setting, and the workspace's resolved
   * chat client is constructed at composition time. If per-call resolution is
   * needed later, wrap this gateway in a contextual variant the same way
   * `createChatGateway` does.
   */
  createToolCallingGateway(usageEventRecorder?: UsageEventRecorder): ModelToolCallingGateway {
    return new TextRoutedToolCallingGateway(this.createInferencePipeline(this.config.chat, usageEventRecorder));
  }

  createFallbackReplyComposer(usageEventRecorder?: UsageEventRecorder) {
    const fallback = new ModelFallbackReplyComposer(this.createInferencePipeline(this.config.chat, usageEventRecorder));
    if (!this.resolver) {
      return fallback;
    }
    return new ContextualFallbackReplyComposer(
      { resolver: this.resolver, clientCache: this.clientCache },
      fallback,
      usageEventRecorder,
    );
  }

  createRewriteGateway(usageEventRecorder?: UsageEventRecorder) {
    const fallback = new ModelQueryRewriteGateway(this.createInferencePipeline(this.config.rewrite, usageEventRecorder));
    if (!this.resolver) {
      return fallback;
    }
    return new ContextualQueryRewriteGateway(
      { resolver: this.resolver, clientCache: this.clientCache },
      fallback,
      usageEventRecorder,
    );
  }

  createTriggerAnalysisGateway(usageEventRecorder?: UsageEventRecorder) {
    const fallback = new ModelTriggerAnalysisGateway(this.createInferencePipeline(this.config.rewrite, usageEventRecorder));
    if (!this.resolver) {
      return fallback;
    }
    return new ContextualTriggerAnalysisGateway(
      { resolver: this.resolver, clientCache: this.clientCache },
      fallback,
      usageEventRecorder,
    );
  }

  createRerankGateway(usageEventRecorder?: UsageEventRecorder) {
    const defaultFallback = this.config.rerank.provider === "openai"
      ? new OpenAISemanticRerankGateway(
          createOpenAIClient(this.config.rerank),
          this.config.rerank.model,
          this.logger,
          usageEventRecorder,
        )
      : new ModelRerankGateway(this.createInferencePipeline(this.config.rerank, usageEventRecorder), this.logger);

    if (!this.resolver) {
      return defaultFallback;
    }
    return new ContextualRerankGateway(
      { resolver: this.resolver, clientCache: this.clientCache },
      defaultFallback,
      this.logger,
      usageEventRecorder,
    );
  }

  createEmbeddingGateway(usageEventRecorder?: UsageEventRecorder) {
    return new ModelEmbeddingGateway(
      new EmbeddingInferencePipelineService(
        new RoutedEmbeddingClient(
          this.config.embeddings,
          this.config.embeddingProviderConfigs,
          (config) => this.createEmbeddingClient(config),
        ),
        usageEventRecorder,
        (model) => this.identifyEmbeddingModel(model),
      ),
    );
  }

  identifyEmbeddingModel(model: string): LlmProviderMetadata {
    const providerFamily = providerFamilyForEmbeddingModel(model);
    const config = !providerFamily || configMatchesEmbeddingFamily(this.config.embeddings, providerFamily)
      ? this.config.embeddings
      : this.config.embeddingProviderConfigs.find((candidate) =>
          supportsEmbeddings(candidate) && configMatchesEmbeddingFamily(candidate, providerFamily),
        );

    if (!config) {
      throw new ProviderConfigurationError(`No configured embedding provider can serve model ${model}`);
    }

    return {
      capability: "embeddings",
      provider: config.provider,
      model,
    };
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

  private createInferencePipeline(config: LlmCapabilityConfig, usageEventRecorder?: UsageEventRecorder): ModelInferencePipeline {
    return new ModelInferencePipelineService(this.createTextClient(config), usageEventRecorder);
  }

  private createTextClient(config: LlmCapabilityConfig): TextGenerationClient {
    const client = (() => {
      switch (config.provider) {
        case "openai":
        case "openai-compatible":
          return new OpenAITextGenerationClient(config);
        case "gemini":
          return new GeminiTextGenerationClient(config);
        case "claude":
          return new ClaudeTextGenerationClient(config);
      }
    })();
    return client;
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
