import type { ServerContext } from "@modelcontextprotocol/server";

import type { RadiosoApiAdapter } from "./radiosoApiAdapter.js";

export type JsonPrimitive = string | number | boolean | null;
export type JsonRecord = Record<string, JsonPrimitive>;

export interface DocumentListResult {
  documents?: unknown[];
  [key: string]: unknown;
}

export interface RetrievalSettingsRecord {
  queryRewriteEnabled: boolean;
  semanticRewriteInstructions: string;
  lexicalRewriteInstructions: string;
  answerSupportPolicy: "strict" | "warn" | "off";
  conversationMode: "factual" | "guided" | "exploratory";
  suggestedQuestionsEnabled: boolean;
  suggestedQuestionsCount: number;
  rerankEnabled: boolean;
  vectorTopK: number;
  similarityThreshold: number;
  rerankTopK: number;
  citationDisplayEnabled: boolean;
  metadataRules: Array<{
    id: string;
    field: string;
    valueType: "string" | "number" | "date" | "boolean";
    operator: "equals" | "not_equals" | "contains" | "not_contains" | "lt" | "lte" | "gt" | "gte";
    value: string;
    effect: "boost" | "filter";
    enabled: boolean;
  }>;
  customInstruction: string;
  [key: string]: unknown;
}

export interface WorkspaceMcpContextRecord {
  apiVersion: string;
  mcpContextVersion: string;
  supportedTools: string[];
  workspaceId: string;
  workspaceName: string;
}

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
}

export interface ToolExecutionContext {
  adapter: RadiosoApiAdapter;
  authInfo: RemoteToolAuthInfo | null;
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
