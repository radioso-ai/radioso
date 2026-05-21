import { randomUUID } from "node:crypto";

import type { AuditLogger } from "../audit/auditLogger.js";
import { createAuditLogger } from "../audit/auditLogger.js";
import type { CapabilityPolicyRegistry } from "../policy/capabilityPolicy.js";
import { CapabilityPolicyError } from "../policy/capabilityPolicy.js";
import { RadiosoApiError } from "../radiosoApiAdapter.js";
import { toMcpRequestAuthInfo, type McpRequestAuthInfo } from "./authInfo.js";
import { issueOpaqueToken } from "./token.js";
import type { AccessSessionRecord, SessionStore } from "./sessionStore.js";

export class AuthServiceError extends Error {
  constructor(
    message: string,
    readonly code: string,
    readonly details?: unknown,
  ) {
    super(message);
    this.name = "AuthServiceError";
  }
}

export interface AuthServiceDependencies {
  auditLogger?: AuditLogger;
  now?: () => Date;
  policy: CapabilityPolicyRegistry;
  resolvePolicy?: (workspaceId?: string) => {
    policy: CapabilityPolicyRegistry;
    source: "global" | "workspace";
    workspaceId?: string;
  };
  sessionStore: SessionStore;
  signingSecret: string;
  validateWorkspaceToken: (radiosoApiToken: string) => Promise<{
    apiVersion?: string;
    mcpContextVersion?: string;
    supportedTools?: string[];
    workspaceHint?: string;
    workspaceId?: string;
    workspaceName?: string;
  }>;
  accessTokenTtlSeconds?: number;
}

export interface ExchangeWorkspaceTokenInput {
  clientName?: string;
  radiosoApiToken: string;
  requestedTools?: string[];
  requestedProfiles?: string[];
}

export interface ExchangeWorkspaceTokenResult {
  accessToken: string;
  approvalRequiredTools: string[];
  expiresAt: string;
  grantedTools: string[];
  policySource?: "global" | "workspace";
  sessionId: string;
  tokenType: "Bearer";
  unsupportedTools?: string[];
  workspaceId?: string;
  workspaceHint?: string;
  workspaceName?: string;
}

export interface AuthService {
  exchangeWorkspaceToken(input: ExchangeWorkspaceTokenInput): Promise<ExchangeWorkspaceTokenResult>;
  getRequestAuthInfo(accessToken: string): Promise<McpRequestAuthInfo | null>;
  getSession(accessToken: string): Promise<AccessSessionRecord | null>;
}

const defaultNow = () => new Date();

const toAuditFailure = (
  error: unknown,
): {
  code: string;
  details?: unknown;
  message: string;
  outcome: "denied" | "error";
} => {
  if (error instanceof CapabilityPolicyError) {
    return {
      code: error.code,
      details: error.details,
      message: error.message,
      outcome: "denied",
    };
  }

  if (error instanceof AuthServiceError) {
    return {
      code: error.code,
      details: error.details,
      message: error.message,
      outcome: "denied",
    };
  }

  if (error instanceof RadiosoApiError) {
    const authenticationFailure = error.status === 401 || error.status === 403;
    return {
      code: error.code ?? (authenticationFailure ? "authentication_failed" : "radioso_request_failed"),
      details: error.details,
      message: error.message,
      outcome: authenticationFailure ? "denied" : "error",
    };
  }

  if (error instanceof Error) {
    return {
      code: "internal_error",
      message: error.message,
      outcome: "error",
    };
  }

  return {
    code: "internal_error",
    message: "Unexpected auth service error.",
    outcome: "error",
  };
};

const unique = (values: string[]): string[] => [...new Set(values)];

export const createAuthService = (dependencies: AuthServiceDependencies): AuthService => {
  const now = dependencies.now ?? defaultNow;
  const auditLogger = dependencies.auditLogger ?? createAuditLogger([]);
  const accessTokenTtlSeconds = dependencies.accessTokenTtlSeconds ?? 900;

  const emit = async (event: Parameters<AuditLogger["emit"]>[0]) => {
    await auditLogger.emit(event);
  };

  return {
    async exchangeWorkspaceToken(input: ExchangeWorkspaceTokenInput): Promise<ExchangeWorkspaceTokenResult> {
      try {
        const issuedAt = now();
        const validation = await dependencies.validateWorkspaceToken(input.radiosoApiToken);
        const policyResolution = dependencies.resolvePolicy?.(validation.workspaceId) ?? {
          policy: dependencies.policy,
          source: "global" as const,
          workspaceId: validation.workspaceId,
        };
        const requestedTools = input.requestedTools && input.requestedTools.length > 0
          ? input.requestedTools
          : policyResolution.policy.configuredTools();
        const resolution = policyResolution.policy.resolveRequestedTools(requestedTools);

        if (resolution.deniedTools.length > 0) {
          throw new CapabilityPolicyError(
            `Requested tools are not allowed: ${resolution.deniedTools.join(", ")}`,
            "capability_forbidden",
            { deniedTools: resolution.deniedTools },
          );
        }

        const upstreamSupportedTools = validation.supportedTools ? unique(validation.supportedTools) : undefined;
        const unsupportedTools = upstreamSupportedTools
          ? resolution.grantedTools.filter((toolName) => !upstreamSupportedTools.includes(toolName))
          : [];
        const grantedTools = upstreamSupportedTools
          ? resolution.grantedTools.filter((toolName) => upstreamSupportedTools.includes(toolName))
          : resolution.grantedTools;
        const approvalRequiredTools = resolution.approvalRequiredTools.filter((toolName) => grantedTools.includes(toolName));

        const accessToken = issueOpaqueToken("mcp_sess", dependencies.signingSecret, issuedAt);
        const sessionId = `sess_${randomUUID()}`;
        const expiresAt = new Date(issuedAt.getTime() + accessTokenTtlSeconds * 1000);

        await dependencies.sessionStore.save({
          accessToken,
          approvalRequiredTools,
          clientName: input.clientName,
          expiresAt,
          grantedProfiles: input.requestedProfiles,
          grantedTools,
          issuedAt,
          sessionId,
          upstreamApiVersion: validation.apiVersion,
          upstreamMcpContextVersion: validation.mcpContextVersion,
          upstreamSupportedTools,
          upstreamApiToken: input.radiosoApiToken,
          workspaceId: validation.workspaceId,
          workspaceHint: validation.workspaceHint,
          workspaceName: validation.workspaceName,
        });

        await emit({
          eventType: "auth.exchange_succeeded",
          metadata: {
            approvalRequiredTools,
            clientName: input.clientName,
            grantedTools,
            policySource: policyResolution.source,
            unsupportedTools,
            workspaceId: validation.workspaceId,
            workspaceHint: validation.workspaceHint,
            workspaceName: validation.workspaceName,
          },
          outcome: "success",
          sessionId,
        });

        return {
          accessToken,
          approvalRequiredTools,
          expiresAt: expiresAt.toISOString(),
          grantedTools,
          policySource: policyResolution.source,
          sessionId,
          tokenType: "Bearer",
          unsupportedTools: unsupportedTools.length > 0 ? unsupportedTools : undefined,
          workspaceId: validation.workspaceId,
          workspaceHint: validation.workspaceHint,
          workspaceName: validation.workspaceName,
        };
      } catch (error) {
        const failure = toAuditFailure(error);
        await emit({
          eventType: "auth.exchange_failed",
          metadata: {
            clientName: input.clientName,
            code: failure.code,
            ...(failure.details !== undefined ? { details: failure.details } : {}),
            message: failure.message,
            requestedProfiles: input.requestedProfiles,
            requestedTools: input.requestedTools,
          },
          outcome: failure.outcome,
        });
        throw error;
      }
    },

    async getSession(accessToken: string): Promise<AccessSessionRecord | null> {
      return dependencies.sessionStore.getByAccessToken(accessToken, now());
    },

    async getRequestAuthInfo(accessToken: string): Promise<McpRequestAuthInfo | null> {
      const session = await dependencies.sessionStore.getByAccessToken(accessToken, now());
      return session ? toMcpRequestAuthInfo(session) : null;
    },
  };
};
