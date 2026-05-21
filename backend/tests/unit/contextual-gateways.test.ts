import { describe, expect, it } from "vitest";

import {
  ContextualChatGateway,
  ContextualQueryRewriteGateway,
  ContextualRerankGateway,
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
        return "workspace-answer";
      },
      async *stream(req) {
        completeCalls.push({ apiKey: cfg.apiKey, prompt: req.prompt });
        yield "workspace";
      },
    })) as TextGenerationClientCache["getOrCreate"];

    const gateway = new ContextualChatGateway(
      { resolver: buildResolver({ chat: config }), clientCache: cache },
      new StubChatFallback(),
    );

    const answer = await gateway.answer({
      query: "q",
      history: [],
      prompt: "p",
      workspaceContext: { workspaceId: "ws-1" },
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

    await gateway.rewrite({ query: "q", contextMessages: [] });

    expect(fallback.calls).toBe(1);
  });
});

describe("ContextualRerankGateway", () => {
  it("uses fallback when no workspaceContext", async () => {
    const fallback = new StubRerankFallback();
    const gateway = new ContextualRerankGateway(
      { resolver: buildResolver({}), clientCache: new TextGenerationClientCache() },
      fallback,
    );

    await gateway.rerank({ query: "q", contexts: [] });

    expect(fallback.calls).toBe(1);
  });
});
