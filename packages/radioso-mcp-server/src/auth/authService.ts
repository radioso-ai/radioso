import { randomUUID } from "node:crypto";

import type { AuditLogger } from "../audit/auditLogger.js";
import { createAuditLogger } from "../audit/auditLogger.js";
import type { CapabilityPolicyRegistry } from "../policy/capabilityPolicy.js";
import { CapabilityPolicyError } from "../policy/capabilityPolicy.js";
import { RadiosoApiError } from "../radiosoApiAdapter.js";
import { toMcpRequestAuthInfo, type McpRequestAuthInfo } from "./authInfo.js";
import { issueOpaqueToken } from "./token.js";
import type { ApprovalGrantRecord, ApprovalStore } from "./approvalStore.js";
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
  approvalStore: ApprovalStore;
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
  approvalTtlSeconds?: number;
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

export interface IssueApprovalInput {
  accessToken: string;
  reason: string;
  resourceHints?: string[];
  tools: string[];
}

export interface IssueApprovalResult {
  approvedTools: string[];
  approvalToken: string;
  expiresAt: string;
  approvalId: string;
}

export interface AuthService {
  exchangeWorkspaceToken(input: ExchangeWorkspaceTokenInput): Promise<ExchangeWorkspaceTokenResult>;
  getApproval(approvalToken: string): Promise<ApprovalGrantRecord | null>;
  getRequestAuthInfo(accessToken: string, options?: { approvalGrantIds?: string[] }): Promise<McpRequestAuthInfo | null>;
  getSession(accessToken: string): Promise<AccessSessionRecord | null>;
  issueApproval(input: IssueApprovalInput): Promise<IssueApprovalResult>;
  verifyApproval(accessToken: string, approvalToken: string, toolName: string): Promise<ApprovalGrantRecord>;
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

const ensureSession = (session: AccessSessionRecord | null): AccessSessionRecord => {
  if (!session) {
    throw new AuthServiceError("MCP access token is invalid or expired.", "invalid_access_token");
  }

  return session;
};

const unique = (values: string[]): string[] => [...new Set(values)];

export const createAuthService = (dependencies: AuthServiceDependencies): AuthService => {
  const now = dependencies.now ?? defaultNow;
  const auditLogger = dependencies.auditLogger ?? createAuditLogger([]);
  const accessTokenTtlSeconds = dependencies.accessTokenTtlSeconds ?? 900;
  const approvalTtlSeconds = dependencies.approvalTtlSeconds ?? 300;

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

    async issueApproval(input: IssueApprovalInput): Promise<IssueApprovalResult> {
      let sessionId: string | undefined;

      try {
        const session = ensureSession(await dependencies.sessionStore.getByAccessToken(input.accessToken, now()));
        sessionId = session.sessionId;
        const policy = dependencies.resolvePolicy?.(session.workspaceId).policy ?? dependencies.policy;
        const resolution = policy.resolveApprovalTools(input.tools, session.grantedTools);

        if (resolution.deniedTools.length > 0) {
          throw new CapabilityPolicyError(
            `Approval requested for unsupported tools: ${resolution.deniedTools.join(", ")}`,
            "approval_forbidden",
            { deniedTools: resolution.deniedTools },
          );
        }

        if (resolution.approvalRequiredTools.length !== resolution.grantedTools.length) {
          throw new CapabilityPolicyError(
            "Approval may only be issued for governed write tools.",
            "approval_forbidden",
            { tools: input.tools },
          );
        }

        const issuedAt = now();
        const approvalToken = issueOpaqueToken("mcp_appr", dependencies.signingSecret, issuedAt);
        const approvalId = `appr_${randomUUID()}`;
        const expiresAt = new Date(
          Math.min(
            session.expiresAt.getTime(),
            issuedAt.getTime() + approvalTtlSeconds * 1000,
          ),
        );

        await dependencies.approvalStore.save({
          allowedTools: resolution.grantedTools,
          approvalId,
          approvalToken,
          expiresAt,
          issuedAt,
          reason: input.reason,
          remainingUses: resolution.grantedTools.length || 1,
          resourceHints: input.resourceHints,
          sessionId: session.sessionId,
        });

        await emit({
          approvalId,
          eventType: "approval.issued",
          metadata: {
            approvedTools: resolution.grantedTools,
            reason: input.reason,
            resourceHints: input.resourceHints,
          },
          outcome: "success",
          sessionId: session.sessionId,
        });

        return {
          approvedTools: resolution.grantedTools,
          approvalId,
          approvalToken,
          expiresAt: expiresAt.toISOString(),
        };
      } catch (error) {
        const failure = toAuditFailure(error);
        await emit({
          eventType: "approval.denied",
          metadata: {
            code: failure.code,
            ...(failure.details !== undefined ? { details: failure.details } : {}),
            message: failure.message,
            reason: input.reason,
            resourceHints: input.resourceHints,
            tools: input.tools,
          },
          outcome: failure.outcome,
          sessionId,
        });
        throw error;
      }
    },

    async getSession(accessToken: string): Promise<AccessSessionRecord | null> {
      return dependencies.sessionStore.getByAccessToken(accessToken, now());
    },

    async getApproval(approvalToken: string): Promise<ApprovalGrantRecord | null> {
      return dependencies.approvalStore.getByToken(approvalToken, now());
    },

    async getRequestAuthInfo(
      accessToken: string,
      options: { approvalGrantIds?: string[] } = {},
    ): Promise<McpRequestAuthInfo | null> {
      const session = await dependencies.sessionStore.getByAccessToken(accessToken, now());
      return session ? toMcpRequestAuthInfo(session, options) : null;
    },

    async verifyApproval(accessToken: string, approvalToken: string, toolName: string): Promise<ApprovalGrantRecord> {
      const session = ensureSession(await dependencies.sessionStore.getByAccessToken(accessToken, now()));
      const approvalResult = await dependencies.approvalStore.consumeForSessionTool(
        approvalToken,
        {
          sessionId: session.sessionId,
          toolName,
        },
        now(),
      );

      if (approvalResult.status === "missing") {
        throw new AuthServiceError("A valid approval grant is required.", "approval_required", { toolName });
      }

      if (approvalResult.status === "session_mismatch") {
        throw new AuthServiceError("Approval grant does not match the active session.", "approval_forbidden", {
          toolName,
        });
      }

      if (approvalResult.status === "tool_forbidden") {
        throw new AuthServiceError("Approval grant does not cover the requested tool.", "approval_forbidden", {
          toolName,
        });
      }

      return approvalResult.grant;
    },
  };
};
