import { describe, expect, it, vi } from "vitest";

import { createWriteToolDefinitions } from "../src/tools/writeTools.js";
import type { RadiosoApiAdapter } from "../src/radiosoApiAdapter.js";
import type { ToolExecutionContext } from "../src/types.js";

const createAdapter = (): RadiosoApiAdapter => ({
  answerGrounded: vi.fn(),
  createDocument: vi.fn().mockResolvedValue({ documentId: "doc-1", status: "queued" }),
  deleteDocument: vi.fn().mockResolvedValue(undefined),
  getDocument: vi.fn(),
  getRetrievalSettings: vi.fn().mockResolvedValue({
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
  getWorkspaceMcpContext: vi.fn(),
  listDocuments: vi.fn(),
  reprocessDocument: vi.fn().mockResolvedValue({ documentId: "doc-1", status: "queued" }),
  searchDocuments: vi.fn(),
  updateDocument: vi.fn().mockResolvedValue({ documentId: "doc-1", status: "queued" }),
  updateRetrievalSettings: vi.fn().mockResolvedValue({ vectorTopK: 12 }),
});

const createToolContext = (adapter: RadiosoApiAdapter): ToolExecutionContext => ({
  adapter,
  authInfo: {
    grantedTools: ["create_document", "update_document", "delete_document", "reprocess_document", "update_retrieval_settings"],
    sessionId: "session-1",
  },
  serverContext: {} as ToolExecutionContext["serverContext"],
});

describe("createWriteToolDefinitions", () => {
  it("exposes the expected write tools", () => {
    const tools = createWriteToolDefinitions();

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
    const tools = createWriteToolDefinitions();
    const updateSettings = tools.find((tool) => tool.name === "update_retrieval_settings");

    expect(updateSettings).toBeDefined();
    const result = await updateSettings!.execute({ vectorTopK: 12 }, createToolContext(adapter));

    expect(adapter.updateRetrievalSettings).toHaveBeenCalledWith(
      expect.objectContaining({
        vectorTopK: 12,
        queryRewriteEnabled: true,
        rerankEnabled: true,
      }),
    );
    expect(result.summary).toMatch(/updated/i);
  });

  it("accepts approvalToken without forwarding it to the upstream document create call", async () => {
    const adapter = createAdapter();
    const tools = createWriteToolDefinitions();
    const createDocument = tools.find((tool) => tool.name === "create_document");

    expect(createDocument).toBeDefined();
    await createDocument!.execute(
      {
        approvalToken: "mcp_appr_test",
        content: "Created remotely",
        title: "Remote doc",
      },
      createToolContext(adapter),
    );

    expect(adapter.createDocument).toHaveBeenCalledWith({
      content: "Created remotely",
      title: "Remote doc",
    });
  });
});
