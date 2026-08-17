import { createHash } from "node:crypto";

import { ModelChatGateway, ModelFallbackReplyComposer } from "../../../modules/chat/llmAdapters.js";
import {
  TextRoutedToolCallingGateway,
  type ModelToolCallingGateway,
} from "../../agent-runtime/index.js";
import {
  ModelQueryRewriteGateway,
  ModelRerankGateway,
  ModelTriggerAnalysisGateway,
  OpenAISemanticRerankGateway,
} from "../../../modules/retrieval/public.js";
import {
  ModelEmbeddingGenerationGateway,
} from "../../../modules/embeddingProfiles/public.js";
import type { LlmCapabilityResolver } from "./capabilityResolver.js";
import {
  ContextualChatGateway,
  ContextualFallbackReplyComposer,
  ContextualQueryRewriteGateway,
  ContextualRerankGateway,
  ContextualTriggerAnalysisGateway,
} from "./contextualGateways.js";
import { TextGenerationClientCache } from "./textClientFactory.js";
import { GeminiEmbeddingClient } from "./geminiProvider.js";
import { createOpenAIClient, OpenAIEmbeddingClient } from "./openaiProvider.js";
import type { AppLogger } from "../../observability/logger.js";
import type { UsageEventRecorder } from "../../domain/usageEventRecorder.js";
import { EmbeddingInferencePipelineService } from "./embeddingInferencePipeline.js";
import { ModelInferencePipelineService, type ModelInferencePipeline } from "./modelInferencePipeline.js";
import { streamWithUsage } from "./providerStreaming.js";
import {
  EmbeddingModelProbeService,
} from "../../../modules/embeddingProfiles/services/embeddingVectorValidator.js";
import type {
  EmbeddingProviderImplementation,
  EmbeddingProviderPort,
} from "../../../modules/embeddingProfiles/contracts/embeddingProvider.js";
import {
  EmbeddingClientProviderAdapter,
} from "./embeddingProviderAdapter.js";
import {
  type EmbeddingCapabilityConfig,
  type EmbeddingProviderBindingSelection,
  endpointScopeFingerprint,
  resolveEmbeddingProviderBinding,
} from "./embeddingProviderResolver.js";
import {
  getSupportedEmbeddingModel,
  isSupportedEmbeddingModel,
  resolveEmbeddingModelDescriptor,
} from "./supportedEmbeddingModels.js";
import {
  type EmbeddingClient,
  type EmbeddingClientOptions,
  type EmbeddingResult,
  type LlmCapabilityConfig,
  type LlmCapabilityDefault,
  type LlmCapabilityName,
  type LlmProviderMetadata,
  ProviderConfigurationError,
  type ResolvedLlmConfig,
} from "./providerTypes.js";

export { ProviderConfigurationError } from "./providerTypes.js";

const supportsEmbeddings = (config: LlmCapabilityDefault): boolean =>
  config.provider === "openai" || config.provider === "openai-compatible" || config.provider === "gemini";

class RoutedEmbeddingClient implements EmbeddingClient {
  readonly metadata;
  private readonly providers = new Map<string, EmbeddingProviderPort>();

  constructor(
    private readonly primaryConfig: LlmCapabilityDefault,
    private readonly configs: LlmCapabilityDefault[],
    private readonly clientFactory: (
      config: LlmCapabilityDefault,
      workspaceId?: string,
    ) => Promise<{ config: LlmCapabilityConfig; client: EmbeddingClient }>,
  ) {
    this.metadata = {
      capability: primaryConfig.capability,
      provider: primaryConfig.provider,
      model: primaryConfig.model,
    };
  }

  async embedTexts(texts: string[], options?: EmbeddingClientOptions): Promise<EmbeddingResult> {
    const model = options?.model ?? this.primaryConfig.model;
    const binding = await this.bindingForModel(model, {
      provider: options?.provider,
      endpointScopeFingerprint: options?.endpointScopeFingerprint,
    }, options?.workspaceId);
    const catalogDescriptor = isSupportedEmbeddingModel(model)
      ? getSupportedEmbeddingModel(model)
      : null;
    if (
      catalogDescriptor
      && options?.dimensions !== undefined
      && options.dimensions !== catalogDescriptor.dimensions
      && (
        options.provider === undefined
        || options.endpointScopeFingerprint === undefined
      )
    ) {
      throw new Error(
        `requested dimensions ${options.dimensions} do not match descriptor dimensions ${catalogDescriptor.dimensions}`,
      );
    }
    const descriptor =
      catalogDescriptor && options?.dimensions === undefined
        ? catalogDescriptor
        : resolveEmbeddingModelDescriptor(model, {
            provider: binding.config.provider,
            dimensions: options?.dimensions ?? Number.NaN,
          });
    if (
      options?.dimensions !== undefined &&
      options.dimensions !== descriptor.dimensions
    ) {
      throw new Error(
        `requested dimensions ${options.dimensions} do not match descriptor dimensions ${descriptor.dimensions}`,
      );
    }
    return binding.provider.generate({
      texts,
      model,
      dimensions: descriptor.dimensions,
      purpose: options?.purpose ?? "retrieval_document",
      provider: binding.config.provider,
    });
  }

  private async bindingForModel(
    model: string,
    requestedBinding?: EmbeddingProviderBindingSelection,
    workspaceId?: string,
  ): Promise<{
    config: EmbeddingCapabilityConfig;
    provider: EmbeddingProviderPort;
  }> {
    const metadata = resolveEmbeddingProviderBinding(
      model,
      this.primaryConfig,
      this.configs,
      requestedBinding,
      { acceptExistingSelection: true },
    );
    const resolved = await this.clientFactory(metadata, workspaceId);
    const config = resolved.config as EmbeddingCapabilityConfig;
    const cacheKey = [
      endpointScopeFingerprint(config),
      createHash("sha256").update(resolved.config.apiKey).digest("hex").slice(0, 16),
    ].join(":");
    const existing = this.providers.get(cacheKey);
    if (existing) {
      return { config, provider: existing };
    }

    const validatedProvider = new EmbeddingClientProviderAdapter(
      resolved.client,
      (candidateModel, dimensions) =>
        resolveEmbeddingModelDescriptor(candidateModel, {
          provider: config.provider,
          dimensions,
        }),
    );
    this.providers.set(cacheKey, validatedProvider);
    return { config, provider: validatedProvider };
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
          {
            responses: {
              create: async (input) => {
                const config = await this.resolveCredentialedConfig(this.config.rerank);
                return createOpenAIClient(config).responses.create(input);
              },
            },
          },
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
    return new ModelEmbeddingGenerationGateway(
      new EmbeddingInferencePipelineService(
        new RoutedEmbeddingClient(
          this.config.embeddings,
          this.config.embeddingProviderConfigs,
          async (config, workspaceId) => {
            const credentialed = await this.resolveCredentialedConfig(config, workspaceId, true);
            return {
              config: credentialed,
              client: this.createEmbeddingClient(credentialed),
            };
          },
        ),
        usageEventRecorder,
        (model, provider) => this.identifyEmbeddingModel(model, provider),
      ),
    );
  }

  createEmbeddingModelProbe(
    model: string,
    provider?: EmbeddingProviderImplementation,
    requestedEndpointScopeFingerprint?: string,
  ): { probe(workspaceId?: string): ReturnType<EmbeddingModelProbeService["probe"]> } {
    const descriptor = getSupportedEmbeddingModel(model);
    const config = resolveEmbeddingProviderBinding(
      model,
      this.config.embeddings,
      this.config.embeddingProviderConfigs,
      {
        provider,
        endpointScopeFingerprint: requestedEndpointScopeFingerprint,
      },
    );
    return {
      probe: async (workspaceId?: string) => {
        const credentialed = await this.resolveCredentialedConfig(config, workspaceId, true);
        const validatedProvider = new EmbeddingClientProviderAdapter(
          this.createEmbeddingClient(credentialed),
          getSupportedEmbeddingModel,
        );
        return new EmbeddingModelProbeService(validatedProvider).probe(descriptor);
      },
    };
  }

  identifyEmbeddingModel(
    model: string,
    provider?: EmbeddingProviderImplementation,
  ): LlmProviderMetadata {
    const config = resolveEmbeddingProviderBinding(
      model,
      this.config.embeddings,
      this.config.embeddingProviderConfigs,
      { provider },
      { acceptExistingSelection: true },
    );

    return {
      capability: "embeddings",
      provider: config.provider,
      model,
    };
  }

  resolveEmbeddingModelBinding(
    model: string,
    provider?: EmbeddingProviderImplementation,
  ): {
    provider: EmbeddingProviderImplementation;
    endpointScopeFingerprint: string;
  } {
    const config = resolveEmbeddingProviderBinding(
      model,
      this.config.embeddings,
      this.config.embeddingProviderConfigs,
      { provider },
      { acceptExistingSelection: true },
    );
    return {
      provider: config.provider,
      endpointScopeFingerprint: endpointScopeFingerprint(config),
    };
  }

  canServeEmbeddingModel(model: string): boolean {
    if (!isSupportedEmbeddingModel(model)) {
      return false;
    }
    try {
      resolveEmbeddingProviderBinding(
        model,
        this.config.embeddings,
        this.config.embeddingProviderConfigs,
      );
      return true;
    } catch {
      return false;
    }
  }

  private metadataFor(config: LlmCapabilityDefault): LlmProviderMetadata {
    return {
      capability: config.capability,
      provider: config.provider,
      model: config.model,
    };
  }

  private createInferencePipeline(config: LlmCapabilityDefault, usageEventRecorder?: UsageEventRecorder): ModelInferencePipeline {
    const registry = this;
    const create = async (workspaceId?: string) => {
      const credentialed = await registry.resolveCredentialedConfig(config, workspaceId, true);
      return new ModelInferencePipelineService(
        registry.clientCache.getOrCreate(credentialed),
        usageEventRecorder,
      );
    };
    return {
      metadata: this.metadataFor(config),
      async complete(input) {
        return (await create(input.operation.workspaceId)).complete(input);
      },
      stream(input) {
        return streamWithUsage(async function* () {
          const result = (await create(input.operation.workspaceId)).stream(input);
          for await (const text of result.textStream) {
            yield text;
          }
          return await result.usage;
        });
      },
    };
  }

  private async resolveCredentialedConfig(
    config: LlmCapabilityDefault,
    workspaceId?: string,
    preserveProviderModel = false,
  ): Promise<LlmCapabilityConfig> {
    if (this.resolver && workspaceId && workspaceId !== "unknown") {
      return this.resolver.resolve(config.capability, {
        workspaceId,
        ...(preserveProviderModel
          ? {
              capabilityOverride: {
                provider: config.provider,
                model: config.model,
              },
            }
          : {}),
      });
    }
    const apiKey = this.config.providerApiKeys?.[config.provider];
    if (!apiKey) {
      throw new ProviderConfigurationError(
        `No API key configured for provider "${config.provider}". Add a workspace credential at Settings → Credentials, or set the matching environment variable and restart Radioso.`,
        {
          kind: "missing_api_key",
          provider: config.provider,
          capability: config.capability,
          remediation: "Add a workspace credential at Settings → Credentials, or set the matching environment variable and restart Radioso.",
        },
      );
    }
    return { ...config, apiKey };
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
