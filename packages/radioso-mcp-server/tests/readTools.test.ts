import { describe, expect, it, vi } from "vitest";

import { createReadToolDefinitions } from "../src/tools/readTools.js";
import type { RadiosoApiAdapter } from "../src/radiosoApiAdapter.js";

const createAdapter = (): RadiosoApiAdapter => ({
  answerGrounded: vi.fn().mockResolvedValue({ answer: "Grounded answer", citations: [{ text: "Citation" }] }),
  createDocument: vi.fn(),
  deleteDocument: vi.fn(),
  getDocument: vi.fn().mockResolvedValue({ id: "doc-1", title: "FAQ" }),
  getRetrievalSettings: vi.fn().mockResolvedValue({ vectorTopK: 8 }),
  listDocuments: vi.fn().mockResolvedValue({ documents: [{ id: "doc-1", title: "FAQ" }] }),
  reprocessDocument: vi.fn(),
  searchDocuments: vi.fn().mockResolvedValue({ results: [{ documentId: "doc-1", title: "FAQ" }] }),
  updateDocument: vi.fn(),
  updateRetrievalSettings: vi.fn(),
});

describe("createReadToolDefinitions", () => {
  it("exposes the expected read tools", () => {
    const tools = createReadToolDefinitions(createAdapter());

    expect(tools.map((tool) => tool.name)).toEqual([
      "describe_capabilities",
      "list_documents",
      "get_document",
      "search_documents",
      "answer_grounded",
      "get_retrieval_settings",
    ]);
  });

  it("returns capability metadata from describe_capabilities", async () => {
    const [describeCapabilities] = createReadToolDefinitions(createAdapter());

    const result = await describeCapabilities.execute({});

    expect(result.summary).toMatch(/available/i);
    expect(result.data).toMatchObject({
      readTools: expect.arrayContaining(["answer_grounded", "list_documents"]),
      writeTools: expect.arrayContaining(["create_document", "update_retrieval_settings"]),
    });
  });
});
