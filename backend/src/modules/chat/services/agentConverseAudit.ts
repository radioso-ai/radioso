import type { AuditService } from "../../audit/contracts/index.js";
import type { AccessGrant } from "../../accessGrants/public.js";
import type { ConverseChatSessionPayload } from "../../settings/contracts/publicChatSession.js";
import type { AgentConverseChannel } from "../../settings/contracts/agentConverseSession.js";

type GrantAuditFields = Pick<AccessGrant, "id" | "workspaceId" | "agentId" | "principalKind" | "channel" | "role">;

/**
 * One turn event type per door, so the security feed says which one a turn came through. MCP's
 * predates the A2A door and keeps its name; anything filtering on it sees no change.
 */
const ASK_EVENT_TYPES: Record<AgentConverseChannel, string> = {
  mcp: "mcp_converse.ask",
  a2a: "a2a.ask",
};

const grantMetadata = (grant?: GrantAuditFields | null) => ({
  grantId: grant?.id ?? null,
  agentId: grant?.agentId ?? null,
  principalKind: grant?.principalKind ?? null,
  channel: grant?.channel ?? null,
  role: grant?.role ?? null,
});

export class AgentConverseAudit {
  constructor(private readonly auditService: Pick<AuditService, "record">) {}

  async recordExchangeSucceeded(input: { grant: GrantAuditFields; publicSessionId: string; clientName?: string | null }) {
    await this.auditService.record({
      workspaceId: input.grant.workspaceId,
      eventType: "mcp_converse.session.exchange",
      eventStatus: "success",
      metadata: {
        ...grantMetadata(input.grant),
        publicSessionId: input.publicSessionId,
        clientName: input.clientName ?? null,
      },
    });
  }

  async recordExchangeDenied(input: { grant?: GrantAuditFields | null; reason: string; clientName?: string | null }) {
    await this.auditService.record({
      workspaceId: input.grant?.workspaceId,
      eventType: "mcp_converse.session.exchange",
      eventStatus: "failure",
      metadata: {
        ...grantMetadata(input.grant),
        reason: input.reason,
        clientName: input.clientName ?? null,
      },
    });
  }

  async recordValidationDenied(input: { grant?: GrantAuditFields | null; payload?: ConverseChatSessionPayload | null; reason: string }) {
    const payloadOrigin = input.payload?.origin;
    await this.auditService.record({
      workspaceId: input.grant?.workspaceId ?? input.payload?.workspaceId,
      eventType: "mcp_converse.session.validate",
      eventStatus: "failure",
      metadata: {
        ...grantMetadata(input.grant),
        reason: input.reason,
        payloadGrantId: payloadOrigin?.kind === "grant" ? payloadOrigin.grantId : null,
        publicSessionId: input.payload?.publicSessionId ?? null,
      },
    });
  }

  async recordAskOutcome(input: {
    workspaceId: string;
    agentId: string;
    sourceChannel: AgentConverseChannel;
    grantId: string | null;
    publicSessionId: string;
    status: "success" | "failure";
    reason?: string | null;
  }) {
    await this.auditService.record({
      workspaceId: input.workspaceId,
      eventType: ASK_EVENT_TYPES[input.sourceChannel],
      eventStatus: input.status,
      metadata: {
        sourceChannel: input.sourceChannel,
        agentId: input.agentId,
        grantId: input.grantId,
        publicSessionId: input.publicSessionId,
        reason: input.reason ?? null,
      },
    });
  }

}
