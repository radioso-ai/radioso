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

const mcpRequest = (body: Record<string, unknown>): Request => new Request("http://radioso.test/mcp", {
  body: JSON.stringify(body),
  headers: {
    accept: "application/json, text/event-stream",
    "content-type": "application/json",
    "mcp-protocol-version": "2025-06-18",
  },
  method: "POST",
});

const postMcpRequest = async (
  manager: Manager,
  body: Record<string, unknown>,
  session: AccessSessionRecord,
): Promise<Record<string, unknown>> => {
  const response = await manager.handleRequest(session, mcpRequest(body), {
    authInfo: toInternalAuthInfo(session, `access-${session.sessionId}`),
  });

  expect(response.status).toBe(200);
  return response.json() as Promise<Record<string, unknown>>;
};

const initialize = (manager: Manager, session: AccessSessionRecord) => postMcpRequest(manager, {
  id: "initialize",
  jsonrpc: "2.0",
  method: "initialize",
  params: { capabilities: {}, clientInfo: { name: "test-client", version: "1.0.0" }, protocolVersion: "2025-06-18" },
}, session);

const listToolNames = async (manager: Manager, session: AccessSessionRecord): Promise<string[]> => {
  const payload = await postMcpRequest(manager, { id: "tools-list", jsonrpc: "2.0", method: "tools/list", params: {} }, session);
  return (payload.result as { tools: Array<{ name: string }> }).tools.map((tool) => tool.name);
};

const callTool = (manager: Manager, session: AccessSessionRecord, name: string, args: Record<string, unknown>, id: string | number = `call-${name}`) =>
  postMcpRequest(manager, { id, jsonrpc: "2.0", method: "tools/call", params: { arguments: args, name } }, session);

const converseReply = (text: string) => new Response(JSON.stringify({
  answer: { text, citations: [] },
  answerCoverage: { availability: "not_recorded", originatingTurnId: "t", originatingRequestId: "t" },
  conversationId: "backend-conversation",
  ownership: { state: "ai_owned", suppressed: false },
  routine: { toolName: "start_return", name: "Start a return", status: "waiting_for_input", pendingInput: [] },
  invocation: { toolName: "start_return", outcome: "started" },
}), { headers: { "content-type": "application/json" }, status: 200 });

describe("session MCP server manager catalogs", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("serves each session the tools its pinned catalog names, after the static ones", async () => {
    const manager = createSessionMcpServerManager({ config });
    const withReturn = makeSession("a", catalogOf([startReturn]));
    const withCallback = makeSession("c", catalogOf([requestCallback]));

    await initialize(manager, withReturn);
    await initialize(manager, withCallback);
    expect(await listToolNames(manager, withReturn)).toEqual(["ask_agent", "radioso_docs", "radioso_doc_page", "start_return"]);
    expect(await listToolNames(manager, withCallback)).toEqual(["ask_agent", "radioso_docs", "radioso_doc_page", "request_callback"]);
  });

  it("serves the static catalog to a session record without a catalog and to one with an empty catalog", async () => {
    const manager = createSessionMcpServerManager({ config });
    const legacy = makeSession("legacy");
    const empty = makeSession("empty", catalogOf([]));

    expect(await listToolNames(manager, legacy)).toEqual(["ask_agent", "radioso_docs", "radioso_doc_page"]);
    expect(await listToolNames(manager, empty)).toEqual(["ask_agent", "radioso_docs", "radioso_doc_page"]);
  });

  it("answers a request without a prior initialize on the same connection, since every request gets its own", async () => {
    const manager = createSessionMcpServerManager({ config });
    const session = makeSession("a", catalogOf([startReturn]));

    expect(await listToolNames(manager, session)).toContain("start_return");
  });

  it("advertises the descriptor schema and forwards a routine call as a routine invocation", async () => {
    const { events, sink } = createInMemoryAuditSink();
    const fetchMock = vi.fn().mockImplementation(async () => converseReply("Got it — order A-1001."));
    vi.stubGlobal("fetch", fetchMock);
    const manager = createSessionMcpServerManager({ auditLogger: createAuditLogger([sink]), config });
    const session = makeSession("a", catalogOf([startReturn]));

    const listed = await postMcpRequest(manager, { id: "tools-list", jsonrpc: "2.0", method: "tools/list", params: {} }, session);
    const tool = (listed.result as { tools: Array<{ name: string; description: string; inputSchema: unknown }> }).tools
      .find((entry) => entry.name === "start_return");
    expect(tool).toMatchObject({ description: startReturn.description, inputSchema: startReturn.inputSchema });

    const called = await callTool(manager, session, "start_return", { orderId: "A-1001" });
    const result = called.result as { structuredContent: { routine: { status: string } }; content: Array<{ type: string; text: string }> };
    expect(result.structuredContent.routine.status).toBe("waiting_for_input");
    // The text content carries the answer and the envelope, for a client that only reads text.
    expect(result.content[0].text.startsWith("Got it — order A-1001.\n\n{")).toBe(true);
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

  it("rejects input that does not match the descriptor before calling the backend, and audits the refusal by tool name only", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const { events, sink } = createInMemoryAuditSink();
    const manager = createSessionMcpServerManager({ auditLogger: createAuditLogger([sink]), config });
    const session = makeSession("a", catalogOf([startReturn]));

    const rejected = await callTool(manager, session, "start_return", { reason: "no order id, and a secret: 4111" });

    expect((rejected.result as { isError?: boolean }).isError).toBe(true);
    expect(fetchMock).not.toHaveBeenCalled();
    const denied = events.filter((event) => event.eventType === "tool.denied");
    expect(denied).toHaveLength(1);
    expect(denied[0]).toMatchObject({
      outcome: "denied",
      toolName: "start_return",
      sessionId: "a",
      metadata: { code: "invalid_arguments", conversationId: "conversation-a" },
    });
    expect(JSON.stringify(events)).not.toContain("4111");
  });

  it("answers two concurrent requests that reuse one JSON-RPC id on the same catalog each with its own reply", async () => {
    // The first ask is held at the backend until the second has been answered, so a second
    // request with the same id arrives while the first is still in flight.
    let releaseFirst: () => void = () => undefined;
    const firstReleased = new Promise<void>((resolve) => { releaseFirst = resolve; });
    let firstSeen: () => void = () => undefined;
    const firstInFlight = new Promise<void>((resolve) => { firstSeen = resolve; });
    const fetchMock = vi.fn().mockImplementation(async (_url: string, init: RequestInit) => {
      const { message } = JSON.parse(init.body as string) as { message: string };
      if (message === "first") {
        firstSeen();
        await firstReleased;
        return converseReply("reply to first");
      }
      return converseReply("reply to second");
    });
    vi.stubGlobal("fetch", fetchMock);
    const manager = createSessionMcpServerManager({ config });
    const clientA = makeSession("a", catalogOf([startReturn]));
    const clientB = makeSession("b", catalogOf([startReturn]));

    const first = callTool(manager, clientA, "ask_agent", { message: "first" }, 1);
    await firstInFlight;
    const secondReply = await callTool(manager, clientB, "ask_agent", { message: "second" }, 1);
    releaseFirst();
    const firstReply = await first;

    expect(firstReply.id).toBe(1);
    expect(secondReply.id).toBe(1);
    expect((firstReply.result as { structuredContent: { answer: { text: string } } }).structuredContent.answer.text).toBe("reply to first");
    expect((secondReply.result as { structuredContent: { answer: { text: string } } }).structuredContent.answer.text).toBe("reply to second");
  });
});
