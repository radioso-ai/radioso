import type { ServerContext } from "@modelcontextprotocol/server";

import type { components } from "./generated/openapiTypes.js";
import type { RadiosoApiAdapter } from "./radiosoApiAdapter.js";
import type { ConverseApiAdapter } from "./converseApiAdapter.js";

export type JsonPrimitive = string | number | boolean | null;
export type JsonRecord = Record<string, JsonPrimitive>;

export type DocumentListResult = components["schemas"]["DocumentListResponse"];

export interface ToolExecutionResult {
  summary: string;
  data: unknown;
}

export type ToolAccessMode = "read" | "write";

export interface RemoteToolAuthInfo {
  approvalRequiredTools?: string[];
  sessionId: string;
  grantedTools: string[];
  upstreamApiVersion?: string;
  upstreamMcpContextVersion?: string;
  upstreamSupportedTools?: string[];
  upstreamApiToken?: string;
  clientName?: string;
  workspaceId?: string;
  workspaceHint?: string;
  workspaceName?: string;
  converseSessionToken?: string;
}

export interface ToolExecutionContext {
  adapter: RadiosoApiAdapter;
  authInfo: RemoteToolAuthInfo | null;
  converseAdapter?: ConverseApiAdapter;
  converseSessionToken?: string;
  serverContext: ServerContext;
}

export interface ToolDefinition<TArgs = Record<string, unknown>> {
  name: string;
  accessMode: ToolAccessMode;
  description: string;
  requiresApproval?: boolean;
  inputSchema: any;
  execute: (args: TArgs, context: ToolExecutionContext) => Promise<ToolExecutionResult>;
}
