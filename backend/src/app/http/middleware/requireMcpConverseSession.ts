import type { RequestHandler } from "express";

import { AppError } from "../../../shared/domain/errors.js";
import type { AgentConverseSessionPort } from "../../../modules/settings/contracts/agentConverseSession.js";
import type { AgentConversePrincipal } from "../../../modules/settings/contracts/agentConverseSession.js";

export interface McpConverseLocals {
  mcpConversePrincipal: AgentConversePrincipal;
}

// Matches only the "Bearer" scheme prefix; the token is taken by slicing rather than captured by
// a second, adjacent quantifier. `authorization` is a raw, pre-auth request header, and `\s`
// overlaps with what `.` matches (some `\s` characters, e.g. non-breaking/unicode spaces, aren't
// caught by the control-character guard below), so a `\s+(.+)$` capture is ambiguous to split and
// forces quadratic backtracking on a crafted header; a plain prefix match has no such ambiguity.
const BEARER_PREFIX_PATTERN = /^Bearer\s+/i;

export const extractBearerToken = (authorization: string | undefined): string | null => {
  if (!authorization || /[\u0000-\u001F\u007F-\u009F]/u.test(authorization)) {
    return null;
  }
  const trimmed = authorization.trim();
  const prefixMatch = BEARER_PREFIX_PATTERN.exec(trimmed);
  const token = prefixMatch ? trimmed.slice(prefixMatch[0].length).trim() : undefined;
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
