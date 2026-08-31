import { describe, expect, it } from "vitest";

import { createInMemorySessionStore } from "../src/auth/sessionStore.js";

describe("in-memory MCP session-store legacy purge", () => {
  it("removes API-token-backed sessions and preserves converse sessions", async () => {
    const store = createInMemorySessionStore();

    await store.save({
      accessToken: "mcp_sess_legacy",
      expiresAt: new Date("2999-01-01T00:00:00.000Z"),
      grantedTools: ["search_documents"],
      issuedAt: new Date("2026-08-31T00:00:00.000Z"),
      sessionId: "legacy-session",
      upstreamApiToken: "radioso_legacy",
    });
    await store.save({
      accessToken: "mcp_sess_converse",
      converseSessionToken: "converse-session",
      expiresAt: new Date("2999-01-01T00:00:00.000Z"),
      grantedTools: ["ask_agent"],
      issuedAt: new Date("2026-08-31T00:00:00.000Z"),
      sessionId: "converse-session",
    });

    await expect(store.purgeLegacyApiTokenSessions()).resolves.toEqual({ purgedSessionCount: 1 });
    await expect(store.getByAccessToken("mcp_sess_legacy")).resolves.toBeNull();
    await expect(store.getByAccessToken("mcp_sess_converse")).resolves.toMatchObject({
      sessionId: "converse-session",
    });
  });

  it("is idempotent", async () => {
    const store = createInMemorySessionStore();
    await store.save({
      accessToken: "mcp_sess_legacy",
      expiresAt: new Date("2999-01-01T00:00:00.000Z"),
      grantedTools: ["search_documents"],
      issuedAt: new Date("2026-08-31T00:00:00.000Z"),
      sessionId: "legacy-session",
      upstreamApiToken: "radioso_legacy",
    });

    await expect(store.purgeLegacyApiTokenSessions()).resolves.toEqual({ purgedSessionCount: 1 });
    await expect(store.purgeLegacyApiTokenSessions()).resolves.toEqual({ purgedSessionCount: 0 });
  });
});
