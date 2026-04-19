import { describe, expect, it, vi } from "vitest";

import { createRadiosoMcpServer } from "../src/server.js";
import type { RadiosoApiAdapter } from "../src/radiosoApiAdapter.js";

const adapter: RadiosoApiAdapter = {
  answerGrounded: vi.fn().mockResolvedValue({ answer: "ok" }),
  createDocument: vi.fn().mockResolvedValue({}),
  deleteDocument: vi.fn().mockResolvedValue(undefined),
  getDocument: vi.fn().mockResolvedValue({}),
  getRetrievalSettings: vi.fn().mockResolvedValue({
    answerSupportPolicy: "strict",
    citationDisplayEnabled: true,
    conversationMode: "guided",
    customInstruction: "",
    lexicalRewriteInstructions: "",
    metadataRules: [],
    queryRewriteEnabled: true,
    rerankEnabled: true,
    rerankTopK: 10,
    semanticRewriteInstructions: "",
    similarityThreshold: 0.4,
    suggestedQuestionsCount: 3,
    suggestedQuestionsEnabled: true,
    vectorTopK: 8,
  }),
  listDocuments: vi.fn().mockResolvedValue({ documents: [] }),
  reprocessDocument: vi.fn().mockResolvedValue({}),
  searchDocuments: vi.fn().mockResolvedValue({ results: [] }),
  updateDocument: vi.fn().mockResolvedValue({}),
  updateRetrievalSettings: vi.fn().mockResolvedValue({}),
};

describe("createRadiosoMcpServer", () => {
  it("exposes all read and write tool definitions", () => {
    const server = createRadiosoMcpServer({ adapter, serverName: "radioso-test" });

    expect(server.toolDefinitions).toHaveLength(11);
    expect(server.toolDefinitions.map((tool) => tool.name)).toContain("answer_grounded");
    expect(server.toolDefinitions.map((tool) => tool.name)).toContain("update_retrieval_settings");
  });
});
