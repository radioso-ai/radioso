import { setTimeout as delay } from "node:timers/promises";

import { createClient } from "redis";
import request from "supertest";
import { afterEach, describe, expect, it } from "vitest";

import { closeMergedMcpPurgeLifecycle } from "../../src/app/server/mcpMount.js";
import { createTestApp, issueTestToken } from "../support/testApp.js";

const mcpPayload = {
  id: "tools-1",
  jsonrpc: "2.0",
  method: "tools/list",
  params: {},
};

const mergedRedisUrl = process.env.MERGED_MCP_INTEGRATION_REDIS_URL;
const redisIntegration = mergedRedisUrl ? describe : describe.skip;

const waitForMergedHealth = async (app: ReturnType<typeof createTestApp>["app"]): Promise<void> => {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    const response = await request(app).get("/health");
    if (response.status === 200 && response.body.mcp?.ready === true) {
      return;
    }
    await delay(25);
  }
  throw new Error("Merged MCP purge readiness did not become ready before timeout.");
};

describe("merged MCP backend mount", () => {
  it("keeps /mcp absent when merged mode is disabled", async () => {
    const { app } = createTestApp();

    await Promise.all([
      request(app).get("/mcp").expect(404),
      request(app).post("/mcp").send(mcpPayload).expect(404),
      request(app).delete("/mcp").expect(404),
    ]);
  });

  it("keeps /mcp absent for REST credentials across lifecycle methods", async () => {
    const { app } = createTestApp({
      envOverrides: {
        RADIOSO_BASE_URL: "http://127.0.0.1:8080",
        RADIOSO_MCP_ENABLED: true,
      },
    });
    const { token } = await issueTestToken(app);

    await Promise.all([
      request(app)
        .get("/mcp")
        .set("Authorization", `Bearer ${token}`)
        .expect(404),
      request(app)
        .post("/mcp")
        .set("Authorization", `Bearer ${token}`)
        .set("Content-Type", "application/json")
        .set("Mcp-Protocol-Version", "2025-11-25")
        .set("Accept", "application/json, text/event-stream")
        .send(mcpPayload)
        .expect(404),
      request(app)
        .delete("/mcp")
        .set("Authorization", `Bearer ${token}`)
        .expect(404),
    ]);
  });

  it("keeps the removed legacy rotation route absent", async () => {
    const { app } = createTestApp({
      envOverrides: {
        RADIOSO_BASE_URL: "http://127.0.0.1:8080",
        RADIOSO_MCP_ENABLED: true,
      },
    });
    const { cookie, workspaceId } = await issueTestToken(app);

    await request(app)
      .post(`/api/v1/account/workspaces/${workspaceId}/token/rotate`)
      .set("Cookie", cookie)
      .expect(404);

    await request(app)
      .post("/mcp")
      .set("Content-Type", "application/json")
      .set("Mcp-Protocol-Version", "2025-11-25")
      .send(mcpPayload)
      .expect(404);
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
          enabled: false,
          failed: false,
          mode: "unsupported",
          path: "/internal/mcp",
          ready: true,
          reason: "merged_auth_unavailable",
          standalone: false,
        });
      });
  });

  it("does not advertise merged MCP CORS for an absent route", async () => {
    const { app } = createTestApp({
      envOverrides: {
        RADIOSO_BASE_URL: "http://127.0.0.1:8080",
        RADIOSO_MCP_MERGED_CORS_ORIGINS: "https://client.example",
        RADIOSO_MCP_ENABLED: true,
      },
    });

    const response = await request(app)
      .options("/mcp")
      .set("Origin", "https://client.example")
      .expect(404);

    expect(response.headers["access-control-allow-origin"]).toBeUndefined();
    expect(response.headers["access-control-allow-methods"]).toBeUndefined();
    expect(response.headers["access-control-allow-headers"]).toBeUndefined();
    expect(response.headers["access-control-expose-headers"]).toBeUndefined();
  });

});

redisIntegration("merged MCP Redis upgrade lifecycle", () => {
  const lifecycles: object[] = [];
  const clients: Array<{ quit(): Promise<unknown> }> = [];

  afterEach(async () => {
    await Promise.all(lifecycles.splice(0).map((env) => closeMergedMcpPurgeLifecycle(env)));
    await Promise.all(clients.splice(0).map((client) => client.quit()));
  });

  it("purges legacy sessions before reporting merged health ready", async () => {
    const prefix = `merged-upgrade-${Date.now()}`;
    const client = createClient({ url: mergedRedisUrl! });
    await client.connect();
    clients.push(client);
    await client.set(`${prefix}:session:id:legacy`, JSON.stringify({
      accessTokenHash: "legacy-hash",
      sessionId: "legacy",
      upstreamApiToken: "retired",
    }));
    await client.set(`${prefix}:session:token:legacy-hash`, "legacy");
    await client.set(`${prefix}:session:id:converse`, JSON.stringify({
      accessTokenHash: "converse-hash",
      converseSessionTokenEncrypted: { authTag: "tag", ciphertext: "cipher", iv: "iv" },
      sessionId: "converse",
    }));
    await client.set(`${prefix}:session:token:converse-hash`, "converse");

    const { app, dependencies } = createTestApp({
      envOverrides: {
        RADIOSO_BASE_URL: "http://127.0.0.1:8080",
        RADIOSO_MCP_ENABLED: true,
        RADIOSO_MCP_REDIS_KEY_PREFIX: prefix,
        RADIOSO_MCP_REDIS_URL: mergedRedisUrl,
      },
    });
    lifecycles.push(dependencies.env);

    await waitForMergedHealth(app);
    expect(await client.exists(`${prefix}:session:id:legacy`)).toBe(0);
    expect(await client.exists(`${prefix}:session:token:legacy-hash`)).toBe(0);
    expect(await client.exists(`${prefix}:session:id:converse`)).toBe(1);
    expect(await client.exists(`${prefix}:session:token:converse-hash`)).toBe(1);
  }, 15_000);

  it("keeps merged health unready while the configured Redis store is unavailable", async () => {
    const { app, dependencies } = createTestApp({
      envOverrides: {
        RADIOSO_BASE_URL: "http://127.0.0.1:8080",
        RADIOSO_MCP_ENABLED: true,
        RADIOSO_MCP_REDIS_KEY_PREFIX: `merged-unavailable-${Date.now()}`,
        RADIOSO_MCP_REDIS_URL: "redis://127.0.0.1:1",
      },
    });
    lifecycles.push(dependencies.env);

    const response = await request(app).get("/health");
    expect(response.status).toBe(503);
    expect(response.body.mcp).toMatchObject({
      enabled: false,
      failed: false,
      mode: "unsupported",
      ready: false,
      reason: "merged_auth_unavailable",
      standalone: false,
    });
  }, 15_000);
});
