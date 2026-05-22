import type { LlmCapabilityResolver, LlmCapabilityResolveInput } from "./capabilityResolver.js";
import type { LlmCapabilityConfig, TextGenerationClient } from "./providerTypes.js";
import { TextGenerationClientCache, createTextGenerationClient } from "./textClientFactory.js";
import {
  ModelChatGateway,
  ModelGroundedMissResponseComposer,
  type ChatGateway,
  type ChatGatewayInput,
  type GroundedMissResponseComposer,
  type GroundedMissNoContextInput,
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

export class ContextualChatGateway implements ChatGateway {
  private readonly cache: TextGenerationClientCache;

  constructor(
    private readonly deps: ContextualGatewayDependencies,
    private readonly fallback: ChatGateway,
  ) {
    this.cache = deps.clientCache ?? new TextGenerationClientCache();
  }

  async answer(input: ChatGatewayInput): Promise<string> {
    const ctx = requireWorkspaceContext(input);
    if (!ctx) {
      return this.fallback.answer(input);
    }
    const client = await resolveClient(this.cache, this.deps.resolver, "chat", ctx);
    return new ModelChatGateway(client).answer(input);
  }

  async *streamAnswer(input: ChatGatewayInput): AsyncIterable<string> {
    const ctx = requireWorkspaceContext(input);
    if (!ctx) {
      yield* this.fallback.streamAnswer(input);
      return;
    }
    const client = await resolveClient(this.cache, this.deps.resolver, "chat", ctx);
    yield* new ModelChatGateway(client).streamAnswer(input);
  }
}

export class ContextualGroundedMissResponseComposer implements GroundedMissResponseComposer {
  private readonly cache: TextGenerationClientCache;

  constructor(
    private readonly deps: ContextualGatewayDependencies,
    private readonly fallback: GroundedMissResponseComposer,
  ) {
    this.cache = deps.clientCache ?? new TextGenerationClientCache();
  }

  async composeNoContext(input: GroundedMissNoContextInput): Promise<string> {
    const ctx = requireWorkspaceContext(input);
    if (!ctx) {
      return this.fallback.composeNoContext(input);
    }
    const client = await resolveClient(this.cache, this.deps.resolver, "chat", ctx);
    return new ModelGroundedMissResponseComposer(client).composeNoContext(input);
  }
}

export class ContextualQueryRewriteGateway implements QueryRewriteGateway {
  private readonly cache: TextGenerationClientCache;

  constructor(
    private readonly deps: ContextualGatewayDependencies,
    private readonly fallback: QueryRewriteGateway,
  ) {
    this.cache = deps.clientCache ?? new TextGenerationClientCache();
  }

  async rewrite(input: QueryRewriteGatewayInput): Promise<QueryRewriteGatewayResult> {
    const ctx = requireWorkspaceContext(input);
    if (!ctx) {
      return this.fallback.rewrite(input);
    }
    const client = await resolveClient(this.cache, this.deps.resolver, "rewrite", ctx);
    return new ModelQueryRewriteGateway(client).rewrite(input);
  }
}

export class ContextualTriggerAnalysisGateway implements TriggerAnalysisGateway {
  private readonly cache: TextGenerationClientCache;

  constructor(
    private readonly deps: ContextualGatewayDependencies,
    private readonly fallback: TriggerAnalysisGateway,
  ) {
    this.cache = deps.clientCache ?? new TextGenerationClientCache();
  }

  async analyze(input: TriggerAnalysisGatewayInput): Promise<TriggerAnalysisResult> {
    const ctx = requireWorkspaceContext(input);
    if (!ctx) {
      return this.fallback.analyze(input);
    }
    const client = await resolveClient(this.cache, this.deps.resolver, "rewrite", ctx);
    return new ModelTriggerAnalysisGateway(client).analyze(input);
  }
}

export class ContextualRerankGateway implements RerankGateway {
  private readonly cache: TextGenerationClientCache;

  constructor(
    private readonly deps: ContextualGatewayDependencies,
    private readonly fallback: RerankGateway,
    private readonly logger?: AppLogger,
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
      return new OpenAISemanticRerankGateway(createOpenAIClient(config), config.model, this.logger).rerank(input);
    }
    const client = this.cache.getOrCreate(config);
    return new ModelRerankGateway(client, this.logger).rerank(input);
  }
}

// Re-export the standalone helper so external composition code can use the cache.
export { createTextGenerationClient };
