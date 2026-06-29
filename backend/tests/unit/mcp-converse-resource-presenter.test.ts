import { describe, expect, it } from "vitest";

import {
  presentMcpConverseGroundedAnswer,
  presentMcpConverseResource,
  presentMcpConverseResourceList,
} from "../../src/app/http/presenters/mcpConverseResourcePresenter.js";

describe("MCP converse resource presenter", () => {
  it("hides internal citation document and chunk identifiers", () => {
    const presented = presentMcpConverseGroundedAnswer({
      answer: "Use the policy.",
      citations: [{
        documentId: "11111111-1111-1111-1111-111111111111",
        chunkId: "22222222-2222-2222-2222-222222222222",
        title: "Policy",
        sourceUrl: "https://example.com/policy",
      }],
      retrieval: { agentScoped: true },
    });

    expect(presented).toEqual({
      answer: "Use the policy.",
      citations: [{
        documentId: "",
        chunkId: "",
        title: "Policy",
        sourceUrl: "https://example.com/policy",
      }],
      retrieval: { agentScoped: true },
    });
  });

  it("presents only public resource fields", () => {
    expect(presentMcpConverseResourceList([{
      uri: "radioso://agent-resource/opaque",
      name: "Policy",
      mimeType: "text/markdown",
    }])).toEqual({
      resources: [{
        uri: "radioso://agent-resource/opaque",
        name: "Policy",
        mimeType: "text/markdown",
      }],
    });

    expect(presentMcpConverseResource({
      uri: "radioso://agent-resource/opaque",
      name: "Policy",
      mimeType: "text/markdown",
      text: "Sanitized content",
    })).toEqual({
      uri: "radioso://agent-resource/opaque",
      name: "Policy",
      mimeType: "text/markdown",
      text: "Sanitized content",
    });
  });
});
