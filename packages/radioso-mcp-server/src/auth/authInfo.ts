import type { AccessSessionRecord } from "./sessionStore.js";

export interface McpRequestAuthInfo {
  clientName?: string;
  converseSessionToken?: string;
  sessionExpiresAt: string;
  sessionId: string;
}

export const toMcpRequestAuthInfo = (session: AccessSessionRecord): McpRequestAuthInfo => ({
  clientName: session.clientName,
  converseSessionToken: session.converseSessionToken,
  sessionExpiresAt: session.expiresAt.toISOString(),
  sessionId: session.sessionId,
});
