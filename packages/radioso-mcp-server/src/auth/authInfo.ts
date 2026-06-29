import type { AccessSessionRecord } from "./sessionStore.js";

export interface McpRequestAuthInfo {
  approvalRequiredTools?: string[];
  clientName?: string;
  grantedTools: string[];
  converseSessionToken?: string;
  sessionExpiresAt: string;
  sessionId: string;
  upstreamApiVersion?: string;
  upstreamMcpContextVersion?: string;
  upstreamSupportedTools?: string[];
  workspaceId?: string;
  workspaceHint?: string;
  workspaceName?: string;
}

export const toMcpRequestAuthInfo = (session: AccessSessionRecord): McpRequestAuthInfo => ({
  approvalRequiredTools: session.approvalRequiredTools ? [...session.approvalRequiredTools] : undefined,
  clientName: session.clientName,
  grantedTools: [...session.grantedTools],
  converseSessionToken: session.converseSessionToken,
  sessionExpiresAt: session.expiresAt.toISOString(),
  sessionId: session.sessionId,
  upstreamApiVersion: session.upstreamApiVersion,
  upstreamMcpContextVersion: session.upstreamMcpContextVersion,
  upstreamSupportedTools: session.upstreamSupportedTools ? [...session.upstreamSupportedTools] : undefined,
  workspaceId: session.workspaceId,
  workspaceHint: session.workspaceHint,
  workspaceName: session.workspaceName,
});
