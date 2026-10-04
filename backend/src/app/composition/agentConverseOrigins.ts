import type { AgentRepositoryPort } from "../../db/repositories/agentRepository.js";
import type { AccessGrant, AccessGrantService } from "../../modules/accessGrants/public.js";
import { converseGrantVersion, denialCode } from "../../modules/settings/composition.js";
import type {
  AgentConverseOriginContext,
  AgentConverseOriginRevalidation,
  AgentConverseOriginVerifier,
  AgentConverseWalkInIssuerPort,
  AgentConverseWalkInObserver,
  AgentConverseWalkInOpening,
} from "../../modules/settings/contracts/agentConverseSession.js";
import type { ConverseChatSessionPayload } from "../../modules/settings/contracts/publicChatSession.js";
import type { AppLogger } from "../../shared/observability/logger.js";
import type { MetricsRegistry } from "../../shared/observability/metrics/metricsRegistry.js";

const WALK_IN_EXCHANGES_TOTAL = "mcp_converse_walk_in_exchanges_total";

interface ConverseOriginAuditPort {
  recordValidationDenied(input: {
    grant?: AccessGrant | null;
    payload?: ConverseChatSessionPayload | null;
    reason: string;
  }): Promise<void>;
}

const refused = (code: string, message: string, statusCode: 401 | 403 = 403): AgentConverseOriginRevalidation =>
  ({ ok: false, statusCode, code, message });

/** Walk-in access needs a live agent whose door is open and whose id has not moved on. */
type WalkInAgent = Pick<AgentRepositoryPort, "findByPublicId">;

/**
 * The credential door's re-check, unchanged: the grant still exists, still belongs to this
 * channel and this agent, still evaluates as allowed, and is still the same token version.
 */
const createGrantConverseOriginVerifier = (dependencies: {
  accessGrantService: Pick<AccessGrantService, "findGrantById" | "evaluate" | "recordAuthFailure">;
  audit?: ConverseOriginAuditPort;
}): AgentConverseOriginVerifier => ({
  async revalidate(input: AgentConverseOriginContext): Promise<AgentConverseOriginRevalidation> {
    if (input.origin.kind !== "grant") {
      return refused("invalid_session", "Invalid MCP converse session.", 401);
    }
    const { grantId, grantVersion } = input.origin;
    const grant = await dependencies.accessGrantService.findGrantById(grantId);
    if (!grant) {
      await dependencies.audit?.recordValidationDenied({ reason: "grant_revoked" });
      return refused("grant_revoked", "MCP converse grant is no longer active.");
    }
    if (grant.principalKind !== "agent-api" || grant.channel !== "mcp-converse") {
      await dependencies.audit?.recordValidationDenied({ grant, reason: "grant_channel_not_allowed" });
      return refused("grant_channel_not_allowed", "MCP converse grant channel is not allowed.");
    }
    if (grant.workspaceId !== input.workspaceId || grant.agentId !== input.agentId) {
      await dependencies.audit?.recordValidationDenied({ grant, reason: "grant_rotated" });
      return refused("grant_rotated", "MCP converse grant changed.");
    }

    const evaluation = dependencies.accessGrantService.evaluate(grant, {});
    if (!evaluation.allowed) {
      await dependencies.accessGrantService.recordAuthFailure({
        grant,
        reason: evaluation.reason,
        surface: "mcp-converse",
      });
      await dependencies.audit?.recordValidationDenied({ grant, reason: denialCode(evaluation) });
      return refused(denialCode(evaluation), "MCP converse grant is no longer active.");
    }

    if (grantVersion !== converseGrantVersion(grant)) {
      await dependencies.audit?.recordValidationDenied({ grant, reason: "grant_rotated" });
      return refused("grant_rotated", "MCP converse grant changed.");
    }

    return { ok: true };
  },
});

/**
 * The credential-free door's re-check. Comparing the session's public id against the
 * agent's current one is the whole invalidation mechanism (FR-031a): rotating the id or
 * closing the door ends every live walk-in session on its next request, with no sweep and
 * no session table to expire.
 */
const createWalkInConverseOriginVerifier = (dependencies: {
  agentRepository: WalkInAgent;
}): AgentConverseOriginVerifier => ({
  async revalidate(input: AgentConverseOriginContext): Promise<AgentConverseOriginRevalidation> {
    if (input.origin.kind !== "walk_in") {
      return refused("invalid_session", "Invalid MCP converse session.", 401);
    }
    const agent = await dependencies.agentRepository.findByPublicId(input.origin.publicId);
    if (
      !agent
      || !agent.publicAgentAccessEnabled
      || agent.publicId !== input.origin.publicId
      || agent.id !== input.agentId
      || agent.workspaceId !== input.workspaceId
    ) {
      return refused("walk_in_revoked", "Walk-in access for this agent is no longer available.");
    }
    return { ok: true };
  },
});

/** Routes an origin to the adapter that knows it; nothing upstream switches on the kind. */
export const createAgentConverseOriginVerifier = (dependencies: {
  accessGrantService: Pick<AccessGrantService, "findGrantById" | "evaluate" | "recordAuthFailure">;
  agentRepository: WalkInAgent;
  audit?: ConverseOriginAuditPort;
}): AgentConverseOriginVerifier => {
  const grant = createGrantConverseOriginVerifier(dependencies);
  const walkIn = createWalkInConverseOriginVerifier(dependencies);
  return {
    revalidate: (input) => (input.origin.kind === "grant" ? grant : walkIn).revalidate(input),
  };
};

export const createAgentConverseWalkInIssuer = (dependencies: {
  agentRepository: WalkInAgent;
}): AgentConverseWalkInIssuerPort => ({
  async open(publicId: string): Promise<AgentConverseWalkInOpening> {
    const agent = await dependencies.agentRepository.findByPublicId(publicId);
    if (!agent || agent.publicId !== publicId) {
      return { ok: false, reason: "unknown" };
    }
    if (!agent.publicAgentAccessEnabled) {
      return { ok: false, reason: "disabled" };
    }
    return { ok: true, workspaceId: agent.workspaceId, agentId: agent.id, agentName: agent.name };
  },
});

/**
 * Counts walk-in exchange outcomes and names refusals in the log by source digest and
 * agent. A public id is a routing key an operator can rotate; it stays out of both.
 */
export const createAgentConverseWalkInObserver = (dependencies: {
  metrics?: Pick<MetricsRegistry, "incrementCounter"> | null;
  logger?: Pick<AppLogger, "info">;
}): AgentConverseWalkInObserver => ({
  record({ outcome, agentId, sourceDigest }) {
    dependencies.metrics?.incrementCounter(WALK_IN_EXCHANGES_TOTAL, {
      help: "MCP converse walk-in session exchanges by outcome.",
      labels: { outcome },
    });
    if (outcome === "issued") {
      return;
    }
    dependencies.logger?.info(
      { outcome, agentId: agentId ?? null, sourceDigest: sourceDigest ?? null },
      "MCP converse walk-in exchange refused",
    );
  },
});
