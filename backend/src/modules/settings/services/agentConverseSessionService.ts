import { createHash, randomUUID } from "node:crypto";

import { AppError, serviceUnavailable } from "../../../shared/domain/errors.js";
import type { AccessGrant, AccessGrantEvaluation } from "../../accessGrants/public.js";
import type { AccessGrantService } from "../../accessGrants/public.js";
import { AGENT_CONVERSE_PERMISSIONS } from "../../account/public.js";
import {
  issueConverseChatSession,
  verifyConverseChatSession,
  type ConverseChatSessionPayload,
} from "../contracts/publicChatSession.js";
import type {
  AgentConverseAgentLookupPort,
  AgentConversePrincipal,
  AgentConverseSessionExchangeResult,
  AgentConverseSessionMappingPort,
} from "../contracts/agentConverseSession.js";

interface AgentConverseAuditPort {
  recordExchangeDenied(input: { grant?: AccessGrant | null; reason: string; clientName?: string | null }): Promise<void>;
  recordExchangeSucceeded(input: { grant: AccessGrant; publicSessionId: string; clientName?: string | null }): Promise<void>;
  recordValidationDenied(input: { grant?: AccessGrant | null; payload?: ConverseChatSessionPayload | null; reason: string }): Promise<void>;
}

const converseError = (statusCode: number, code: string, message: string) =>
  new AppError(statusCode, statusCode === 401 ? "unauthorized" : "forbidden", message, { code });

const grantVersion = (grant: Pick<AccessGrant, "id" | "tokenHash">): string =>
  createHash("sha256").update(`${grant.id}:${grant.tokenHash}`).digest("base64url");

const denialCode = (evaluation: AccessGrantEvaluation): string => {
  if (evaluation.allowed) {
    return "allowed";
  }
  if (evaluation.reason === "revoked") {
    return "grant_revoked";
  }
  return `grant_${evaluation.reason}`;
};

export class AgentConverseSessionService {
  constructor(
    private readonly dependencies: {
      accessGrantService: Pick<
        AccessGrantService,
        "resolveConverseGrant" | "resolvePublicLaunchGrant" | "findGrantById" | "evaluate" | "touchGrant" | "recordAuthFailure"
      >;
      agentLookup: AgentConverseAgentLookupPort;
      sessionMapping: AgentConverseSessionMappingPort;
      publicChatSessionSecret?: string;
      audit?: AgentConverseAuditPort;
    },
  ) {}

  async exchange(input: { launchToken: string; client?: { name?: string; version?: string } }): Promise<AgentConverseSessionExchangeResult> {
    if (!this.dependencies.publicChatSessionSecret) {
      throw serviceUnavailable("MCP converse sessions are not configured.", {
        missingEnv: "PUBLIC_CHAT_SESSION_SECRET",
      });
    }

    const wrongPublicGrant = await this.dependencies.accessGrantService.resolvePublicLaunchGrant(input.launchToken);
    if (wrongPublicGrant) {
      await this.dependencies.audit?.recordExchangeDenied({
        grant: wrongPublicGrant,
        reason: "grant_channel_not_allowed",
        clientName: input.client?.name,
      });
      throw converseError(403, "grant_channel_not_allowed", "This launch token is not valid for MCP converse.");
    }

    const grant = await this.dependencies.accessGrantService.resolveConverseGrant(input.launchToken);
    if (!grant) {
      await this.dependencies.audit?.recordExchangeDenied({
        reason: "invalid_converse_grant",
        clientName: input.client?.name,
      });
      throw converseError(401, "invalid_converse_grant", "Invalid MCP converse grant.");
    }

    const evaluation = this.dependencies.accessGrantService.evaluate(grant, {});
    if (!evaluation.allowed) {
      await this.dependencies.accessGrantService.recordAuthFailure({
        grant,
        reason: evaluation.reason,
        surface: "mcp-converse",
      });
      await this.dependencies.audit?.recordExchangeDenied({
        grant,
        reason: denialCode(evaluation),
        clientName: input.client?.name,
      });
      throw converseError(403, denialCode(evaluation), "MCP converse grant is not active.");
    }

    const agent = await this.dependencies.agentLookup.findByIdAndWorkspaceId(grant.agentId, grant.workspaceId);
    if (!agent) {
      await this.dependencies.audit?.recordExchangeDenied({
        grant,
        reason: "agent_unavailable",
        clientName: input.client?.name,
      });
      throw converseError(403, "agent_unavailable", "The bound agent is unavailable.");
    }

    const version = grantVersion(grant);
    const publicSessionId = await this.dependencies.sessionMapping.resolvePublicSessionId({
      grantId: grant.id,
      grantVersion: version,
      proposedPublicSessionId: randomUUID(),
    });
    const session = issueConverseChatSession(this.dependencies.publicChatSessionSecret, {
      workspaceId: grant.workspaceId,
      agentId: grant.agentId,
      publicSessionId,
      grantId: grant.id,
      grantVersion: version,
    });
    await this.dependencies.audit?.recordExchangeSucceeded({
      grant,
      publicSessionId: session.publicSessionId,
      clientName: input.client?.name,
    });

    return {
      ...this.toPrincipal(session),
      sessionToken: session.token,
      expiresAt: session.expiresAt,
      agent: {
        id: agent.id,
        name: agent.name,
      },
    };
  }

  async validate(sessionToken: string | undefined): Promise<AgentConversePrincipal> {
    const payload = verifyConverseChatSession(sessionToken, this.dependencies.publicChatSessionSecret);
    if (!payload) {
      await this.dependencies.audit?.recordValidationDenied({ reason: "invalid_session" });
      throw converseError(401, "invalid_session", "Invalid MCP converse session.");
    }

    const grant = await this.dependencies.accessGrantService.findGrantById(payload.grantId);
    if (!grant) {
      await this.dependencies.audit?.recordValidationDenied({ payload, reason: "grant_revoked" });
      throw converseError(403, "grant_revoked", "MCP converse grant is no longer active.");
    }
    if (grant.principalKind !== "agent-api" || grant.channel !== "mcp-converse") {
      await this.dependencies.audit?.recordValidationDenied({ grant, payload, reason: "grant_channel_not_allowed" });
      throw converseError(403, "grant_channel_not_allowed", "MCP converse grant channel is not allowed.");
    }
    if (grant.workspaceId !== payload.workspaceId || grant.agentId !== payload.agentId) {
      await this.dependencies.audit?.recordValidationDenied({ grant, payload, reason: "grant_rotated" });
      throw converseError(403, "grant_rotated", "MCP converse grant changed.");
    }

    const evaluation = this.dependencies.accessGrantService.evaluate(grant, {});
    if (!evaluation.allowed) {
      await this.dependencies.accessGrantService.recordAuthFailure({
        grant,
        reason: evaluation.reason,
        surface: "mcp-converse",
      });
      await this.dependencies.audit?.recordValidationDenied({ grant, payload, reason: denialCode(evaluation) });
      throw converseError(403, denialCode(evaluation), "MCP converse grant is no longer active.");
    }

    if (payload.grantVersion !== grantVersion(grant)) {
      await this.dependencies.audit?.recordValidationDenied({ grant, payload, reason: "grant_rotated" });
      throw converseError(403, "grant_rotated", "MCP converse grant changed.");
    }

    return this.toPrincipal(payload);
  }

  recordSuccessfulUse(principal: Pick<AgentConversePrincipal, "grantId">): void {
    try {
      void Promise.resolve(this.dependencies.accessGrantService.touchGrant(principal.grantId)).catch(() => undefined);
    } catch {
      // Last-use metadata must never change the completed request outcome.
    }
  }

  permissions(): string[] {
    return [...AGENT_CONVERSE_PERMISSIONS];
  }

  private toPrincipal(payload: ConverseChatSessionPayload): AgentConversePrincipal {
    return {
      workspaceId: payload.workspaceId,
      agentId: payload.agentId,
      publicSessionId: payload.publicSessionId,
      grantId: payload.grantId,
      grantVersion: payload.grantVersion,
      sourceChannel: "mcp",
      sourceOrigin: null,
      authPrincipal: {
        type: "public_chat_session",
        role: "agent",
        workspaceId: payload.workspaceId,
        agentId: payload.agentId,
        publicSessionId: payload.publicSessionId,
      },
    };
  }
}
