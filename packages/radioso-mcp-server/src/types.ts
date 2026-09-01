import type { ServerContext } from "@modelcontextprotocol/server";

import type { ConverseApiAdapter } from "./converseApiAdapter.js";

export type JsonPrimitive = string | number | boolean | null;
export type JsonRecord = Record<string, JsonPrimitive>;

export interface ToolExecutionResult {
  summary: string;
  data: unknown;
}

export interface RemoteToolAuthInfo {
  sessionId: string;
  clientName?: string;
  converseSessionToken?: string;
}

export interface ToolExecutionContext {
  authInfo: RemoteToolAuthInfo | null;
  converseAdapter?: ConverseApiAdapter;
  converseSessionToken?: string;
  serverContext: ServerContext;
}

export interface ToolDefinition<TArgs = Record<string, unknown>> {
  name: string;
  description: string;
  inputSchema: any;
  execute: (args: TArgs, context: ToolExecutionContext) => Promise<ToolExecutionResult>;
}
