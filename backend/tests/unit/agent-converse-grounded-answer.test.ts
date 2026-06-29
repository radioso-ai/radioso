import { describe, expect, it } from "vitest";

import { AgentConverseGroundedAnswerService } from "../../src/modules/retrieval/services/agentConverseGroundedAnswerService.js";

const principal = {
  workspaceId: "w1",
  agentId: "a1",
  grantId: "g1",
  publicSessionId: "s1",
} as never;

const agent = {
  id: "a1",
  sourceScope: { mode: "all" },
  customInstruction: null,
  citationDisplayEnabled: true,
  skillSettings: {},
} as never;

const citations = (count: number) =>
  Array.from({ length: count }, (_unused, index) => ({
    documentId: "",
    chunkId: "",
    title: `c${index}`,
  }));

const makeService = (returnedCitations: ReturnType<typeof citations>) =>
  new AgentConverseGroundedAnswerService({
    agentRepository: { findByIdAndWorkspaceId: async () => agent },
    retrievalAnswerService: {
      answer: async () => ({ outcome: "answer", answer: "grounded", citations: returnedCitations }),
    },
  } as never);

describe("AgentConverseGroundedAnswerService maxResults", () => {
  it("caps returned citations to maxResults", async () => {
    const service = makeService(citations(5));
    const result = await service.answer(principal, { query: "q", maxResults: 2 });
    expect(result.citations).toHaveLength(2);
  });

  it("returns all citations when maxResults is omitted", async () => {
    const service = makeService(citations(5));
    const result = await service.answer(principal, { query: "q" });
    expect(result.citations).toHaveLength(5);
  });

  it("ignores a non-positive maxResults", async () => {
    const service = makeService(citations(3));
    const result = await service.answer(principal, { query: "q", maxResults: 0 });
    expect(result.citations).toHaveLength(3);
  });
});
