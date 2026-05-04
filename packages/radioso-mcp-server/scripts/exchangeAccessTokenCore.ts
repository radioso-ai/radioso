export const DEFAULT_TOOLS = [
  "describe_capabilities",
  "list_documents",
  "get_document",
  "search_documents",
  "answer_grounded",
  "get_retrieval_settings",
  "create_document",
  "update_document",
  "delete_document",
  "reprocess_document",
  "update_retrieval_settings",
];

export type OutputFormat = "shell" | "token" | "json";

export interface ExchangeArgs {
  clientName?: string;
  format: OutputFormat;
  mcpUrl?: string;
  requestedTools?: string[];
}

export interface ExchangeResult {
  accessToken: string;
  approvalRequiredTools?: string[];
  expiresAt?: string;
  grantedTools?: string[];
  policySource?: string;
  sessionId?: string;
  tokenType?: string;
  unsupportedTools?: string[];
  workspaceHint?: string;
  workspaceId?: string;
  workspaceName?: string;
}

export const usage = `Usage:
  RADIOSO_WORKSPACE_TOKEN=sk_proj_... npm --prefix packages/radioso-mcp-server run -s token:exchange

Environment:
  RADIOSO_WORKSPACE_TOKEN   Required. Workspace token from Radioso Settings -> Developer API.
  RADIOSO_MCP_URL          Optional. Defaults to http://127.0.0.1:8787
  RADIOSO_MCP_CLIENT_NAME  Optional. Defaults to cursor-local
  RADIOSO_MCP_REQUESTED_TOOLS
                           Optional comma-separated tool list.

Flags:
  --format shell|token|json
  --mcp-url URL
  --client-name NAME
  --requested-tools tool1,tool2
  --help

Examples:
  source <(RADIOSO_WORKSPACE_TOKEN=sk_proj_... npm --prefix packages/radioso-mcp-server run -s token:exchange)
  RADIOSO_WORKSPACE_TOKEN=sk_proj_... npm --prefix packages/radioso-mcp-server run -s token:exchange -- --format json
`;

export const shellEscape = (value: string): string => value.replace(/'/g, "'\\''");

export const readValue = (name: string): string | undefined => {
  const value = process.env[name]?.trim();
  return value && value.length > 0 ? value : undefined;
};

export const parseCsv = (value: string | undefined): string[] | undefined => {
  if (!value) {
    return undefined;
  }

  const items = value
    .split(",")
    .map((item) => item.trim())
    .filter((item) => item.length > 0);

  return items.length > 0 ? items : undefined;
};

export const parseExchangeArgs = (argv: string[]): ExchangeArgs => {
  const parsed: ExchangeArgs = {
    format: "shell",
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];

    if (arg === "--help") {
      process.stdout.write(`${usage}\n`);
      process.exit(0);
    }

    if (arg === "--format") {
      const next = argv[index + 1];
      if (next !== "shell" && next !== "token" && next !== "json") {
        throw new Error("Expected --format to be one of: shell, token, json.");
      }
      parsed.format = next;
      index += 1;
      continue;
    }

    if (arg === "--mcp-url") {
      const next = argv[index + 1]?.trim();
      if (!next) {
        throw new Error("Expected a value after --mcp-url.");
      }
      parsed.mcpUrl = next;
      index += 1;
      continue;
    }

    if (arg === "--client-name") {
      const next = argv[index + 1]?.trim();
      if (!next) {
        throw new Error("Expected a value after --client-name.");
      }
      parsed.clientName = next;
      index += 1;
      continue;
    }

    if (arg === "--requested-tools") {
      const next = argv[index + 1]?.trim();
      if (!next) {
        throw new Error("Expected a value after --requested-tools.");
      }
      parsed.requestedTools = parseCsv(next);
      index += 1;
      continue;
    }

    throw new Error(`Unknown argument: ${arg}`);
  }

  return parsed;
};

export const exchangeAccessToken = async (args: ExchangeArgs): Promise<ExchangeResult> => {
  const workspaceToken =
    readValue("RADIOSO_WORKSPACE_TOKEN") ??
    readValue("WORKSPACE_TOKEN") ??
    readValue("RADIOSO_API_TOKEN");

  if (!workspaceToken) {
    throw new Error("RADIOSO_WORKSPACE_TOKEN is required.");
  }

  const mcpUrl = args.mcpUrl ?? readValue("RADIOSO_MCP_URL") ?? "http://127.0.0.1:8787";
  const clientName = args.clientName ?? readValue("RADIOSO_MCP_CLIENT_NAME") ?? "cursor-local";
  const requestedTools =
    args.requestedTools ??
    parseCsv(readValue("RADIOSO_MCP_REQUESTED_TOOLS")) ??
    DEFAULT_TOOLS;

  const response = await fetch(new URL("/v1/auth/exchange", mcpUrl), {
    body: JSON.stringify({
      clientName,
      radiosoApiToken: workspaceToken,
      requestedTools,
    }),
    headers: {
      "content-type": "application/json",
    },
    method: "POST",
  });

  const body = (await response.json()) as
    | ExchangeResult
    | {
        error?: {
          code?: string;
          message?: string;
        };
      };

  if (!response.ok) {
    const errorCode = "error" in body ? body.error?.code : undefined;
    const errorMessage = "error" in body ? body.error?.message : undefined;
    throw new Error(`${errorCode ?? "exchange_failed"}: ${errorMessage ?? "Token exchange failed."}`);
  }

  if (!("accessToken" in body) || !body.accessToken) {
    throw new Error("Exchange response did not include an accessToken.");
  }

  return body;
};
