import type { ConversationToolDefinition, ToolCallInput, ToolCallResult, ToolService } from "./types.js";
import { isRecord, recordFromUnknown } from "./typeGuards.js";

/**
 * JSON-RPC transport port for MCP tools. This package includes an HTTP JSON-RPC
 * implementation only; stdio is intentionally outside this package and callers
 * that need it should supply their own transport implementation.
 */
export interface McpJsonRpcTransport {
  request<Result>(method: string, params?: Record<string, unknown>): Promise<Result>;
}

export interface ToolFetchResponse {
  ok: boolean;
  status: number;
  headers: {
    get(name: string): string | null;
  };
  json(): Promise<unknown>;
  text(): Promise<string>;
}

export type ToolFetch = (
  url: string | URL,
  init?: {
    method?: string;
    headers?: Record<string, string>;
    body?: string;
    signal?: AbortSignal;
  },
) => Promise<ToolFetchResponse>;

export interface HttpMcpTransportOptions {
  endpoint: string | URL;
  headers?: Record<string, string>;
  fetch?: ToolFetch;
}

interface JsonRpcResponse<Result> {
  jsonrpc?: string;
  id?: string | number;
  result?: Result;
  error?: {
    code?: number;
    message?: string;
    data?: unknown;
  };
}

const previewBody = (body: string): string => {
  const trimmed = body.trim();
  return trimmed.length > 200 ? `${trimmed.slice(0, 200)}...` : trimmed;
};

export class McpHttpTransportError extends Error {
  readonly status: number;
  readonly body: string;

  constructor(method: string, status: number, body: string) {
    const preview = previewBody(body);
    super(`MCP HTTP transport returned HTTP ${status} for "${method}"${preview ? `: ${preview}` : ""}`);
    this.name = "McpHttpTransportError";
    this.status = status;
    this.body = body;
  }
}

export class McpJsonParseError extends Error {
  readonly status: number;
  readonly body?: string;

  constructor(method: string, status: number, body?: string, cause?: unknown) {
    const preview = body ? previewBody(body) : "";
    super(
      `MCP HTTP transport returned a non-JSON response for "${method}" with HTTP ${status}${
        preview ? `: ${preview}` : ""
      }`,
      { cause },
    );
    this.name = "McpJsonParseError";
    this.status = status;
    this.body = body;
  }
}

const parseJsonRpcResponse = async <Result>(
  method: string,
  response: ToolFetchResponse,
): Promise<JsonRpcResponse<Result>> => {
  const contentType = response.headers.get("content-type") ?? "";
  if (contentType && !contentType.includes("json")) {
    throw new McpJsonParseError(method, response.status, await response.text());
  }
  try {
    return await response.json() as JsonRpcResponse<Result>;
  } catch (error) {
    throw new McpJsonParseError(method, response.status, undefined, error);
  }
};

export class HttpMcpJsonRpcTransport implements McpJsonRpcTransport {
  private nextId = 1;
  private readonly fetchImpl: ToolFetch;

  constructor(private readonly options: HttpMcpTransportOptions) {
    this.fetchImpl = options.fetch ?? (globalThis.fetch as unknown as ToolFetch);
  }

  async request<Result>(method: string, params: Record<string, unknown> = {}): Promise<Result> {
    const id = String(this.nextId++);
    const response = await this.fetchImpl(this.options.endpoint, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...(this.options.headers ?? {}),
      },
      body: JSON.stringify({
        id,
        jsonrpc: "2.0",
        method,
        params,
      }),
    });
    if (!response.ok) {
      throw new McpHttpTransportError(method, response.status, await response.text());
    }
    const payload = await parseJsonRpcResponse<Result>(method, response);
    if (payload.error) {
      throw new Error(payload.error.message ?? `MCP JSON-RPC error ${payload.error.code ?? "unknown"}`);
    }
    if (!("result" in payload)) {
      throw new Error(`MCP JSON-RPC response for "${method}" did not include a result`);
    }
    return payload.result as Result;
  }
}

export interface McpWireTool {
  name: string;
  description?: string;
  inputSchema?: unknown;
  outputSchema?: unknown;
  annotations?: Record<string, unknown>;
}

interface McpListToolsResult {
  tools: McpWireTool[];
}

interface McpContentBlock {
  type?: string;
  text?: string;
  [key: string]: unknown;
}

interface McpCallToolResult {
  content?: McpContentBlock[];
  structuredContent?: unknown;
  isError?: boolean;
  [key: string]: unknown;
}

const textFromContent = (content: McpContentBlock[] | undefined): string | undefined => {
  const text = content
    ?.map((block) => block.text)
    .filter((value): value is string => typeof value === "string")
    .join("\n")
    .trim();
  return text ? text : undefined;
};

const mcpArguments = (input: unknown): Record<string, unknown> =>
  input === undefined ? {} : recordFromUnknown(input);

const structuredOutputs = (value: unknown): Record<string, unknown> | undefined => {
  if (value === undefined) {
    return undefined;
  }
  return isRecord(value) ? value : { structuredContent: value };
};

export class McpToolService implements ToolService {
  constructor(private readonly transport: McpJsonRpcTransport) {}

  async listTools(): Promise<ConversationToolDefinition[]> {
    const result = await this.transport.request<McpListToolsResult>("tools/list", {});
    return result.tools.map((tool) => ({
      name: tool.name,
      description: tool.description,
      inputSchema: tool.inputSchema,
      outputSchema: tool.outputSchema,
      metadata: {
        transport: "mcp",
        ...(tool.annotations ? { annotations: tool.annotations } : {}),
      },
    }));
  }

  async callTool(input: ToolCallInput): Promise<ToolCallResult> {
    const result = await this.transport.request<McpCallToolResult>("tools/call", {
      name: input.toolName,
      arguments: mcpArguments(input.input),
    });
    const answer = textFromContent(result.content);
    if (result.isError) {
      return {
        status: "failed",
        answer,
        outputs: structuredOutputs(result.structuredContent),
        error: {
          code: "mcp_tool_error",
          message: answer ?? `MCP tool "${input.toolName}" returned an error`,
          retryable: false,
        },
        metadata: { transport: "mcp" },
      };
    }
    return {
      status: "completed",
      answer,
      outputs: structuredOutputs(result.structuredContent),
      metadata: {
        transport: "mcp",
        content: result.content,
      },
    };
  }
}

export const createMcpToolService = (transport: McpJsonRpcTransport): McpToolService =>
  new McpToolService(transport);

/**
 * Creates an MCP tool service backed by the package's HTTP JSON-RPC transport.
 * Stdio MCP transport is not bundled here; pass a custom McpJsonRpcTransport to
 * createMcpToolService when another transport is required.
 */
export const createHttpMcpToolService = (options: HttpMcpTransportOptions): McpToolService =>
  new McpToolService(new HttpMcpJsonRpcTransport(options));
