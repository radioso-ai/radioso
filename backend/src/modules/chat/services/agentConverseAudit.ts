import type { AuditService } from "../../audit/contracts/index.js";
import type { AccessGrant } from "../../accessGrants/public.js";
import type { ConverseChatSessionPayload } from "../../settings/contracts/publicChatSession.js";

type GrantAuditFields = Pick<AccessGrant, "id" | "workspaceId" | "agentId" | "principalKind" | "channel" | "role">;

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
    await this.auditService.record({
      workspaceId: input.grant?.workspaceId ?? input.payload?.workspaceId,
      eventType: "mcp_converse.session.validate",
      eventStatus: "failure",
      metadata: {
        ...grantMetadata(input.grant),
        reason: input.reason,
        payloadGrantId: input.payload?.grantId ?? null,
        publicSessionId: input.payload?.publicSessionId ?? null,
      },
    });
  }

  async recordWorkspaceTokenRejected() {
    await this.auditService.record({
      eventType: "mcp_converse.workspace_token",
      eventStatus: "failure",
      metadata: {
        reason: "workspace_token_rejected",
      },
    });
  }

  async recordAskOutcome(input: {
    workspaceId: string;
    agentId: string;
    grantId: string;
    publicSessionId: string;
    status: "success" | "failure";
    reason?: string | null;
  }) {
    await this.auditService.record({
      workspaceId: input.workspaceId,
      eventType: "mcp_converse.ask",
      eventStatus: input.status,
      metadata: {
        agentId: input.agentId,
        grantId: input.grantId,
        publicSessionId: input.publicSessionId,
        reason: input.reason ?? null,
      },
    });
  }
}
