import type { LlmCapabilityResolver, LlmCapabilityResolveInput } from "./capabilityResolver.js";
import { ModelDirectiveMatchGateway, type DirectiveMatchGateway } from "@radioso/conversation-defaults";
import type { LlmCapabilityConfig, TextGenerationClient } from "./providerTypes.js";
import { ModelInferencePipelineService, type ModelInferencePipeline } from "./modelInferencePipeline.js";
import { TextGenerationClientCache, createTextGenerationClient } from "./textClientFactory.js";
import {
  ModelChatGateway,
  ModelFallbackReplyComposer,
  type ChatGateway,
  type ChatGatewayInput,
  type FallbackReplyComposer,
  type FallbackReplyInput,
} from "../../../modules/chat/llmAdapters.js";
import {
  ModelQueryRewriteGateway,
  ModelRerankGateway,
  ModelTriggerAnalysisGateway,
  OpenAISemanticRerankGateway,
  type QueryRewriteGateway,
  type QueryRewriteGatewayInput,
  type QueryRewriteGatewayResult,
  type RerankGateway,
  type RerankGatewayInput,
  type TriggerAnalysisGateway,
  type TriggerAnalysisGatewayInput,
  type TriggerAnalysisResult,
} from "../../../modules/retrieval/public.js";
import { createOpenAIClient } from "./openaiProvider.js";
import type { AppLogger } from "../../observability/logger.js";
import type { UsageEventRecorder } from "../../domain/usageEventRecorder.js";
import type { ModelCallUsageContext } from "../../domain/modelCallUsageContext.js";
import { loadPromptTemplate } from "../prompts/promptLoader.js";

interface ContextualGatewayDependencies {
  resolver: LlmCapabilityResolver;
  clientCache?: TextGenerationClientCache;
}

const requireWorkspaceContext = (input: { workspaceContext?: LlmCapabilityResolveInput }): LlmCapabilityResolveInput | undefined =>
  input.workspaceContext;

const resolveClient = async (
  cache: TextGenerationClientCache,
  resolver: LlmCapabilityResolver,
  capability: "chat" | "rewrite" | "rerank",
  context: LlmCapabilityResolveInput,
): Promise<TextGenerationClient> => {
  const config = await resolver.resolve(capability, context);
  return cache.getOrCreate(config);
};

const toInferencePipeline = (
  client: TextGenerationClient,
  recorder?: UsageEventRecorder,
): ModelInferencePipeline =>
  new ModelInferencePipelineService(client, recorder);

export interface DirectiveMatchGatewayFactory {
  create(input: {
    workspaceContext: LlmCapabilityResolveInput;
    usageContext: ModelCallUsageContext;
  }): Promise<DirectiveMatchGateway>;
}

export class ContextualDirectiveMatchGatewayFactory implements DirectiveMatchGatewayFactory {
  private readonly cache: TextGenerationClientCache;

  constructor(
    private readonly deps: ContextualGatewayDependencies,
    private readonly usageEventRecorder?: UsageEventRecorder,
  ) {
    this.cache = deps.clientCache ?? new TextGenerationClientCache();
  }

  async create(input: {
    workspaceContext: LlmCapabilityResolveInput;
    usageContext: ModelCallUsageContext;
  }): Promise<DirectiveMatchGateway> {
    const client = await resolveClient(this.cache, this.deps.resolver, "chat", input.workspaceContext);
    const inference = toInferencePipeline(client, this.usageEventRecorder);
    return new ModelDirectiveMatchGateway({
      complete(request) {
        return inference.complete({
          ...request,
          operation: input.usageContext,
        });
      },
    }, {
      systemPrompt: loadPromptTemplate("chat/directive-match.md"),
    });
  }
}

export class ContextualChatGateway implements ChatGateway {
  private readonly cache: TextGenerationClientCache;

  constructor(
    private readonly deps: ContextualGatewayDependencies,
    private readonly fallback: ChatGateway,
    private readonly usageEventRecorder?: UsageEventRecorder,
  ) {
    this.cache = deps.clientCache ?? new TextGenerationClientCache();
  }

  async answer(input: ChatGatewayInput): Promise<string> {
    const ctx = requireWorkspaceContext(input);
    if (!ctx) {
      return this.fallback.answer(input);
    }
    const client = await resolveClient(this.cache, this.deps.resolver, "chat", ctx);
    return new ModelChatGateway(toInferencePipeline(client, this.usageEventRecorder)).answer(input);
  }

  async *streamAnswer(input: ChatGatewayInput): AsyncIterable<string> {
    const ctx = requireWorkspaceContext(input);
    if (!ctx) {
      yield* this.fallback.streamAnswer(input);
      return;
    }
    const client = await resolveClient(this.cache, this.deps.resolver, "chat", ctx);
    yield* new ModelChatGateway(toInferencePipeline(client, this.usageEventRecorder)).streamAnswer(input);
  }
}

export class ContextualFallbackReplyComposer implements FallbackReplyComposer {
  private readonly cache: TextGenerationClientCache;

  constructor(
    private readonly deps: ContextualGatewayDependencies,
    private readonly fallback: FallbackReplyComposer,
    private readonly usageEventRecorder?: UsageEventRecorder,
  ) {
    this.cache = deps.clientCache ?? new TextGenerationClientCache();
  }

  async composeNoContext(input: FallbackReplyInput): Promise<string> {
    const ctx = requireWorkspaceContext(input);
    if (!ctx) {
      return this.fallback.composeNoContext(input);
    }
    const client = await resolveClient(this.cache, this.deps.resolver, "chat", ctx);
    return new ModelFallbackReplyComposer(toInferencePipeline(client, this.usageEventRecorder)).composeNoContext(input);
  }
}

export class ContextualQueryRewriteGateway implements QueryRewriteGateway {
  private readonly cache: TextGenerationClientCache;

  constructor(
    private readonly deps: ContextualGatewayDependencies,
    private readonly fallback: QueryRewriteGateway,
    private readonly usageEventRecorder?: UsageEventRecorder,
  ) {
    this.cache = deps.clientCache ?? new TextGenerationClientCache();
  }

  async rewrite(input: QueryRewriteGatewayInput): Promise<QueryRewriteGatewayResult> {
    const ctx = requireWorkspaceContext(input);
    if (!ctx) {
      return this.fallback.rewrite(input);
    }
    const client = await resolveClient(this.cache, this.deps.resolver, "rewrite", ctx);
    return new ModelQueryRewriteGateway(toInferencePipeline(client, this.usageEventRecorder)).rewrite(input);
  }
}

export class ContextualTriggerAnalysisGateway implements TriggerAnalysisGateway {
  private readonly cache: TextGenerationClientCache;

  constructor(
    private readonly deps: ContextualGatewayDependencies,
    private readonly fallback: TriggerAnalysisGateway,
    private readonly usageEventRecorder?: UsageEventRecorder,
  ) {
    this.cache = deps.clientCache ?? new TextGenerationClientCache();
  }

  async analyze(input: TriggerAnalysisGatewayInput): Promise<TriggerAnalysisResult> {
    const ctx = requireWorkspaceContext(input);
    if (!ctx) {
      return this.fallback.analyze(input);
    }
    const client = await resolveClient(this.cache, this.deps.resolver, "rewrite", ctx);
    return new ModelTriggerAnalysisGateway(toInferencePipeline(client, this.usageEventRecorder)).analyze(input);
  }
}

export class ContextualRerankGateway implements RerankGateway {
  private readonly cache: TextGenerationClientCache;

  constructor(
    private readonly deps: ContextualGatewayDependencies,
    private readonly fallback: RerankGateway,
    private readonly logger?: AppLogger,
    private readonly usageEventRecorder?: UsageEventRecorder,
  ) {
    this.cache = deps.clientCache ?? new TextGenerationClientCache();
  }

  async rerank(input: RerankGatewayInput): Promise<Array<{ chunkId: string; relevanceScore: number }>> {
    const ctx = requireWorkspaceContext(input);
    if (!ctx) {
      return this.fallback.rerank(input);
    }
    const config = await this.deps.resolver.resolve("rerank", ctx);
    return this.dispatchForConfig(config, input);
  }

  private dispatchForConfig(
    config: LlmCapabilityConfig,
    input: RerankGatewayInput,
  ): Promise<Array<{ chunkId: string; relevanceScore: number }>> {
    if (config.provider === "openai") {
      return new OpenAISemanticRerankGateway(
        createOpenAIClient(config),
        config.model,
        this.logger,
        this.usageEventRecorder,
      ).rerank(input);
    }
    const client = this.cache.getOrCreate(config);
    return new ModelRerankGateway(toInferencePipeline(client, this.usageEventRecorder), this.logger).rerank(input);
  }
}

// Re-export the standalone helper so external composition code can use the cache.
export { createTextGenerationClient };
