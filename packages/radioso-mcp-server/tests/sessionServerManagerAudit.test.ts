import { describe, expect, it, vi } from "vitest";

import { createAuditLogger, createInMemoryAuditSink } from "../src/audit/auditLogger.js";
import { createSessionMcpServerManager, toInternalAuthInfo } from "../src/http/sessionServerManager.js";
import type { AccessSessionRecord } from "../src/auth/sessionStore.js";

const config = {
  baseUrl: "http://radioso.test",
  bindHost: "127.0.0.1",
  bindPort: 8787,
  redisKeyPrefix: "radioso-mcp-test",
  requestTimeoutMs: 1_000,
  serverName: "radioso-mcp-test",
  trustedProxyHops: 0,
};

const makeSession = (sessionId: string, conversationId: string): AccessSessionRecord => ({
  accessTokenHash: `hash-${sessionId}`,
  conversationId,
  converseSessionToken: `converse-${sessionId}`,
  expiresAt: new Date("2030-01-01T00:00:00.000Z"),
  issuedAt: new Date("2029-01-01T00:00:00.000Z"),
  sessionId,
});

const postMcpRequest = async (
  handle: Awaited<ReturnType<ReturnType<typeof createSessionMcpServerManager>["getOrCreate"]>>,
  body: Record<string, unknown>,
  session: AccessSessionRecord,
  accessToken: string,
): Promise<Record<string, unknown>> => {
  const response = await handle.transport.handleRequest(
    new Request("http://radioso.test/mcp", {
      body: JSON.stringify(body),
      headers: {
        accept: "application/json, text/event-stream",
        "content-type": "application/json",
        "mcp-protocol-version": "2025-06-18",
      },
      method: "POST",
    }),
    { authInfo: toInternalAuthInfo(session, accessToken) },
  );

  expect(response.status).toBe(200);
  return response.json() as Promise<Record<string, unknown>>;
};

describe("session MCP server audit correlation", () => {
  it("uses each request's conversation when the ask_agent server is cached", async () => {
    const firstSession = makeSession("session-first", "conversation-first");
    const secondSession = makeSession("session-second", "conversation-second");
    const { events, sink } = createInMemoryAuditSink();
    const fetchMock = vi.fn().mockImplementation(async () => new Response(JSON.stringify({
      answer: { text: "Answer" },
      conversationId: "backend-conversation",
    }), {
      headers: { "content-type": "application/json" },
      status: 200,
    }));
    vi.stubGlobal("fetch", fetchMock);

    try {
      const manager = createSessionMcpServerManager({
        auditLogger: createAuditLogger([sink]),
        config,
      });
      const firstHandle = await manager.getOrCreate(firstSession);
      const secondHandle = await manager.getOrCreate(secondSession);

      expect(secondHandle).toBe(firstHandle);

      await postMcpRequest(firstHandle, {
        id: "initialize",
        jsonrpc: "2.0",
        method: "initialize",
        params: {
          capabilities: {},
          clientInfo: { name: "test-client", version: "1.0.0" },
          protocolVersion: "2025-06-18",
        },
      }, firstSession, "access-first");
      await postMcpRequest(firstHandle, {
        id: "ask-first",
        jsonrpc: "2.0",
        method: "tools/call",
        params: { arguments: { message: "first" }, name: "ask_agent" },
      }, firstSession, "access-first");
      await postMcpRequest(secondHandle, {
        id: "ask-second",
        jsonrpc: "2.0",
        method: "tools/call",
        params: { arguments: { message: "second" }, name: "ask_agent" },
      }, secondSession, "access-second");

      const executed = events.filter((event) => event.eventType === "tool.executed");
      expect(executed).toHaveLength(2);
      expect(executed.map((event) => event.metadata?.conversationId)).toEqual([
        "conversation-first",
        "conversation-second",
      ]);
      expect(fetchMock).toHaveBeenCalledTimes(2);
    } finally {
      vi.unstubAllGlobals();
    }
  });
});
