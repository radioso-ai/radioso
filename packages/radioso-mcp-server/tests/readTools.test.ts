import { describe, expect, it, vi } from "vitest";

import { createReadToolDefinitions, MCP_RETRIEVAL_QUERY_MAX_LENGTH } from "../src/tools/readTools.js";
import type { RadiosoApiAdapter } from "../src/radiosoApiAdapter.js";
import type { ToolExecutionContext } from "../src/types.js";

const oversizedQueryMessage = `Query must be ${MCP_RETRIEVAL_QUERY_MAX_LENGTH} characters or fewer.`;

const createAdapter = (): RadiosoApiAdapter => ({
  answerGrounded: vi.fn().mockResolvedValue({ answer: "Grounded answer", citations: [{ text: "Citation" }] }),
  createDocument: vi.fn(),
  deleteDocument: vi.fn(),
  getDocument: vi.fn().mockResolvedValue({ id: "doc-1", title: "FAQ" }),
  listDocuments: vi.fn().mockResolvedValue({ documents: [{ id: "doc-1", title: "FAQ" }] }),
  reprocessDocument: vi.fn(),
  searchDocuments: vi.fn().mockResolvedValue({ results: [{ documentId: "doc-1", title: "FAQ" }] }),
  updateDocument: vi.fn(),
});

const createToolContext = (adapter: RadiosoApiAdapter): ToolExecutionContext => ({
  adapter,
  authInfo: {
    approvalRequiredTools: ["create_document"],
    grantedTools: ["answer_grounded", "list_documents", "create_document"],
    sessionId: "session-1",
    upstreamApiVersion: "0.1.0",
    upstreamMcpContextVersion: "2026-04-22",
    upstreamSupportedTools: ["answer_grounded", "list_documents", "create_document"],
    workspaceId: "workspace-1",
    workspaceName: "Default",
  },
  serverContext: {} as ToolExecutionContext["serverContext"],
});

describe("createReadToolDefinitions", () => {
  it("exposes the expected read tools", () => {
    const tools = createReadToolDefinitions();

    expect(tools.map((tool) => tool.name)).toEqual([
      "describe_capabilities",
      "list_documents",
      "get_document",
      "search_documents",
      "answer_grounded",
    ]);
    expect(tools.map((tool) => tool.name)).not.toContain("get_retrieval_settings");
  });

  it("returns capability metadata from describe_capabilities", async () => {
    const adapter = createAdapter();
    const [describeCapabilities] = createReadToolDefinitions();

    const result = await describeCapabilities.execute({}, createToolContext(adapter));

    expect(result.summary).toMatch(/available/i);
    expect(result.data).toMatchObject({
      approvalRequiredTools: expect.arrayContaining(["create_document"]),
      readTools: expect.arrayContaining(["answer_grounded", "list_documents"]),
      upstream: expect.objectContaining({
        apiVersion: "0.1.0",
        mcpContextVersion: "2026-04-22",
      }),
      workspace: expect.objectContaining({
        id: "workspace-1",
        name: "Default",
      }),
      writeTools: expect.arrayContaining(["create_document"]),
    });
    expect(result.data).toMatchObject({
      readTools: expect.not.arrayContaining(["get_retrieval_settings"]),
      writeTools: expect.not.arrayContaining(["update_retrieval_settings"]),
    });
  });

  it("rejects oversized search_documents queries before calling the adapter", async () => {
    const adapter = createAdapter();
    const searchDocuments = createReadToolDefinitions().find((tool) => tool.name === "search_documents");
    const oversizedQuery = "a".repeat(MCP_RETRIEVAL_QUERY_MAX_LENGTH + 1);

    expect(searchDocuments).toBeDefined();
    await expect(searchDocuments!.execute({ query: oversizedQuery }, createToolContext(adapter))).rejects.toThrow(
      oversizedQueryMessage,
    );
    expect(adapter.searchDocuments).not.toHaveBeenCalled();
  });

  it("rejects oversized answer_grounded queries before calling the adapter", async () => {
    const adapter = createAdapter();
    const answerGrounded = createReadToolDefinitions().find((tool) => tool.name === "answer_grounded");
    const oversizedQuery = "a".repeat(MCP_RETRIEVAL_QUERY_MAX_LENGTH + 1);

    expect(answerGrounded).toBeDefined();
    await expect(answerGrounded!.execute({ query: oversizedQuery }, createToolContext(adapter))).rejects.toThrow(
      oversizedQueryMessage,
    );
    expect(adapter.answerGrounded).not.toHaveBeenCalled();
  });
});
