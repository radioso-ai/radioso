import { describe, expect, it } from "vitest";

import { GatewayQueryRewritePortAdapter } from "../../src/modules/retrieval/services/gatewayQueryRewritePortAdapter.js";
import type {
  QueryRewriteGateway,
  QueryRewriteGatewayInput,
  QueryRewriteGatewayResult,
} from "../../src/modules/retrieval/services/queryRewriteGateways.js";

const stubGateway = (
  responder: (input: QueryRewriteGatewayInput) => QueryRewriteGatewayResult | Promise<QueryRewriteGatewayResult>,
): QueryRewriteGateway & { calls: QueryRewriteGatewayInput[] } => {
  const calls: QueryRewriteGatewayInput[] = [];
  return Object.assign(
    {
      async rewrite(input: QueryRewriteGatewayInput) {
        calls.push(input);
        return responder(input);
      },
    } as QueryRewriteGateway,
    { calls },
  );
};

const throwingGateway = (error: Error): QueryRewriteGateway => ({
  async rewrite() {
    throw error;
  },
});

describe("GatewayQueryRewritePortAdapter", () => {
  it("returns the gateway's semantic and lexical rewrites when both are present", async () => {
    const gateway = stubGateway(() => ({
      rewrittenQuery: "fallback",
      semanticQuery: "who was Mahatma Gandhi",
      lexicalQuery: "Mahatma Gandhi biography",
      confidence: 0.9,
    }));
    const adapter = new GatewayQueryRewritePortAdapter(gateway);

    const result = await adapter.rewrite({ query: "gandhi" });

    expect(result).toEqual({
      semantic: "who was Mahatma Gandhi",
      lexical: "Mahatma Gandhi biography",
    });
  });

  it("falls back to rewrittenQuery when a specific form is missing", async () => {
    const gateway = stubGateway(() => ({
      rewrittenQuery: "shared rewrite",
      confidence: 0.7,
    }));
    const adapter = new GatewayQueryRewritePortAdapter(gateway);

    const result = await adapter.rewrite({ query: "kasturbai" });

    expect(result).toEqual({
      semantic: "shared rewrite",
      lexical: "shared rewrite",
    });
  });

  it("falls back to the original query when the gateway returns empty rewrites", async () => {
    const gateway = stubGateway(() => ({
      rewrittenQuery: "",
      semanticQuery: "",
      lexicalQuery: "",
      confidence: 0.1,
    }));
    const adapter = new GatewayQueryRewritePortAdapter(gateway);

    const result = await adapter.rewrite({ query: "tell me more" });

    expect(result).toEqual({ semantic: "tell me more", lexical: "tell me more" });
  });

  it("returns the original query when the gateway throws", async () => {
    const adapter = new GatewayQueryRewritePortAdapter(throwingGateway(new Error("provider down")));

    const result = await adapter.rewrite({ query: "unaffected" });

    expect(result).toEqual({ semantic: "unaffected", lexical: "unaffected" });
  });

  it("forwards workspaceContext to the underlying gateway", async () => {
    const gateway = stubGateway(() => ({
      rewrittenQuery: "rewritten",
      confidence: 0.5,
    }));
    const adapter = new GatewayQueryRewritePortAdapter(gateway);

    await adapter.rewrite({
      query: "q",
      workspaceContext: { workspaceId: "ws-1" },
    });

    expect((gateway as ReturnType<typeof stubGateway>).calls[0]).toMatchObject({
      query: "q",
      workspaceContext: { workspaceId: "ws-1" },
      contextMessages: [],
    });
  });

  it("trims whitespace-only rewrites back to the original query", async () => {
    const gateway = stubGateway(() => ({
      rewrittenQuery: "   ",
      semanticQuery: "   ",
      lexicalQuery: "   ",
      confidence: 0.3,
    }));
    const adapter = new GatewayQueryRewritePortAdapter(gateway);

    const result = await adapter.rewrite({ query: "original" });

    expect(result).toEqual({ semantic: "original", lexical: "original" });
  });
});
