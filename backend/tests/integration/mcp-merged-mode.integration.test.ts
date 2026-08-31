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

  it("rejects personal API credentials in merged MCP mode", async () => {
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
      .expect(401);
  });

  it("keeps the removed legacy rotation route absent while rejecting its replacement credential", async () => {
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
      .expect(404);

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
          failed: false,
          mode: "merged",
          path: "/internal/mcp",
          ready: true,
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

  it("rejects personal API credentials on non-POST MCP lifecycle methods", async () => {
    const { app } = createTestApp({
      envOverrides: {
        RADIOSO_BASE_URL: "http://127.0.0.1:8080",
        RADIOSO_MCP_ENABLED: true,
      },
    });
    const { token } = await issueTestToken(app);

    await request(app)
      .delete("/mcp")
      .set("Authorization", `Bearer ${token}`)
      .set("Mcp-Protocol-Version", "2025-11-25")
      .expect(401);
  });

});
