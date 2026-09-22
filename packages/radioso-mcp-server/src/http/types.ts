import type { McpRequestAuthInfo } from "../auth/authInfo.js";
import type { AuthService } from "../auth/authService.js";
import type { AuditLogger } from "../audit/auditLogger.js";
import type { AccessSessionRecord } from "../auth/sessionStore.js";
import type { RadiosoMcpConfig } from "../config.js";
import type { RuntimeStoreReadiness } from "../state/runtimeStores.js";
import type { PreAuthSourceBudget } from "./preAuthSourceBudget.js";
import type { OperatorHttpDependencies } from "../operator/types.js";

export interface InternalMcpRequestAuthInfo extends McpRequestAuthInfo {
  accessToken: string;
  clientId: string;
  scopes: string[];
  sourceDigest?: string;
  token: string;
}

export interface SessionMcpServerManager {
  /** Answers one MCP request for an authenticated session on a server and transport of its own. */
  handleRequest(
    session: AccessSessionRecord,
    request: Request,
    options: { authInfo: InternalMcpRequestAuthInfo },
  ): Promise<Response>;
}

export interface RemoteHttpDependencies {
  authService: AuthService;
  auditLogger?: AuditLogger;
  config: RadiosoMcpConfig;
  readiness?: RuntimeStoreReadiness;
  preAuthSourceBudget?: PreAuthSourceBudget;
  operatorMcp?: OperatorHttpDependencies;
}
