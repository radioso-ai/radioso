import request from "supertest";
import { describe, expect, it } from "vitest";

import { createTestApp, issueTestToken } from "../support/testApp.js";

describe("workspace MCP context contract", () => {
  it("returns workspace identity plus MCP capability metadata for a valid bearer token", async () => {
    const { app } = createTestApp();
    const token = await issueTestToken(app, "workspace-mcp-context@example.com");

    const response = await request(app)
      .get("/api/v1/workspace/mcp/context")
      .set("authorization", `Bearer ${token.token}`);

    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({
      apiVersion: "0.1.0",
      mcpContextVersion: "2026-04-22",
      supportedTools: expect.arrayContaining([
        "answer_grounded",
        "create_document",
        "describe_capabilities",
        "get_document",
        "get_retrieval_settings",
        "list_documents",
        "reprocess_document",
        "search_documents",
        "update_document",
        "update_retrieval_settings",
      ]),
      workspaceId: token.workspaceId,
      workspaceName: "Default",
    });
  });

  it("rejects unauthenticated MCP context requests", async () => {
    const { app } = createTestApp();

    const response = await request(app)
      .get("/api/v1/workspace/mcp/context");

    expect(response.status).toBe(401);
    expect(response.body).toMatchObject({
      error: {
        code: "unauthorized",
      },
    });
  });

  it("fails closed when the workspace token no longer resolves to an active workspace", async () => {
    const { app, dependencies } = createTestApp();
    const token = await issueTestToken(app, "workspace-mcp-context-deleted@example.com");
    await dependencies.workspaceRepository.deleteById(token.workspaceId);

    const response = await request(app)
      .get("/api/v1/workspace/mcp/context")
      .set("authorization", `Bearer ${token.token}`);

    expect(response.status).toBe(403);
    expect(response.body).toMatchObject({
      error: {
        code: "forbidden",
        message: "Workspace token no longer resolves to an active workspace.",
      },
    });
  });
});
