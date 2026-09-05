import assert from "node:assert/strict";
import type { Server } from "node:http";
import { fileURLToPath } from "node:url";

import { createInMemoryAuditSink } from "../src/audit/auditLogger.js";
import type { RadiosoMcpConfig } from "../src/config.js";
import { createRemoteHttpRuntime } from "../src/http/runtime.js";

const MCP_PROTOCOL_VERSION = "2025-11-25";
const backendPackageDir = fileURLToPath(new URL("../../../backend", import.meta.url));

type JsonRpcPayload = Record<string, unknown>;
type TestAppModule = typeof import("../../../backend/tests/support/testApp.js");
type McpConverseRoutesModule = typeof import("../../../backend/src/app/http/routes/mcpConverseRoutes.js");
type DependencyBuildersModule = typeof import("../../../backend/src/app/server/dependencyBuilders.js");

export interface SmokeLogger {
  step(message: string): void;
}

export interface BackendHarness {
  app: unknown;
  baseUrl: string;
  close(): Promise<void>;
  issueConverseGrant(email?: string): Promise<{ agentId: string; token: string; workspaceId: string }>;
}

export interface RemoteHarness {
  auditEvents: ReturnType<typeof createInMemoryAuditSink>["events"];
  baseUrl: string;
  close(): Promise<void>;
}

export interface ConverseSmokeSummary {
  answer: string;
  agentId: string;
  workspaceId: string;
}

const closeServer = async (server: Server): Promise<void> =>
  await new Promise<void>((resolve, reject) => {
    server.close((error) => {
      if (error) {
        reject(error);
        return;
      }

      resolve();
    });
  });

const resolveBaseUrl = (server: Server): string => {
  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("Expected a TCP server address.");
  }

  return `http://127.0.0.1:${address.port}`;
};

// The MCP wire response is arbitrary third-party JSON; callers narrow the specific shape
// they expect from each call (matching the request they just made) with a local cast.
const readJson = async (response: Response): Promise<unknown> => {
  const text = await response.text();
  return text.length > 0 ? (JSON.parse(text) as unknown) : undefined;
};

const loadTestAppModule = async (): Promise<TestAppModule> => {
  const previousCwd = process.cwd();
  process.chdir(backendPackageDir);

  try {
    return await import("../../../backend/tests/support/testApp.js");
  } finally {
    process.chdir(previousCwd);
  }
};

const loadMcpConverseRoutesModule = async (): Promise<McpConverseRoutesModule> => {
  const previousCwd = process.cwd();
  process.chdir(backendPackageDir);

  try {
    return await import("../../../backend/src/app/http/routes/mcpConverseRoutes.js");
  } finally {
    process.chdir(previousCwd);
  }
};

const loadDependencyBuildersModule = async (): Promise<DependencyBuildersModule> => {
  const previousCwd = process.cwd();
  process.chdir(backendPackageDir);

  try {
    return await import("../../../backend/src/app/server/dependencyBuilders.js");
  } finally {
    process.chdir(previousCwd);
  }
};

const mcpRequest = async (baseUrl: string, accessToken: string | null, payload: JsonRpcPayload): Promise<Response> =>
  fetch(`${baseUrl}/mcp`, {
    body: JSON.stringify(payload),
    headers: {
      accept: "application/json, text/event-stream",
      ...(accessToken ? { authorization: `Bearer ${accessToken}` } : {}),
      "content-type": "application/json",
      "mcp-protocol-version": MCP_PROTOCOL_VERSION,
    },
    method: "POST",
  });

const getStructuredContent = (payload: unknown): unknown => {
  const result = (payload as { result?: { content?: Array<{ text?: unknown }>; structuredContent?: unknown } } | undefined)
    ?.result;

  return result?.structuredContent ??
    (() => {
      const text = result?.content?.[0]?.text;
      if (typeof text !== "string") {
        return undefined;
      }

      const boundary = text.indexOf("\n\n");
      if (boundary === -1) {
        return undefined;
      }

      return JSON.parse(text.slice(boundary + 2)) as unknown;
    })();
};

// `ask_agent`'s structuredContent always carries this shape; call sites that invoke it
// specifically (rather than a generic tool) narrow to it here.
const asAskAgentAnswer = (structuredContent: unknown): { answer: { text: string } } =>
  structuredContent as { answer: { text: string } };

export const startBackendHarness = async (): Promise<BackendHarness> => {
  const { createTestApp, issueTestSession } = await loadTestAppModule();
  const { createMcpConverseRoutes } = await loadMcpConverseRoutesModule();
  const { buildMcpConverseServices } = await loadDependencyBuildersModule();
  const { app, dependencies } = createTestApp({
    applicationRouteMounts: [{
      path: "/api/v1/mcp/converse",
      createRouter: (routeDependencies) =>
        createMcpConverseRoutes(routeDependencies, buildMcpConverseServices(routeDependencies)),
    }],
  });
  const server = await new Promise<Server>((resolve, reject) => {
    const instance = app.listen(0, "127.0.0.1", () => resolve(instance));
    instance.once("error", reject);
  });

  return {
    app,
    baseUrl: resolveBaseUrl(server),
    async close() {
      await closeServer(server);
    },
    async issueConverseGrant(email?: string) {
      const session = await issueTestSession(app, email);
      const agent = await dependencies.agentService.resolve(session.workspaceId);
      const { token } = await dependencies.accessGrantService.issueGrant({
        agentId: agent.id,
        workspaceId: session.workspaceId,
        principalKind: "agent-api",
        channel: "mcp-converse",
        originConstraint: { mode: "allow-all", origins: [] },
        expiresAt: new Date(Date.now() + 60 * 60 * 1000),
      });
      return { agentId: agent.id, token, workspaceId: session.workspaceId };
    },
  };
};

export const startRemoteHarness = async (options: {
  backendBaseUrl: string;
  redisKeyPrefix?: string;
  redisUrl?: string;
  serverName?: string;
}): Promise<RemoteHarness> => {
  const audit = createInMemoryAuditSink();
  const config: RadiosoMcpConfig = {
    baseUrl: options.backendBaseUrl,
    bindHost: "127.0.0.1",
    bindPort: 0,
    redisKeyPrefix: options.redisKeyPrefix ?? `radioso-mcp-smoke-${Math.random().toString(36).slice(2, 10)}`,
    redisUrl: options.redisUrl,
    requestTimeoutMs: 30_000,
    serverName: options.serverName ?? "radioso-smoke",
    signingSecret: "smoke-signing-secret",
    trustedProxyHops: 0,
  };
  const runtime = await createRemoteHttpRuntime({
    auditSinks: [audit.sink],
    config,
  });
  await runtime.listen();

  return {
    auditEvents: audit.events,
    baseUrl: resolveBaseUrl(runtime.server.server),
    async close() {
      await runtime.close();
    },
  };
};

export const initializeSession = async (baseUrl: string, accessToken: string) => {
  const initializeResponse = await mcpRequest(baseUrl, accessToken, {
    id: "initialize-1",
    jsonrpc: "2.0",
    method: "initialize",
    params: {
      capabilities: {},
      clientInfo: { name: "smoke-client", version: "1.0.0" },
      protocolVersion: MCP_PROTOCOL_VERSION,
    },
  });
  const initializePayload = (await readJson(initializeResponse)) as
    | { result?: { protocolVersion?: string } }
    | undefined;
  assert.ok(initializeResponse.ok, `Expected initialize to succeed, got ${initializeResponse.status}`);
  assert.equal(initializePayload?.result?.protocolVersion, MCP_PROTOCOL_VERSION);
  assert.equal(initializeResponse.headers.get("mcp-session-id"), null, "Expected standalone MCP to use stateless HTTP transport.");

  const initializedResponse = await mcpRequest(baseUrl, accessToken, {
    jsonrpc: "2.0",
    method: "notifications/initialized",
    params: {},
  });
  assert.ok(initializedResponse.ok, `Expected initialized notification to succeed, got ${initializedResponse.status}`);
};

export const listTools = async (baseUrl: string, accessToken: string) => {
  const response = await mcpRequest(baseUrl, accessToken, {
    id: "tools-list-1",
    jsonrpc: "2.0",
    method: "tools/list",
    params: {},
  });
  const payload = await readJson(response);
  assert.equal(response.status, 200, `Expected tools/list to succeed, got ${response.status}: ${JSON.stringify(payload)}`);
  return payload as { result: { tools: Array<{ name: string }> } };
};

export const callTool = async (
  baseUrl: string,
  accessToken: string,
  name: string,
  args: Record<string, unknown>,
  requestId = `${name}-${Math.random().toString(36).slice(2, 10)}`,
) => {
  const response = await mcpRequest(baseUrl, accessToken, {
    id: requestId,
    jsonrpc: "2.0",
    method: "tools/call",
    params: {
      arguments: args,
      name,
    },
  });
  const payload = await readJson(response);
  return {
    payload,
    response,
    structuredContent: getStructuredContent(payload),
  };
};

export const runConverseGrantSmoke = async (logger: SmokeLogger): Promise<ConverseSmokeSummary> => {
  const backend = await startBackendHarness();
  const remote = await startRemoteHarness({ backendBaseUrl: backend.baseUrl });

  try {
    logger.step("issuing MCP converse grant");
    const grant = await backend.issueConverseGrant("mcp-converse-smoke@example.com");

    logger.step("initializing MCP session directly with converse grant bearer");
    await initializeSession(remote.baseUrl, grant.token);

    logger.step("listing converse-only tools");
    const tools = await listTools(remote.baseUrl, grant.token);
    assert.deepEqual(
      tools.result.tools.map((tool) => tool.name).sort(),
      ["ask_agent"],
    );
    assert.ok(!tools.result.tools.some((tool) => tool.name === "describe_capabilities"));
    assert.ok(!tools.result.tools.some((tool) => tool.name === "list_documents"));
    assert.ok(!tools.result.tools.some((tool) => tool.name === "get_document"));
    assert.ok(!tools.result.tools.some((tool) => tool.name === "create_document"));

    logger.step("calling ask_agent with the converse grant bearer");
    const ask = await callTool(remote.baseUrl, grant.token, "ask_agent", {
      message: "Hello from the MCP converse smoke test.",
    });
    assert.equal(ask.response.status, 200);
    const askAnswer = asAskAgentAnswer(ask.structuredContent).answer;
    assert.equal(typeof askAnswer.text, "string");
    assert.ok(askAnswer.text.length > 0);

    logger.step("confirming no direct agent resources are exposed");
    const resourcesResponse = await mcpRequest(remote.baseUrl, grant.token, {
      id: "resources-list-1",
      jsonrpc: "2.0",
      method: "resources/list",
      params: {},
    });
    const resourcesPayload = (await readJson(resourcesResponse)) as
      | { error?: unknown; result?: { resources?: unknown } }
      | undefined;
    assert.equal(resourcesResponse.status, 200, `Expected resources/list to return an empty catalogue, got ${resourcesResponse.status}: ${JSON.stringify(resourcesPayload)}`);
    assert.equal(resourcesPayload?.result?.resources, undefined);
    assert.ok(resourcesPayload?.error, "Expected resources/list to be unavailable for an agent chat credential");

    return {
      answer: askAnswer.text,
      agentId: grant.agentId,
      workspaceId: grant.workspaceId,
    };
  } finally {
    await remote.close();
    await backend.close();
  }
};

export const runSharedStoreConverseSmoke = async (
  redisUrl: string,
  logger: SmokeLogger,
): Promise<ConverseSmokeSummary> => {
  const backend = await startBackendHarness();
  const redisKeyPrefix = `radioso-mcp-shared-smoke-${Math.random().toString(36).slice(2, 10)}`;
  const runtimeA = await startRemoteHarness({
    backendBaseUrl: backend.baseUrl,
    redisKeyPrefix,
    redisUrl,
    serverName: "radioso-smoke-a",
  });
  const runtimeB = await startRemoteHarness({
    backendBaseUrl: backend.baseUrl,
    redisKeyPrefix,
    redisUrl,
    serverName: "radioso-smoke-b",
  });

  try {
    logger.step("issuing an agent MCP credential for the shared store");
    const grant = await backend.issueConverseGrant("mcp-converse-redis-smoke@example.com");

    logger.step("using the credential through both shared-store nodes");
    await initializeSession(runtimeA.baseUrl, grant.token);
    await initializeSession(runtimeB.baseUrl, grant.token);
    const ask = await callTool(runtimeB.baseUrl, grant.token, "ask_agent", {
      message: "Hello from the Redis MCP smoke test.",
    });
    assert.equal(ask.response.status, 200);
    const askAnswer = asAskAgentAnswer(ask.structuredContent).answer;
    assert.equal(typeof askAnswer.text, "string");

    return {
      agentId: grant.agentId,
      answer: askAnswer.text,
      workspaceId: grant.workspaceId,
    };
  } finally {
    await runtimeB.close();
    await runtimeA.close();
    await backend.close();
  }
};
