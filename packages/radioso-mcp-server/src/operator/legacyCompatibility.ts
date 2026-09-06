import { OPERATOR_MCP_PROTOCOL_VERSION } from "@radioso/operator-mcp-contract";

const LEGACY_PROTOCOL_VERSION = "2025-06-18";
const LEGACY_METHODS = new Set(["ping", "tools/list", "tools/call"]);

type OperatorHandler = (request: Request) => Promise<Response>;

const asRecord = (value: unknown): Record<string, unknown> | null =>
  value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;

const requestId = (value: unknown): string | number | null =>
  typeof value === "string" || (typeof value === "number" && Number.isFinite(value)) ? value : null;

const hasBearerToken = (request: Request): boolean => /^Bearer [^\s]+$/u.test(request.headers.get("authorization") ?? "");

const rpcError = (id: string | number | null, code: number, message: string, status = 400): Response =>
  Response.json({ error: { code, message }, id, jsonrpc: "2.0" }, { status });

const initializeResponse = (id: string | number): Response => Response.json({
  id,
  jsonrpc: "2.0",
  result: {
    capabilities: { tools: {} },
    protocolVersion: LEGACY_PROTOCOL_VERSION,
    serverInfo: { name: "radioso-operator-mcp", version: "0.1.0" },
  },
});

const modernRequest = (
  request: Request,
  body: Record<string, unknown>,
  method: string,
  name?: string,
): Request => {
  const headers = new Headers(request.headers);
  headers.set("mcp-method", method);
  headers.set("mcp-protocol-version", OPERATOR_MCP_PROTOCOL_VERSION);
  if (name) headers.set("mcp-name", name);
  return new Request(request.url, {
    body: JSON.stringify(body),
    headers,
    method: "POST",
  });
};

const standardTool = (value: unknown): Record<string, unknown> | null => {
  const tool = asRecord(value);
  if (!tool || typeof tool.name !== "string" || typeof tool.description !== "string" || !asRecord(tool.inputSchema)) return null;
  return {
    name: tool.name,
    description: tool.description,
    inputSchema: tool.inputSchema,
    ...(asRecord(tool.outputSchema) ? { outputSchema: tool.outputSchema } : {}),
  };
};

const translateResponse = async (
  response: Response,
  method: string,
  id: string | number,
): Promise<Response> => {
  if (!response.ok) return response;
  const payload = asRecord(await response.json());
  const result = asRecord(payload?.result);
  if (!payload || !result) return rpcError(id, -32603, "Internal error", 500);

  if (method === "ping") return Response.json({ id, jsonrpc: "2.0", result: {} });
  if (method === "tools/list") {
    if (!Array.isArray(result.tools)) return rpcError(id, -32603, "Internal error", 500);
    const tools = result.tools.map(standardTool);
    if (tools.some((tool) => tool === null)) return rpcError(id, -32603, "Internal error", 500);
    return Response.json({ id, jsonrpc: "2.0", result: { tools } });
  }

  return Response.json({
    id,
    jsonrpc: "2.0",
    result: {
      content: Array.isArray(result.content) ? result.content : [],
      ...(asRecord(result.structuredContent) ? { structuredContent: result.structuredContent } : {}),
      ...(typeof result.isError === "boolean" ? { isError: result.isError } : {}),
    },
  });
};

/**
 * Adapts the established stateless 2025 MCP lifecycle to the operator server's
 * self-describing 2026 envelope. Authorization, admission, rate limits, and
 * backend proof verification still run through the one modern handler.
 */
export const withLegacyOperatorMcpCompatibility = (modernHandler: OperatorHandler): OperatorHandler =>
  async (request) => {
    if (request.method !== "POST" || request.headers.has("mcp-method") || !hasBearerToken(request)) {
      return modernHandler(request);
    }

    let parsed: unknown;
    try { parsed = JSON.parse(await request.clone().text()); } catch {
      return request.headers.get("mcp-protocol-version") === LEGACY_PROTOCOL_VERSION
        ? rpcError(null, -32700, "Parse error")
        : modernHandler(request);
    }
    const envelope = asRecord(parsed);
    const method = typeof envelope?.method === "string" ? envelope.method : null;
    const id = requestId(envelope?.id);

    if (method === "initialize") {
      const params = asRecord(envelope?.params);
      if (id === null || typeof params?.protocolVersion !== "string") return rpcError(id, -32602, "Invalid params");
      const credentialCheck = await modernHandler(modernRequest(request, {
        id,
        jsonrpc: "2.0",
        method: "ping",
        params: {
          _meta: {
            "io.modelcontextprotocol/clientCapabilities": asRecord(params.capabilities) ?? {},
            "io.modelcontextprotocol/clientInfo": asRecord(params.clientInfo) ?? {
              name: "legacy-mcp-client",
              version: LEGACY_PROTOCOL_VERSION,
            },
            "io.modelcontextprotocol/protocolVersion": OPERATOR_MCP_PROTOCOL_VERSION,
          },
        },
      }, "ping"));
      if (!credentialCheck.ok) return credentialCheck;
      return initializeResponse(id);
    }
    if (method === "notifications/initialized") {
      return new Response(null, { status: 202 });
    }
    if (!method || !LEGACY_METHODS.has(method) || id === null) return modernHandler(request);
    if (request.headers.get("mcp-protocol-version") !== LEGACY_PROTOCOL_VERSION) {
      return rpcError(id, -32602, "Unsupported protocol version");
    }

    const params = asRecord(envelope?.params) ?? {};
    const legacyMeta = asRecord(params._meta) ?? {};
    const operationId = legacyMeta["io.radioso/operationId"];
    const normalizedParams = {
      ...params,
      ...(method === "tools/call" && typeof operationId === "string" ? { operationId } : {}),
      _meta: {
        ...legacyMeta,
        "io.modelcontextprotocol/clientCapabilities": {},
        "io.modelcontextprotocol/clientInfo": { name: "legacy-mcp-client", version: LEGACY_PROTOCOL_VERSION },
        "io.modelcontextprotocol/protocolVersion": OPERATOR_MCP_PROTOCOL_VERSION,
      },
    };
    const normalizedRequest = modernRequest(
      request,
      { id, jsonrpc: "2.0", method, params: normalizedParams },
      method,
      method === "tools/call" && typeof params.name === "string" ? params.name : undefined,
    );

    return translateResponse(await modernHandler(normalizedRequest), method, id);
  };
