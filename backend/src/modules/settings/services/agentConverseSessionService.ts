import { AppError, serviceUnavailable } from "../../../shared/domain/errors.js";
import type { AccessGrant } from "../../accessGrants/public.js";
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
  AgentConverseOriginVerifier,
  AgentConverseSessionExchangeInput,
  AgentConverseSessionExchangeResult,
  AgentConverseSessionMappingPort,
  AgentConverseWalkInIssuerPort,
  AgentConverseWalkInObserver,
} from "../contracts/agentConverseSession.js";
import {
  openGrantExchangeOrigin,
  openWalkInExchangeOrigin,
  type ConverseExchangeOrigin,
} from "./converseExchangeOrigins.js";

interface AgentConverseAuditPort {
  recordExchangeDenied(input: { grant?: AccessGrant | null; reason: string; clientName?: string | null }): Promise<void>;
  recordExchangeSucceeded(input: { grant: AccessGrant; publicSessionId: string; clientName?: string | null }): Promise<void>;
  recordValidationDenied(input: { grant?: AccessGrant | null; payload?: ConverseChatSessionPayload | null; reason: string }): Promise<void>;
}

const converseError = (statusCode: number, code: string, message: string) =>
  new AppError(statusCode, statusCode === 401 ? "unauthorized" : "forbidden", message, { code });

export class AgentConverseSessionService {
  constructor(
    private readonly dependencies: {
      accessGrantService: Pick<
        AccessGrantService,
        "resolveConverseGrant" | "resolvePublicLaunchGrant" | "evaluate" | "touchGrant" | "recordAuthFailure"
      >;
      agentLookup: AgentConverseAgentLookupPort;
      sessionMapping: AgentConverseSessionMappingPort;
      originVerifier: AgentConverseOriginVerifier;
      walkInIssuer?: AgentConverseWalkInIssuerPort;
      walkInObserver?: AgentConverseWalkInObserver;
      publicChatSessionSecret?: string;
      audit?: AgentConverseAuditPort;
    },
  ) {}

  async exchange(input: AgentConverseSessionExchangeInput): Promise<AgentConverseSessionExchangeResult> {
    const secret = this.dependencies.publicChatSessionSecret;
    if (!secret) {
      throw serviceUnavailable("MCP converse sessions are not configured.", {
        missingEnv: "PUBLIC_CHAT_SESSION_SECRET",
      });
    }

    const issued = "publicId" in input
      ? await this.openWalkIn(input.publicId, input.sourceDigest)
      : await openGrantExchangeOrigin(
        {
          accessGrantService: this.dependencies.accessGrantService,
          agentLookup: this.dependencies.agentLookup,
          sessionMapping: this.dependencies.sessionMapping,
          audit: this.dependencies.audit,
          refuse: converseError,
        },
        { launchToken: input.launchToken, client: input.client },
      );

    const session = issueConverseChatSession(secret, {
      workspaceId: issued.workspaceId,
      agentId: issued.agentId,
      publicSessionId: issued.publicSessionId,
      origin: issued.origin,
    });

    return {
      ...this.toPrincipal(session),
      sessionToken: session.token,
      expiresAt: session.expiresAt,
      agent: issued.agent,
    };
  }

  async validate(sessionToken: string | undefined): Promise<AgentConversePrincipal> {
    const payload = verifyConverseChatSession(sessionToken, this.dependencies.publicChatSessionSecret);
    if (!payload) {
      await this.dependencies.audit?.recordValidationDenied({ reason: "invalid_session" });
      throw converseError(401, "invalid_session", "Invalid MCP converse session.");
    }

    // One call, whatever issued the session: the adapter behind this port owns both the
    // re-check and its own audit trail, so nothing here switches on the origin kind.
    const revalidation = await this.dependencies.originVerifier.revalidate({
      origin: payload.origin,
      workspaceId: payload.workspaceId,
      agentId: payload.agentId,
    });
    if (!revalidation.ok) {
      throw converseError(revalidation.statusCode, revalidation.code, revalidation.message);
    }

    return this.toPrincipal(payload);
  }

  recordSuccessfulUse(principal: Pick<AgentConversePrincipal, "origin">): void {
    if (principal.origin.kind !== "grant") {
      // A walk-in session has no credential whose last use could be recorded.
      return;
    }
    const { grantId } = principal.origin;
    try {
      void Promise.resolve(this.dependencies.accessGrantService.touchGrant(grantId)).catch(() => undefined);
    } catch {
      // Last-use metadata must never change the completed request outcome.
    }
  }

  permissions(): string[] {
    return [...AGENT_CONVERSE_PERMISSIONS];
  }

  private async openWalkIn(publicId: string, sourceDigest?: string): Promise<ConverseExchangeOrigin> {
    const walkInIssuer = this.dependencies.walkInIssuer;
    if (!walkInIssuer) {
      throw serviceUnavailable("MCP walk-in access is not configured.", {
        code: "mcp_converse_walk_in_unavailable",
      });
    }
    return openWalkInExchangeOrigin(
      { walkInIssuer, observer: this.dependencies.walkInObserver, refuse: converseError },
      { publicId, sourceDigest },
    );
  }

  private toPrincipal(payload: ConverseChatSessionPayload): AgentConversePrincipal {
    return {
      workspaceId: payload.workspaceId,
      agentId: payload.agentId,
      publicSessionId: payload.publicSessionId,
      origin: payload.origin,
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
