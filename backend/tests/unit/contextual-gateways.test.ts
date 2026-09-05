import { beforeEach, describe, expect, it, vi } from "vitest";

const { openAiResponsesCreate } = vi.hoisted(() => ({
  openAiResponsesCreate: vi.fn(),
}));

vi.mock("../../src/shared/infra/llm/openaiProvider.js", async () => {
  const actual = await vi.importActual<typeof import("../../src/shared/infra/llm/openaiProvider.js")>(
    "../../src/shared/infra/llm/openaiProvider.js",
  );
  return {
    ...actual,
    createOpenAIClient: () => ({ responses: { create: openAiResponsesCreate } }),
  };
});

import {
  ContextualChatGateway,
  ContextualDirectiveMatchGatewayFactory,
  ContextualQueryRewriteGateway,
  ContextualRerankGateway,
  ContextualStructuredInferenceFactory,
  createRewriteTierStructuredInferenceFactory,
} from "../../src/shared/infra/llm/contextualGateways.js";
import { TextGenerationClientCache } from "../../src/shared/infra/llm/textClientFactory.js";
import type { ChatGateway } from "../../src/modules/chat/services/chatService.js";
import type {
  QueryRewriteGateway,
  QueryRewriteGatewayInput,
  QueryRewriteGatewayResult,
} from "../../src/modules/retrieval/services/queryRewriteGateways.js";
import type { RerankGateway, RerankGatewayInput } from "../../src/modules/retrieval/services/rerankService.js";
import type {
  LlmCapabilityResolveInput,
  LlmCapabilityResolver,
} from "../../src/shared/infra/llm/capabilityResolver.js";
import type {
  LlmCapabilityConfig,
  LlmCapabilityName,
} from "../../src/shared/infra/llm/providerTypes.js";
import type { ModelUsageEvent, UsageEventRecorder } from "../../src/shared/domain/usageEventRecorder.js";
import { captureModelCallTrace } from "../../src/shared/observability/tracing/modelCallTraceContext.js";
import { streamResult, textResult } from "../support/llmStubs.js";

beforeEach(() => {
  openAiResponsesCreate.mockReset();
});

const usageContext = {
  workspaceId: "ws-1",
  surface: "test",
  operation: "test_operation",
  attemptKey: "test",
};

const buildResolver = (
  configs: Partial<Record<LlmCapabilityName, LlmCapabilityConfig>>,
): LlmCapabilityResolver => ({
  async resolve(capability, _input: LlmCapabilityResolveInput) {
    const config = configs[capability];
    if (!config) {
      throw new Error(`no test config for capability ${capability}`);
    }
    return config;
  },
});

class StubChatFallback implements ChatGateway {
  calls: Array<{ method: string }> = [];
  async answer() {
    this.calls.push({ method: "answer" });
    return "fallback-answer";
  }
  async *streamAnswer() {
    this.calls.push({ method: "streamAnswer" });
    yield "fallback";
  }
}

class StubQueryRewriteFallback implements QueryRewriteGateway {
  calls = 0;
  async rewrite(_input: QueryRewriteGatewayInput): Promise<QueryRewriteGatewayResult> {
    this.calls += 1;
    return { rewrittenQuery: "fallback", confidence: 0.5 };
  }
}

class StubRerankFallback implements RerankGateway {
  calls = 0;
  async rerank(_input: RerankGatewayInput) {
    this.calls += 1;
    return [];
  }
}

describe("ContextualChatGateway", () => {
  it("delegates to fallback when no workspaceContext is provided", async () => {
    const fallback = new StubChatFallback();
    const gateway = new ContextualChatGateway(
      { resolver: buildResolver({}), clientCache: new TextGenerationClientCache() },
      fallback,
    );

    const answer = await gateway.answer({
      query: "q",
      history: [],
      prompt: "p",
      usageContext,
    });

    expect(answer).toBe("fallback-answer");
    expect(fallback.calls).toEqual([{ method: "answer" }]);
  });

  it("resolves a workspace-specific client and uses it when workspaceContext is set", async () => {
    const completeCalls: Array<{ apiKey: string; prompt: string }> = [];
    const config: LlmCapabilityConfig = {
      capability: "chat",
      provider: "openai",
      model: "gpt-test",
      apiKey: "ws-key-1",
    };
    const cache = new TextGenerationClientCache();
    // Pre-populate cache so resolver -> getOrCreate returns our stub instead of building a real OpenAI client.
    cache.getOrCreate = ((cfg) => ({
      metadata: { capability: cfg.capability, provider: cfg.provider, model: cfg.model },
      async complete(req) {
        completeCalls.push({ apiKey: cfg.apiKey, prompt: req.prompt });
        return textResult("workspace-answer");
      },
      stream(req) {
        completeCalls.push({ apiKey: cfg.apiKey, prompt: req.prompt });
        return streamResult(["workspace"]);
      },
    }));

    const gateway = new ContextualChatGateway(
      { resolver: buildResolver({ chat: config }), clientCache: cache },
      new StubChatFallback(),
    );

    const answer = await gateway.answer({
      query: "q",
      history: [],
      prompt: "p",
      workspaceContext: { workspaceId: "ws-1" },
      usageContext,
    });

    expect(answer).toBe("workspace-answer");
    expect(completeCalls).toEqual([{ apiKey: "ws-key-1", prompt: "p" }]);
  });
});

describe("ContextualQueryRewriteGateway", () => {
  it("uses fallback when no workspaceContext", async () => {
    const fallback = new StubQueryRewriteFallback();
    const gateway = new ContextualQueryRewriteGateway(
      { resolver: buildResolver({}), clientCache: new TextGenerationClientCache() },
      fallback,
    );

    await gateway.rewrite({ query: "q", contextMessages: [], usageContext });

    expect(fallback.calls).toBe(1);
  });
});

describe("ContextualStructuredInferenceFactory", () => {
  const config: LlmCapabilityConfig = {
    capability: "chat",
    provider: "openai",
    model: "gpt-test",
    apiKey: "ws-key-1",
  };

  // Tracks which capability each factory actually asked the resolver for,
  // independent of what config the stub resolver happens to return.
  const buildCapabilityTrackingResolver = (): {
    resolver: LlmCapabilityResolver;
    capabilities: LlmCapabilityName[];
  } => {
    const capabilities: LlmCapabilityName[] = [];
    return {
      capabilities,
      resolver: {
        async resolve(capability) {
          capabilities.push(capability);
          return config;
        },
      },
    };
  };

  const stubClientCache = (): TextGenerationClientCache => {
    const cache = new TextGenerationClientCache();
    cache.getOrCreate = ((cfg) => ({
      metadata: { capability: cfg.capability, provider: cfg.provider, model: cfg.model },
      async complete() {
        return textResult("ok", {
          inputTokens: 5,
          outputTokens: 2,
          totalTokens: 7,
          quality: "actual",
        });
      },
      stream() {
        return streamResult(["ok"]);
      },
    }));
    return cache;
  };

  it("resolves the chat capability by default", async () => {
    const { resolver, capabilities } = buildCapabilityTrackingResolver();
    const factory = new ContextualStructuredInferenceFactory({ resolver, clientCache: stubClientCache() });

    await factory.create({
      workspaceContext: { workspaceId: "ws-1" },
      modelCallContext: usageContext,
    });

    expect(capabilities).toEqual(["chat"]);
  });

  it("resolves the rewrite (cheap-tier) capability via createRewriteTierStructuredInferenceFactory", async () => {
    const { resolver, capabilities } = buildCapabilityTrackingResolver();
    const factory = createRewriteTierStructuredInferenceFactory({ resolver, clientCache: stubClientCache() });

    await factory.create({
      workspaceContext: { workspaceId: "ws-1" },
      modelCallContext: usageContext,
    });

    expect(capabilities).toEqual(["rewrite"]);
  });

  it("records usage events through the cheap-tier factory the same way as the default factory", async () => {
    const usageEvents: ModelUsageEvent[] = [];
    const recorder: UsageEventRecorder = {
      async recordEmbedding() {},
      async recordModelCall(event) {
        usageEvents.push(event);
      },
    };
    const { resolver } = buildCapabilityTrackingResolver();
    const factory = createRewriteTierStructuredInferenceFactory({ resolver, clientCache: stubClientCache() }, recorder);

    const pipeline = await factory.create({
      workspaceContext: { workspaceId: "ws-1" },
      modelCallContext: usageContext,
    });
    await pipeline.complete({ prompt: "p", operation: usageContext });

    expect(usageEvents).toHaveLength(1);
    expect(usageEvents[0]).toMatchObject({
      workspaceId: "ws-1",
      surface: "test",
      operation: "test_operation",
      inputTokens: 5,
      outputTokens: 2,
      totalTokens: 7,
      status: "succeeded",
    });
  });
});

describe("ContextualDirectiveMatchGatewayFactory", () => {
  it("builds a usage-accounted directive match gateway for the workspace client", async () => {
    const usageEvents: ModelUsageEvent[] = [];
    const recorder: UsageEventRecorder = {
      async recordEmbedding() {},
      async recordModelCall(event) {
        usageEvents.push(event);
      },
    };
    const completeCalls: Array<{ apiKey: string; prompt: string; systemPrompt?: string }> = [];
    const config: LlmCapabilityConfig = {
      capability: "chat",
      provider: "openai",
      model: "gpt-test",
      apiKey: "ws-key-1",
    };
    const cache = new TextGenerationClientCache();
    cache.getOrCreate = ((cfg) => ({
      metadata: { capability: cfg.capability, provider: cfg.provider, model: cfg.model },
      async complete(req) {
        completeCalls.push({ apiKey: cfg.apiKey, prompt: req.prompt, systemPrompt: req.systemPrompt });
        return textResult('[{"name":"refund-tone","confidence":0.91}]', {
          inputTokens: 12,
          outputTokens: 4,
          totalTokens: 16,
          providerRequestId: "provider-req-1",
          quality: "actual",
        });
      },
      stream() {
        return streamResult([]);
      },
    }));

    const factory = new ContextualDirectiveMatchGatewayFactory(
      { resolver: buildResolver({ chat: config }), clientCache: cache },
      recorder,
    );

    const gateway = await factory.create({
      workspaceContext: { workspaceId: "ws-1" },
      usageContext: {
        accountId: "acct-1",
        workspaceId: "ws-1",
        conversationId: "conv-1",
        messageId: "msg-1",
        surface: "chat",
        operation: "directive_match",
        attemptKey: "msg-1:directive_match",
      },
    });
    const matches = await gateway.match({
      turnContext: { query: "Can I get a refund?" },
      directives: [{
        name: "refund-tone",
        condition: { kind: "contextual", description: "Refund request" },
        action: "Use refund support tone.",
      }],
    });

    expect(matches).toEqual([{ name: "refund-tone", confidence: 0.91 }]);
    expect(completeCalls).toEqual([
      expect.objectContaining({
        apiKey: "ws-key-1",
        prompt: expect.stringContaining("refund-tone"),
        systemPrompt: expect.any(String),
      }),
    ]);
    expect(usageEvents).toHaveLength(1);
    expect(usageEvents[0]).toMatchObject({
      accountId: "acct-1",
      workspaceId: "ws-1",
      conversationId: "conv-1",
      messageId: "msg-1",
      surface: "chat",
      operation: "directive_match",
      provider: "openai",
      model: "gpt-test",
      inputTokens: 12,
      outputTokens: 4,
      totalTokens: 16,
      usageQuality: "actual",
      providerRequestId: "provider-req-1",
      status: "succeeded",
    });
  });
});

describe("ContextualRerankGateway", () => {
  it("uses fallback when no workspaceContext", async () => {
    const fallback = new StubRerankFallback();
    const gateway = new ContextualRerankGateway(
      { resolver: buildResolver({}), clientCache: new TextGenerationClientCache() },
      fallback,
    );

    await gateway.rerank({ query: "q", today: "2026-01-01", contexts: [] });

    expect(fallback.calls).toBe(1);
  });

  it("records each contextual OpenAI rerank provider attempt once", async () => {
    openAiResponsesCreate.mockResolvedValue({
      output_text: JSON.stringify({ scores: [] }),
      usage: { input_tokens: 13, output_tokens: 3, total_tokens: 16 },
    });
    const fallback = new StubRerankFallback();
    const gateway = new ContextualRerankGateway(
      {
        resolver: buildResolver({
          rerank: {
            capability: "rerank",
            provider: "openai",
            model: "gpt-4.1-mini-contextual",
            apiKey: "workspace-key",
          },
        }),
        clientCache: new TextGenerationClientCache(),
      },
      fallback,
    );

    const { calls } = await captureModelCallTrace(() => gateway.rerank({
      query: "q",
      today: "2026-01-01",
      contexts: [],
      workspaceContext: { workspaceId: "ws-1" },
      usageContext: { ...usageContext, operation: "rerank" },
    }));

    expect(fallback.calls).toBe(0);
    expect(openAiResponsesCreate).toHaveBeenCalledOnce();
    expect(calls).toEqual([expect.objectContaining({
      operation: "rerank",
      model: "gpt-4.1-mini-contextual",
      inputTokens: 13,
      outputTokens: 3,
      totalTokens: 16,
    })]);
  });
});
