import { afterEach, describe, expect, it, vi } from "vitest";

import { createAuditLogger, createInMemoryAuditSink } from "../src/audit/auditLogger.js";
import { createAuthService } from "../src/auth/authService.js";
import { createInMemorySessionStore } from "../src/auth/sessionStore.js";
import { createHttpServer } from "../src/http/createHttpServer.js";
import { createCapabilityPolicyRegistry } from "../src/policy/capabilityPolicy.js";

const workspaceValidation = {
  apiVersion: "0.1.0",
  mcpContextVersion: "2026-04-22",
  supportedTools: ["describe_capabilities", "create_document"],
  workspaceHint: "Default",
  workspaceId: "3f3caef3-050c-46a7-8fd7-2fa48f17fe98",
  workspaceName: "Default",
};

const mcpRequest = async (baseUrl: string, accessToken: string, payload: unknown) =>
  fetch(`${baseUrl}/mcp`, {
    body: JSON.stringify(payload),
    headers: {
      authorization: `Bearer ${accessToken}`,
      "content-type": "application/json",
      "mcp-protocol-version": "2025-11-25",
    },
    method: "POST",
  });

const initializeMcp = async (baseUrl: string, accessToken: string) => {
  await mcpRequest(baseUrl, accessToken, {
    id: "1",
    jsonrpc: "2.0",
    method: "initialize",
    params: {
      capabilities: {},
      clientInfo: { name: "test-client", version: "1.0.0" },
      protocolVersion: "2025-11-25",
    },
  });
  await mcpRequest(baseUrl, accessToken, {
    jsonrpc: "2.0",
    method: "notifications/initialized",
    params: {},
  });
};

describe("remote MCP audit logging", () => {
  const runtimes: Array<{ server: Awaited<ReturnType<typeof createRuntime>>["server"] }> = [];

  afterEach(async () => {
    vi.restoreAllMocks();
    while (runtimes.length > 0) {
      await runtimes.pop()!.server.close();
    }
  });

  const createRuntime = async (options: {
    allowedReadTools: string[];
    allowedWriteTools: string[];
    approvalRequiredWriteTools: string[];
    validateWorkspaceToken?: () => Promise<typeof workspaceValidation>;
  }) => {
    const { events, sink } = createInMemoryAuditSink();
    const policy = createCapabilityPolicyRegistry({
      allowedReadTools: options.allowedReadTools,
      allowedWriteTools: options.allowedWriteTools,
      approvalRequiredWriteTools: options.approvalRequiredWriteTools,
    });
    const authService = createAuthService({
      auditLogger: createAuditLogger([sink]),
      policy,
      sessionStore: createInMemorySessionStore(),
      signingSecret: "dev-signing-secret",
      validateWorkspaceToken: options.validateWorkspaceToken ?? (async () => workspaceValidation),
    });
    const server = createHttpServer({
      auditLogger: createAuditLogger([sink]),
      authService,
      config: {
        accessTokenTtlSeconds: 900,
        allowedReadTools: options.allowedReadTools,
        allowedWriteTools: options.allowedWriteTools,
        approvalRequiredWriteTools: options.approvalRequiredWriteTools,
        baseUrl: "http://radioso.test",
        bindHost: "127.0.0.1",
        bindPort: 0,
        requestTimeoutMs: 30_000,
        serverName: "radioso-test",
        signingSecret: "dev-signing-secret",
      },
    });

    await server.listen();

    const address = server.server.address();
    if (!address || typeof address === "string") {
      throw new Error("Expected a TCP server address.");
    }

    return {
      baseUrl: `http://127.0.0.1:${address.port}`,
      events,
      server,
    };
  };

  it("rejects removed retrieval settings tools during token exchange", async () => {
    const runtime = await createRuntime({
      allowedReadTools: ["describe_capabilities"],
      allowedWriteTools: [],
      approvalRequiredWriteTools: [],
    });
    runtimes.push(runtime);

    const exchangeResponse = await fetch(`${runtime.baseUrl}/v1/auth/exchange`, {
      body: JSON.stringify({
        radiosoApiToken: "radioso_test",
        requestedTools: ["get_retrieval_settings", "update_retrieval_settings"],
      }),
      headers: {
        "content-type": "application/json",
      },
      method: "POST",
    });
    const exchange = await exchangeResponse.json() as {
      error: { code: string; details: { deniedTools: string[] }; message: string };
    };

    expect(exchangeResponse.status).toBe(403);
    expect(exchange.error).toMatchObject({
      code: "capability_forbidden",
      details: {
        deniedTools: ["get_retrieval_settings", "update_retrieval_settings"],
      },
    });
    expect(exchange.error.message).toMatch(/not allowed/i);

    expect(runtime.events).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          eventType: "auth.exchange_failed",
          metadata: expect.objectContaining({
            code: "capability_forbidden",
            details: {
              deniedTools: ["get_retrieval_settings", "update_retrieval_settings"],
            },
          }),
          outcome: "denied",
        }),
      ]),
    );
  });

  it("returns a clear unknown-tool error if an old client calls a removed tool", async () => {
    const runtime = await createRuntime({
      allowedReadTools: ["describe_capabilities"],
      allowedWriteTools: [],
      approvalRequiredWriteTools: [],
    });
    runtimes.push(runtime);

    const exchangeResponse = await fetch(`${runtime.baseUrl}/v1/auth/exchange`, {
      body: JSON.stringify({
        radiosoApiToken: "radioso_test",
        requestedTools: ["describe_capabilities"],
      }),
      headers: {
        "content-type": "application/json",
      },
      method: "POST",
    });
    const exchange = await exchangeResponse.json() as { accessToken: string };

    await initializeMcp(runtime.baseUrl, exchange.accessToken);
    const callResponse = await mcpRequest(runtime.baseUrl, exchange.accessToken, {
      id: "2",
      jsonrpc: "2.0",
      method: "tools/call",
      params: {
        arguments: {},
        name: "get_retrieval_settings",
      },
    });
    const call = await callResponse.json() as { error?: { code: number; message: string } };

    expect(call.error).toMatchObject({
      code: -32602,
      message: expect.stringMatching(/tool.*not.*found/i),
    });
  });

  it("emits audit evidence for malformed exchange requests", async () => {
    const runtime = await createRuntime({
      allowedReadTools: ["describe_capabilities"],
      allowedWriteTools: ["create_document"],
      approvalRequiredWriteTools: ["create_document"],
    });
    runtimes.push(runtime);

    const badExchangeResponse = await fetch(`${runtime.baseUrl}/v1/auth/exchange`, {
      body: JSON.stringify({
        requestedTools: ["describe_capabilities"],
      }),
      headers: {
        "content-type": "application/json",
      },
      method: "POST",
    });
    expect(badExchangeResponse.status).toBe(400);

    expect(runtime.events).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          eventType: "auth.exchange_failed",
          metadata: expect.objectContaining({
            code: "invalid_arguments",
          }),
          outcome: "denied",
        }),
      ]),
    );
  });
});
