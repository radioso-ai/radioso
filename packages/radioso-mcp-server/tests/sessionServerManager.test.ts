import { afterEach, describe, expect, it, vi } from "vitest";

import { createAuditLogger, createInMemoryAuditSink } from "../src/audit/auditLogger.js";
import type { AccessSessionRecord, SessionToolCatalog } from "../src/auth/sessionStore.js";
import { toToolCatalogKey } from "../src/auth/toolCatalogKey.js";
import type { AgentToolDescriptor } from "../src/converseApiAdapter.js";
import { createSessionMcpServerManager, toInternalAuthInfo } from "../src/http/sessionServerManager.js";

const config = {
  baseUrl: "http://radioso.test",
  bindHost: "127.0.0.1",
  bindPort: 8787,
  redisKeyPrefix: "radioso-mcp-test",
  requestTimeoutMs: 1_000,
  serverName: "radioso-mcp-test",
  trustedProxyHops: 0,
};

const startReturn: AgentToolDescriptor = {
  toolName: "start_return",
  description: "Start a return for an order.",
  inputSchema: {
    type: "object",
    properties: { orderId: { type: "string", description: "The order number" }, reason: { type: "string" } },
    required: ["orderId"],
    additionalProperties: false,
  },
  routineLineageId: "lineage-start-return",
};

const requestCallback: AgentToolDescriptor = {
  toolName: "request_callback",
  description: "Ask for a callback.",
  inputSchema: { type: "object", properties: {}, required: [], additionalProperties: false },
  routineLineageId: "lineage-request-callback",
};

const catalogOf = (tools: AgentToolDescriptor[]): SessionToolCatalog => ({ key: toToolCatalogKey(tools), tools });

const makeSession = (sessionId: string, toolCatalog?: SessionToolCatalog): AccessSessionRecord => ({
  accessTokenHash: `hash-${sessionId}`,
  conversationId: `conversation-${sessionId}`,
  converseSessionToken: `converse-${sessionId}`,
  expiresAt: new Date("2030-01-01T00:00:00.000Z"),
  issuedAt: new Date("2029-01-01T00:00:00.000Z"),
  sessionId,
  toolCatalog,
});

type Manager = ReturnType<typeof createSessionMcpServerManager>;
type Handle = Awaited<ReturnType<Manager["getOrCreate"]>>;

const postMcpRequest = async (
  handle: Handle,
  body: Record<string, unknown>,
  session: AccessSessionRecord,
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
    { authInfo: toInternalAuthInfo(session, `access-${session.sessionId}`) },
  );

  expect(response.status).toBe(200);
  return response.json() as Promise<Record<string, unknown>>;
};

const initialize = (handle: Handle, session: AccessSessionRecord) => postMcpRequest(handle, {
  id: "initialize",
  jsonrpc: "2.0",
  method: "initialize",
  params: { capabilities: {}, clientInfo: { name: "test-client", version: "1.0.0" }, protocolVersion: "2025-06-18" },
}, session);

const listToolNames = async (handle: Handle, session: AccessSessionRecord): Promise<string[]> => {
  const payload = await postMcpRequest(handle, { id: "tools-list", jsonrpc: "2.0", method: "tools/list", params: {} }, session);
  return (payload.result as { tools: Array<{ name: string }> }).tools.map((tool) => tool.name);
};

const callTool = (handle: Handle, session: AccessSessionRecord, name: string, args: Record<string, unknown>) =>
  postMcpRequest(handle, { id: `call-${name}`, jsonrpc: "2.0", method: "tools/call", params: { arguments: args, name } }, session);

describe("session MCP server manager catalogs", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("gives sessions with different catalogs different servers and shares one between identical catalogs", async () => {
    const manager = createSessionMcpServerManager({ config });
    const withReturn = makeSession("a", catalogOf([startReturn]));
    const withReturnToo = makeSession("b", catalogOf([startReturn]));
    const withCallback = makeSession("c", catalogOf([requestCallback]));

    const first = await manager.getOrCreate(withReturn);
    const second = await manager.getOrCreate(withReturnToo);
    const third = await manager.getOrCreate(withCallback);

    expect(second).toBe(first);
    expect(third).not.toBe(first);
    expect(first.toolCatalogKey).toBe(withReturn.toolCatalog?.key);
    expect(third.toolCatalogKey).toBe(withCallback.toolCatalog?.key);

    await initialize(first, withReturn);
    await initialize(third, withCallback);
    expect(await listToolNames(first, withReturn)).toEqual(["ask_agent", "radioso_docs", "radioso_doc_page", "start_return"]);
    expect(await listToolNames(third, withCallback)).toEqual(["ask_agent", "radioso_docs", "radioso_doc_page", "request_callback"]);
  });

  it("serves the static catalog to a session record without a catalog and shares it with an empty one", async () => {
    const manager = createSessionMcpServerManager({ config });
    const legacy = makeSession("legacy");
    const empty = makeSession("empty", catalogOf([]));

    const legacyHandle = await manager.getOrCreate(legacy);
    const emptyHandle = await manager.getOrCreate(empty);

    expect(emptyHandle).toBe(legacyHandle);
    await initialize(legacyHandle, legacy);
    expect(await listToolNames(legacyHandle, legacy)).toEqual(["ask_agent", "radioso_docs", "radioso_doc_page"]);
  });

  it("advertises the descriptor schema and forwards a routine call as a routine invocation", async () => {
    const { events, sink } = createInMemoryAuditSink();
    const fetchMock = vi.fn().mockImplementation(async () => new Response(JSON.stringify({
      answer: { text: "Got it — order A-1001.", citations: [] },
      answerCoverage: { availability: "not_recorded", originatingTurnId: "t", originatingRequestId: "t" },
      conversationId: "backend-conversation",
      ownership: { state: "ai_owned", suppressed: false },
      routine: { toolName: "start_return", name: "Start a return", status: "waiting_for_input", pendingInput: [] },
    }), { headers: { "content-type": "application/json" }, status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    const manager = createSessionMcpServerManager({ auditLogger: createAuditLogger([sink]), config });
    const session = makeSession("a", catalogOf([startReturn]));
    const handle = await manager.getOrCreate(session);
    await initialize(handle, session);

    const listed = await postMcpRequest(handle, { id: "tools-list", jsonrpc: "2.0", method: "tools/list", params: {} }, session);
    const tool = (listed.result as { tools: Array<{ name: string; description: string; inputSchema: unknown }> }).tools
      .find((entry) => entry.name === "start_return");
    expect(tool).toMatchObject({ description: startReturn.description, inputSchema: startReturn.inputSchema });

    const called = await callTool(handle, session, "start_return", { orderId: "A-1001" });
    expect((called.result as { structuredContent: { routine: { status: string } } }).structuredContent.routine.status)
      .toBe("waiting_for_input");
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("http://radioso.test/api/v1/mcp/converse/ask");
    expect(JSON.parse(init.body as string)).toEqual({ routine: { toolName: "start_return", input: { orderId: "A-1001" } } });
    expect((init.headers as Record<string, string>).authorization).toBe("Bearer converse-a");

    const executed = events.filter((event) => event.eventType === "tool.executed");
    expect(executed).toHaveLength(1);
    expect(executed[0]).toMatchObject({ toolName: "start_return", sessionId: "a", metadata: { conversationId: "conversation-a" } });
    expect(JSON.stringify(executed[0])).not.toContain("A-1001");
  });

  it("rejects input that does not match the descriptor before calling the backend", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const manager = createSessionMcpServerManager({ config });
    const session = makeSession("a", catalogOf([startReturn]));
    const handle = await manager.getOrCreate(session);
    await initialize(handle, session);

    const rejected = await callTool(handle, session, "start_return", { reason: "no order id" });

    expect(rejected.error ?? (rejected.result as { isError?: boolean }).isError).toBeTruthy();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("evicts the least recently used server past the cap and rebuilds it on demand", async () => {
    const manager = createSessionMcpServerManager({ config, serverCache: { maxEntries: 2 } });
    const a = makeSession("a", catalogOf([startReturn]));
    const b = makeSession("b", catalogOf([requestCallback]));
    const c = makeSession("c", catalogOf([startReturn, requestCallback]));

    const handleA = await manager.getOrCreate(a);
    await manager.getOrCreate(b);
    await manager.getOrCreate(a);
    await manager.getOrCreate(c);

    expect(await manager.getOrCreate(a)).toBe(handleA);
    const rebuiltB = await manager.getOrCreate(b);
    expect(rebuiltB.toolCatalogKey).toBe(b.toolCatalog?.key);
    await initialize(rebuiltB, b);
    expect(await listToolNames(rebuiltB, b)).toEqual(["ask_agent", "radioso_docs", "radioso_doc_page", "request_callback"]);
  });

  it("drops a server nobody has used within the idle window", async () => {
    let now = 1_000;
    const manager = createSessionMcpServerManager({ config, serverCache: { idleTtlMs: 60_000, now: () => now } });
    const session = makeSession("a", catalogOf([startReturn]));

    const first = await manager.getOrCreate(session);
    now += 59_000;
    expect(await manager.getOrCreate(session)).toBe(first);
    now += 60_001;
    expect(await manager.getOrCreate(session)).not.toBe(first);
  });

  it("builds one server when concurrent first requests share a catalog", async () => {
    const manager = createSessionMcpServerManager({ config });
    const session = makeSession("a", catalogOf([startReturn]));

    const handles = await Promise.all([manager.getOrCreate(session), manager.getOrCreate(session), manager.getOrCreate(session)]);

    expect(new Set(handles).size).toBe(1);
  });
});
