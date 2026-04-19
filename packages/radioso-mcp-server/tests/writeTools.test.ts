import { describe, expect, it, vi } from "vitest";

import { createWriteToolDefinitions } from "../src/tools/writeTools.js";
import type { RadiosoApiAdapter } from "../src/radiosoApiAdapter.js";

const createAdapter = (): RadiosoApiAdapter => ({
  answerGrounded: vi.fn(),
  createDocument: vi.fn().mockResolvedValue({ documentId: "doc-1", status: "queued" }),
  deleteDocument: vi.fn().mockResolvedValue(undefined),
  getDocument: vi.fn(),
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
  listDocuments: vi.fn(),
  reprocessDocument: vi.fn().mockResolvedValue({ documentId: "doc-1", status: "queued" }),
  searchDocuments: vi.fn(),
  updateDocument: vi.fn().mockResolvedValue({ documentId: "doc-1", status: "queued" }),
  updateRetrievalSettings: vi.fn().mockResolvedValue({ vectorTopK: 12 }),
});

describe("createWriteToolDefinitions", () => {
  it("exposes the expected write tools", () => {
    const tools = createWriteToolDefinitions(createAdapter());

    expect(tools.map((tool) => tool.name)).toEqual([
      "create_document",
      "update_document",
      "delete_document",
      "reprocess_document",
      "update_retrieval_settings",
    ]);
  });

  it("merges retrieval settings patches before update", async () => {
    const adapter = createAdapter();
    const tools = createWriteToolDefinitions(adapter);
    const updateSettings = tools.find((tool) => tool.name === "update_retrieval_settings");

    expect(updateSettings).toBeDefined();
    const result = await updateSettings!.execute({ vectorTopK: 12 });

    expect(adapter.updateRetrievalSettings).toHaveBeenCalledWith(
      expect.objectContaining({
        vectorTopK: 12,
        queryRewriteEnabled: true,
        rerankEnabled: true,
      }),
    );
    expect(result.summary).toMatch(/updated/i);
  });
});
