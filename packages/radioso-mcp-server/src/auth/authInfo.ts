import type { AccessSessionRecord } from "./sessionStore.js";

export interface McpRequestAuthInfo {
  approvalGrantIds?: string[];
  approvalRequiredTools?: string[];
  clientName?: string;
  grantedTools: string[];
  sessionExpiresAt: string;
  sessionId: string;
  upstreamApiVersion?: string;
  upstreamMcpContextVersion?: string;
  upstreamSupportedTools?: string[];
  workspaceId?: string;
  workspaceHint?: string;
  workspaceName?: string;
}

export const toMcpRequestAuthInfo = (
  session: AccessSessionRecord,
  options: { approvalGrantIds?: string[] } = {},
): McpRequestAuthInfo => ({
  approvalGrantIds: options.approvalGrantIds,
  approvalRequiredTools: session.approvalRequiredTools ? [...session.approvalRequiredTools] : undefined,
  clientName: session.clientName,
  grantedTools: [...session.grantedTools],
  sessionExpiresAt: session.expiresAt.toISOString(),
  sessionId: session.sessionId,
  upstreamApiVersion: session.upstreamApiVersion,
  upstreamMcpContextVersion: session.upstreamMcpContextVersion,
  upstreamSupportedTools: session.upstreamSupportedTools ? [...session.upstreamSupportedTools] : undefined,
  workspaceId: session.workspaceId,
  workspaceHint: session.workspaceHint,
  workspaceName: session.workspaceName,
});
