import type { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/server";

import type { McpRequestAuthInfo } from "../auth/authInfo.js";
import type { AuthService } from "../auth/authService.js";
import type { AuditLogger } from "../audit/auditLogger.js";
import type { AccessSessionRecord } from "../auth/sessionStore.js";
import type { RadiosoMcpConfig } from "../config.js";
import type { RadiosoMcpServerHandle } from "../server.js";

export interface InternalMcpRequestAuthInfo extends McpRequestAuthInfo {
  accessToken: string;
  clientId: string;
  scopes: string[];
  token: string;
  upstreamApiToken?: string;
}

export interface SessionMcpServerHandle {
  serverHandle: RadiosoMcpServerHandle;
  toolCatalogKey: string;
  transport: WebStandardStreamableHTTPServerTransport;
}

export interface SessionMcpServerManager {
  evict(toolCatalogKey: string): Promise<void>;
  getOrCreate(session: AccessSessionRecord): Promise<SessionMcpServerHandle>;
}

export interface RemoteHttpDependencies {
  authService: AuthService;
  auditLogger?: AuditLogger;
  config: RadiosoMcpConfig;
}
