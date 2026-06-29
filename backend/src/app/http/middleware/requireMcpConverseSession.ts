import type { RequestHandler } from "express";

import { AppError } from "../../../shared/domain/errors.js";
import type { AgentConverseSessionService } from "../../../modules/settings/services/agentConverseSessionService.js";
import type { AgentConversePrincipal } from "../../../modules/settings/contracts/agentConverseSession.js";
import type { AgentConverseAudit } from "../../../modules/chat/services/agentConverseAudit.js";

export interface McpConverseLocals {
  mcpConversePrincipal: AgentConversePrincipal;
}

export const extractBearerToken = (authorization: string | undefined): string | null => {
  if (!authorization) {
    return null;
  }
  const match = /^Bearer\s+(.+)$/i.exec(authorization.trim());
  return match?.[1]?.trim() || null;
};

export const rejectWorkspaceBearerToken = (audit?: AgentConverseAudit): RequestHandler => async (req, _res, next) => {
  try {
    const token = extractBearerToken(req.header("authorization"));
    if (!token) {
      next();
      return;
    }

    if (!token.includes(".")) {
      await audit?.recordWorkspaceTokenRejected();
      throw new AppError(401, "unauthorized", "Workspace API tokens are not accepted on the MCP converse surface.", {
        code: "workspace_token_rejected",
      });
    }

    next();
  } catch (error) {
    next(error);
  }
};

export const requireMcpConverseSession = (
  sessionService: Pick<AgentConverseSessionService, "validate">,
  audit?: AgentConverseAudit,
): RequestHandler => async (req, res, next) => {
  try {
    const token = extractBearerToken(req.header("authorization"));
    if (!token) {
      throw new AppError(401, "unauthorized", "MCP converse session is required.", {
        code: "invalid_session",
      });
    }
    if (!token.includes(".")) {
      await audit?.recordWorkspaceTokenRejected();
      throw new AppError(401, "unauthorized", "Workspace API tokens are not accepted on the MCP converse surface.", {
        code: "workspace_token_rejected",
      });
    }

    const principal = await sessionService.validate(token);
    res.locals.mcpConversePrincipal = principal;
    res.locals.workspaceId = principal.workspaceId;
    res.locals.authPrincipal = principal.authPrincipal;
    next();
  } catch (error) {
    next(error);
  }
};
