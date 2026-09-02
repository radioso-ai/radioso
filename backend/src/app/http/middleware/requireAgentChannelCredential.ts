import type { RequestHandler } from "express";

import type { AppDependencies } from "../../server/types.js";
import type { AccessGrant } from "../../../modules/accessGrants/public.js";
import { unauthorized } from "../../../shared/domain/errors.js";
import { extractBearerToken } from "./requireMcpConverseSession.js";

export interface AgentChannelCredentialLocals {
  agentChannelGrant: AccessGrant;
  workspaceId: string;
}

type AgentChannelCredentialDependencies = Pick<AppDependencies, "accessGrantService" | "agentRepository">;

const invalidCredential = () => unauthorized("Invalid agent channel credential.");

export const requireRestAgentChannelCredential = (
  dependencies: AgentChannelCredentialDependencies,
): RequestHandler => async (req, res, next) => {
  try {
    const token = extractBearerToken(req.header("authorization"));
    if (!token) throw invalidCredential();

    const grant = await dependencies.accessGrantService.resolveAgentChannelGrant(token, "agent-api");
    if (!grant || grant.agentId !== req.params.agentId) {
      await dependencies.accessGrantService.recordAuthFailure({
        grant,
        reason: grant ? "agent_mismatch" : "invalid_credential",
        surface: "agent-api",
      });
      throw invalidCredential();
    }

    const evaluation = dependencies.accessGrantService.evaluate(grant, {});
    if (!evaluation.allowed) {
      await dependencies.accessGrantService.recordAuthFailure({
        grant,
        reason: evaluation.reason,
        surface: "agent-api",
      });
      throw invalidCredential();
    }

    const agent = await dependencies.agentRepository.findByIdAndWorkspaceId(grant.agentId, grant.workspaceId);
    if (!agent) {
      await dependencies.accessGrantService.recordAuthFailure({
        grant,
        reason: "agent_unavailable",
        surface: "agent-api",
      });
      throw invalidCredential();
    }

    res.locals.workspaceId = grant.workspaceId;
    res.locals.agentChannelGrant = grant;
    next();
  } catch (error) {
    next(error);
  }
};
