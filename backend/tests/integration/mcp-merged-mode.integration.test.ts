import request from "supertest";
import { describe, expect, it } from "vitest";

import { createTestApp, issueTestToken } from "../support/testApp.js";

const mcpPayload = {
  id: "tools-1",
  jsonrpc: "2.0",
  method: "tools/list",
  params: {},
};

describe("merged MCP backend mount", () => {
  it("returns 404 on /mcp when merged mode is disabled", async () => {
    const { app } = createTestApp();

    await request(app)
      .post("/mcp")
      .send(mcpPayload)
      .expect(404);
  });

  it("serves tools/list at /mcp with a workspace API token in merged mode", async () => {
    const { app } = createTestApp({
      envOverrides: {
        RADIOSO_BASE_URL: "http://127.0.0.1:8080",
        RADIOSO_MCP_ENABLED: true,
      },
    });
    const { token } = await issueTestToken(app);

    await request(app)
      .post("/mcp")
      .set("Authorization", `Bearer ${token}`)
      .set("Content-Type", "application/json")
      .set("Mcp-Protocol-Version", "2025-11-25")
      .set("Accept", "application/json, text/event-stream")
      .send({
        id: "init-1",
        jsonrpc: "2.0",
        method: "initialize",
        params: {
          capabilities: {},
          clientInfo: { name: "integration-test", version: "1.0.0" },
          protocolVersion: "2025-11-25",
        },
      })
      .expect(200);

    const response = await request(app)
      .post("/mcp")
      .set("Authorization", `Bearer ${token}`)
      .set("Content-Type", "application/json")
      .set("Mcp-Protocol-Version", "2025-11-25")
      .set("Accept", "application/json, text/event-stream")
      .send(mcpPayload)
      .expect(200);

    expect(response.body.result.tools.map((tool: { name: string }) => tool.name)).toContain("describe_capabilities");
  });

  it("rejects revoked workspace API tokens on subsequent merged MCP requests", async () => {
    const { app } = createTestApp({
      envOverrides: {
        RADIOSO_BASE_URL: "http://127.0.0.1:8080",
        RADIOSO_MCP_ENABLED: true,
      },
    });
    const { cookie, token, workspaceId } = await issueTestToken(app);

    await request(app)
      .post(`/api/v1/account/workspaces/${workspaceId}/token/rotate`)
      .set("Cookie", cookie)
      .expect(200);

    const response = await request(app)
      .post("/mcp")
      .set("Authorization", `Bearer ${token}`)
      .set("Content-Type", "application/json")
      .set("Mcp-Protocol-Version", "2025-11-25")
      .send(mcpPayload)
      .expect(401);

    expect(response.body.error.data.code).toBe("invalid_access_token");
  });

  it("reports merged MCP mount status in backend health", async () => {
    const { app } = createTestApp({
      envOverrides: {
        RADIOSO_BASE_URL: "http://127.0.0.1:8080",
        RADIOSO_MCP_ENABLED: true,
        RADIOSO_MCP_MOUNT_PATH: "/internal/mcp",
      },
    });

    await request(app)
      .get("/health")
      .expect(200)
      .expect(({ body }) => {
        expect(body.mcp).toEqual({
          enabled: true,
          mode: "merged",
          path: "/internal/mcp",
          standalone: false,
        });
      });
  });

  it("applies merged MCP CORS independently from cookie CORS", async () => {
    const { app } = createTestApp({
      envOverrides: {
        RADIOSO_BASE_URL: "http://127.0.0.1:8080",
        RADIOSO_MCP_MERGED_CORS_ORIGINS: "https://client.example",
        RADIOSO_MCP_ENABLED: true,
      },
    });

    await request(app)
      .options("/mcp")
      .set("Origin", "https://client.example")
      .expect(204)
      .expect("Access-Control-Allow-Origin", "https://client.example")
      .expect(({ headers }) => {
        expect(headers["access-control-allow-credentials"]).toBeUndefined();
        expect(headers["access-control-allow-methods"]).toContain("DELETE");
        expect(headers["access-control-allow-headers"]).toContain("Mcp-Session-Id");
        expect(headers["access-control-expose-headers"]).toContain("Mcp-Session-Id");
      });
  });

  it("routes non-POST MCP lifecycle methods through the merged MCP handler", async () => {
    const { app } = createTestApp({
      envOverrides: {
        RADIOSO_BASE_URL: "http://127.0.0.1:8080",
        RADIOSO_MCP_ENABLED: true,
      },
    });
    const { token } = await issueTestToken(app);

    const initializeResponse = await request(app)
      .post("/mcp")
      .set("Authorization", `Bearer ${token}`)
      .set("Content-Type", "application/json")
      .set("Mcp-Protocol-Version", "2025-11-25")
      .set("Accept", "application/json, text/event-stream")
      .send({
        id: "init-delete-1",
        jsonrpc: "2.0",
        method: "initialize",
        params: {
          capabilities: {},
          clientInfo: { name: "integration-test", version: "1.0.0" },
          protocolVersion: "2025-11-25",
        },
      })
      .expect(200);

    const deleteRequest = request(app)
      .delete("/mcp")
      .set("Authorization", `Bearer ${token}`)
      .set("Mcp-Protocol-Version", "2025-11-25");

    const sessionId = initializeResponse.headers["mcp-session-id"];
    if (typeof sessionId === "string") {
      deleteRequest.set("Mcp-Session-Id", sessionId);
    }

    await deleteRequest
      .expect((response) => {
        expect(response.status).not.toBe(404);
      });
  });

});
