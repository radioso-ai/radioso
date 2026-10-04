import { randomUUID } from "node:crypto";

import type { AccessGrant, AccessGrantEvaluation, AccessGrantService } from "../../accessGrants/public.js";
import { converseGrantVersion } from "../domain/converseGrantVersion.js";
import type {
  AgentConverseAgentLookupPort,
  AgentConverseOrigin,
  AgentConverseSessionMappingPort,
  AgentConverseWalkInIssuerPort,
  AgentConverseWalkInObserver,
} from "../contracts/agentConverseSession.js";

/** Audit surface the two issue paths share; the walk-in path has no grant to name. */
interface ConverseExchangeAuditPort {
  recordExchangeDenied(input: { grant?: AccessGrant | null; reason: string; clientName?: string | null }): Promise<void>;
  recordExchangeSucceeded(input: { grant: AccessGrant; publicSessionId: string; clientName?: string | null }): Promise<void>;
}

/** What an issued origin contributes to the session about to be signed. */
export interface ConverseExchangeOrigin {
  workspaceId: string;
  agentId: string;
  publicSessionId: string;
  origin: AgentConverseOrigin;
  agent: { id: string; name: string };
}

export const denialCode = (evaluation: AccessGrantEvaluation): string => {
  if (evaluation.allowed) {
    return "allowed";
  }
  if (evaluation.reason === "revoked") {
    return "grant_revoked";
  }
  return `grant_${evaluation.reason}`;
};

interface GrantExchangeDependencies {
  accessGrantService: Pick<
    AccessGrantService,
    "resolveConverseGrant" | "resolvePublicLaunchGrant" | "evaluate" | "recordAuthFailure"
  >;
  agentLookup: AgentConverseAgentLookupPort;
  sessionMapping: AgentConverseSessionMappingPort;
  audit?: ConverseExchangeAuditPort;
  refuse: (statusCode: number, code: string, message: string) => Error;
}

/**
 * The credential door. A grant keeps one stable conversation across exchanges, which is
 * why the public session id comes from the mapping table rather than being minted here.
 */
export const openGrantExchangeOrigin = async (
  dependencies: GrantExchangeDependencies,
  input: { launchToken: string; client?: { name?: string } },
): Promise<ConverseExchangeOrigin> => {
  const clientName = input.client?.name;
  const wrongPublicGrant = await dependencies.accessGrantService.resolvePublicLaunchGrant(input.launchToken);
  if (wrongPublicGrant) {
    await dependencies.audit?.recordExchangeDenied({
      grant: wrongPublicGrant,
      reason: "grant_channel_not_allowed",
      clientName,
    });
    throw dependencies.refuse(403, "grant_channel_not_allowed", "This launch token is not valid for MCP converse.");
  }

  const grant = await dependencies.accessGrantService.resolveConverseGrant(input.launchToken);
  if (!grant) {
    await dependencies.audit?.recordExchangeDenied({ reason: "invalid_converse_grant", clientName });
    throw dependencies.refuse(401, "invalid_converse_grant", "Invalid MCP converse grant.");
  }

  const evaluation = dependencies.accessGrantService.evaluate(grant, {});
  if (!evaluation.allowed) {
    await dependencies.accessGrantService.recordAuthFailure({
      grant,
      reason: evaluation.reason,
      surface: "mcp-converse",
    });
    await dependencies.audit?.recordExchangeDenied({ grant, reason: denialCode(evaluation), clientName });
    throw dependencies.refuse(403, denialCode(evaluation), "MCP converse grant is not active.");
  }

  const agent = await dependencies.agentLookup.findByIdAndWorkspaceId(grant.agentId, grant.workspaceId);
  if (!agent) {
    await dependencies.audit?.recordExchangeDenied({ grant, reason: "agent_unavailable", clientName });
    throw dependencies.refuse(403, "agent_unavailable", "The bound agent is unavailable.");
  }

  const grantVersion = converseGrantVersion(grant);
  const publicSessionId = await dependencies.sessionMapping.resolvePublicSessionId({
    grantId: grant.id,
    grantVersion,
    proposedPublicSessionId: randomUUID(),
  });
  await dependencies.audit?.recordExchangeSucceeded({ grant, publicSessionId, clientName });

  return {
    workspaceId: grant.workspaceId,
    agentId: grant.agentId,
    publicSessionId,
    origin: { kind: "grant", grantId: grant.id, grantVersion },
    agent: { id: agent.id, name: agent.name },
  };
};

interface WalkInExchangeDependencies {
  walkInIssuer: AgentConverseWalkInIssuerPort;
  observer?: AgentConverseWalkInObserver;
  refuse: (statusCode: number, code: string, message: string) => Error;
}

/**
 * The credential-free door. An unknown public id and a closed one are told apart for the
 * outcome counter only — the caller gets one refusal either way, so a probe learns nothing
 * about which agents exist.
 */
export const openWalkInExchangeOrigin = async (
  dependencies: WalkInExchangeDependencies,
  input: { publicId: string; sourceDigest?: string },
): Promise<ConverseExchangeOrigin> => {
  const opening = await dependencies.walkInIssuer.open(input.publicId);
  if (!opening.ok) {
    dependencies.observer?.record({ outcome: opening.reason, sourceDigest: input.sourceDigest ?? null });
    throw dependencies.refuse(403, "walk_in_unavailable", "This agent does not accept walk-in connections.");
  }

  dependencies.observer?.record({
    outcome: "issued",
    agentId: opening.agentId,
    sourceDigest: input.sourceDigest ?? null,
  });

  return {
    workspaceId: opening.workspaceId,
    agentId: opening.agentId,
    // A fresh conversation per exchange (FR-031): nothing is persisted, so nothing has to
    // be expired when the public id rotates.
    publicSessionId: randomUUID(),
    origin: { kind: "walk_in", publicId: input.publicId },
    agent: { id: opening.agentId, name: opening.agentName },
  };
};
