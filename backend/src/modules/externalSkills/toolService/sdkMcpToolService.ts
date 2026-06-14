import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { OAuthClientProvider } from "@modelcontextprotocol/sdk/client/auth.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";

import type {
  ConversationToolDefinition,
  ToolCallInput,
  ToolCallResult,
  ToolService,
} from "@radioso/conversation-tools";

/**
 * Resolves the auth a connection presents to its MCP server. Pluggable so the
 * spine stays auth-method-agnostic: static bearer token (P1, header-based) and
 * OAuth (P2, via the SDK {@link OAuthClientProvider}) both slot in without
 * changing {@link SdkMcpToolService}.
 */
export interface McpCredentialProvider {
  getRequestHeaders(): Promise<Record<string, string>>;
}

export interface SdkMcpToolServiceOptions {
  /** Remote Streamable-HTTP MCP endpoint (production). */
  serverUrl?: string;
  /** Static-token (P1) credential seam: headers applied to every request. */
  credentialProvider?: McpCredentialProvider;
  /** OAuth (P2) seam: SDK-native provider that handles token refresh/re-auth. */
  authProvider?: OAuthClientProvider;
  /** Bound applied to connect, discovery, and each tool invocation. */
  timeoutMs?: number;
  /** Test seam: supply a transport directly (e.g. in-memory) instead of HTTP. */
  transportFactory?: () => Transport | Promise<Transport>;
  /**
   * SSRF guard, re-evaluated immediately before each connect against the live
   * `serverUrl` — defends the runtime path against DB-mutated records and DNS
   * rebinding (the create-time check alone is not sufficient).
   */
  assertPublicUrl?: (url: string) => void | Promise<void>;
  clientInfo?: { name: string; version: string };
}

const DEFAULT_TIMEOUT_MS = 10_000;
const DEFAULT_CLIENT_INFO = { name: "radioso", version: "1.0.0" };

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

class McpTimeoutError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "McpTimeoutError";
  }
}

const withTimeout = async <T>(operation: Promise<T>, timeoutMs: number, label: string): Promise<T> => {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => reject(new McpTimeoutError(label)), timeoutMs);
  });
  try {
    return await Promise.race([operation, timeout]);
  } finally {
    if (timer) {
      clearTimeout(timer);
    }
  }
};

const textFromContent = (content: McpContentBlock[] | undefined): string | undefined => {
  const text = content
    ?.map((block) => block.text)
    .filter((value): value is string => typeof value === "string")
    .join("\n")
    .trim();
  return text ? text : undefined;
};

const structuredOutputs = (value: unknown): Record<string, unknown> | undefined => {
  if (value === undefined) {
    return undefined;
  }
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : { structuredContent: value };
};

/**
 * A {@link ToolService} backed by the official MCP TypeScript SDK v1 client over
 * Streamable HTTP (with a pluggable credential seam). Reused by the
 * transport-agnostic `ToolSkillBridge`; the conversation engine never sees it.
 *
 * Coarse outcome mapping only: MCP `isError` -> failed, otherwise completed.
 * Fine-grained named outcomes (P3) are derived downstream from `answer`/`outputs`.
 *
 * Failure handling is sanitized: transport/connect/auth exceptions never surface
 * raw error text (which could carry endpoint or credential detail) in the
 * returned result; they map to a generic code/message. Internal observability
 * (added separately) is the place for redacted diagnostic detail.
 */
export class SdkMcpToolService implements ToolService {
  private client: Client | undefined;
  private clientPromise: Promise<Client> | undefined;
  private readonly timeoutMs: number;

  constructor(private readonly options: SdkMcpToolServiceOptions) {
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  }

  private async buildTransport(): Promise<Transport> {
    if (this.options.transportFactory) {
      return this.options.transportFactory();
    }
    if (!this.options.serverUrl) {
      throw new Error("SdkMcpToolService requires a serverUrl or a transportFactory");
    }
    // SSRF guard re-checked immediately before the outbound connection.
    await this.options.assertPublicUrl?.(this.options.serverUrl);
    const url = new URL(this.options.serverUrl);
    if (this.options.authProvider) {
      return new StreamableHTTPClientTransport(url, { authProvider: this.options.authProvider });
    }
    const headers = (await this.options.credentialProvider?.getRequestHeaders()) ?? {};
    return new StreamableHTTPClientTransport(url, { requestInit: { headers } });
  }

  private async connectClient(): Promise<Client> {
    const client = new Client(this.options.clientInfo ?? DEFAULT_CLIENT_INFO, { capabilities: {} });
    try {
      const transport = await this.buildTransport();
      await withTimeout(client.connect(transport), this.timeoutMs, "mcp connect timed out");
    } catch (error) {
      await client.close().catch(() => undefined);
      throw error;
    }
    this.client = client;
    return client;
  }

  /** Concurrency-safe lazy connect: one in-flight attempt, cleared on failure. */
  private getClient(): Promise<Client> {
    if (this.client) {
      return Promise.resolve(this.client);
    }
    if (!this.clientPromise) {
      this.clientPromise = this.connectClient().catch((error) => {
        this.clientPromise = undefined;
        throw error;
      });
    }
    return this.clientPromise;
  }

  async listTools(): Promise<ConversationToolDefinition[]> {
    const client = await this.getClient();
    const result = await client.listTools(undefined, { timeout: this.timeoutMs });
    return result.tools.map((tool) => ({
      name: tool.name,
      description: tool.description,
      inputSchema: tool.inputSchema,
      outputSchema: tool.outputSchema,
      metadata: { transport: "mcp" },
    }));
  }

  async callTool(input: ToolCallInput): Promise<ToolCallResult> {
    let result: McpCallToolResult;
    try {
      const client = await this.getClient();
      result = (await client.callTool(
        {
          name: input.toolName,
          arguments: (input.input ?? {}) as Record<string, unknown>,
        },
        undefined,
        { timeout: this.timeoutMs, signal: input.context?.signal },
      )) as McpCallToolResult;
    } catch (error) {
      // Sanitized: never surface raw exception text (may carry endpoint/credential detail).
      const isTimeout = error instanceof McpTimeoutError;
      return {
        status: "failed",
        error: {
          code: isTimeout ? "mcp_timeout" : "mcp_call_failed",
          message: isTimeout ? "External tool call timed out" : "External tool call failed",
          retryable: isTimeout,
        },
        metadata: { transport: "mcp" },
      };
    }

    const answer = textFromContent(result.content);
    const outputs = structuredOutputs(result.structuredContent);
    if (result.isError) {
      return {
        status: "failed",
        // `answer` here is the tool's own returned text (intended for the conversation),
        // not an exception message — safe to surface.
        ...(answer ? { answer } : {}),
        ...(outputs ? { outputs } : {}),
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
      ...(answer ? { answer } : {}),
      ...(outputs ? { outputs } : {}),
      metadata: { transport: "mcp" },
    };
  }

  async close(): Promise<void> {
    const pending = this.clientPromise;
    this.clientPromise = undefined;
    if (pending) {
      await pending.then((client) => client.close()).catch(() => undefined);
    } else {
      await this.client?.close().catch(() => undefined);
    }
    this.client = undefined;
  }
}
