import type { RequestHandler } from "express";

import { AppError } from "../../../shared/domain/errors.js";
import type { AgentConverseSessionPort } from "../../../modules/settings/contracts/agentConverseSession.js";
import type { AgentConversePrincipal } from "../../../modules/settings/contracts/agentConverseSession.js";

export interface McpConverseLocals {
  mcpConversePrincipal: AgentConversePrincipal;
}

export const extractBearerToken = (authorization: string | undefined): string | null => {
  if (!authorization || /[\u0000-\u001F\u007F-\u009F]/u.test(authorization)) {
    return null;
  }
  const match = /^Bearer\s+(.+)$/i.exec(authorization.trim());
  const token = match?.[1]?.trim();
  if (!token || token.length > 2048 || /[\u0000-\u001F\u007F-\u009F]/u.test(token)) {
    return null;
  }
  return token;
};

const invalidConverseSession = (): AppError => new AppError(
  401,
  "unauthorized",
  "MCP converse session is required.",
  { code: "invalid_session" },
);

export const requireMcpConverseSession = (
  sessionService: Pick<AgentConverseSessionPort, "validate">,
): RequestHandler => async (req, res, next) => {
  try {
    const token = extractBearerToken(req.header("authorization"));
    if (!token) {
      throw invalidConverseSession();
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
