import { randomUUID } from "node:crypto";
import type { NextFunction, Request, RequestHandler, Response } from "express";
import { z } from "zod";

import { notFound } from "../../../shared/domain/errors.js";
import type { WorkspaceRepositoryPort } from "../../../db/repositories/workspaceRepository.js";
import { isAssistantBootstrapActive } from "../../../modules/settings/domain/assistantBootstrapSettings.js";
import { verifyWebsiteEmbedSession } from "../../../modules/settings/domain/websiteEmbedSession.js";

const COOKIE_MAX_AGE_SECONDS = 30 * 24 * 60 * 60; // 30 days
export const ANONYMOUS_SESSION_HEADER = "x-radioso-anonymous-session";
export const WEBSITE_EMBED_SESSION_HEADER = "x-radioso-embed-session";
const anonymousTokenParamsSchema = z.object({
  token: z.string().min(1),
});

const isLoopbackHost = (host: string | undefined) => {
  if (!host) {
    return false;
  }

  const normalizedHost = host.trim().toLowerCase();
  const withoutPort = normalizedHost.startsWith("[")
    ? normalizedHost.slice(0, normalizedHost.indexOf("]") + 1)
    : normalizedHost.split(":")[0];

  return withoutPort === "localhost" || withoutPort === "127.0.0.1" || withoutPort === "[::1]";
};

export const shouldUseSecureAnonymousCookie = (req: Request) => {
  if (process.env.NODE_ENV !== "production") {
    return false;
  }

  const forwardedHost = req.get("x-forwarded-host");
  const host = req.get("host");

  if (isLoopbackHost(forwardedHost) || isLoopbackHost(host)) {
    return false;
  }

  return true;
};

export const resolveAnonymousSession = (
  workspaceRepository: WorkspaceRepositoryPort,
  sessionSecret: string,
): RequestHandler => {
  return async (req: Request, res: Response, next: NextFunction) => {
    try {
      const parsedParams = anonymousTokenParamsSchema.safeParse(req.params);

      if (!parsedParams.success) {
        next(notFound("Not found"));
        return;
      }

      const { token } = parsedParams.data;
      const workspace = await workspaceRepository.findByAnonymousChatToken(token);
      const embedSession = verifyWebsiteEmbedSession(req.get(WEBSITE_EMBED_SESSION_HEADER), sessionSecret);
      const hasValidEmbedSession =
        Boolean(workspace?.websiteEmbedEnabled) &&
        Boolean(embedSession) &&
        embedSession?.workspaceId === workspace?.id &&
        embedSession?.publicChatToken === token;

      if (!workspace || (!workspace.anonymousChatEnabled && !hasValidEmbedSession)) {
        next(notFound("Not found"));
        return;
      }

      const cookieName = `anon_session_${workspace.id}`;
      const headerSessionId = req.get(ANONYMOUS_SESSION_HEADER);
      const parsedHeaderSessionId = headerSessionId && z.string().uuid().safeParse(headerSessionId).success
        ? headerSessionId
        : undefined;
      let sessionId =
        (hasValidEmbedSession ? embedSession?.anonymousSessionId : undefined) ??
        parsedHeaderSessionId ??
        (req.cookies?.[cookieName] as string | undefined);

      if (!sessionId) {
        sessionId = randomUUID();
      }

      res.cookie(cookieName, sessionId, {
        httpOnly: true,
        secure: shouldUseSecureAnonymousCookie(req),
        sameSite: "lax",
        maxAge: COOKIE_MAX_AGE_SECONDS * 1000,
      });
      res.setHeader(ANONYMOUS_SESSION_HEADER, sessionId);

      res.locals.workspaceId = workspace.id;
      res.locals.workspaceName = workspace.name;
      res.locals.anonymousSessionId = sessionId;
      res.locals.anonymousRateLimit = workspace.anonymousRateLimit;
      res.locals.assistantBootstrapActive = isAssistantBootstrapActive(workspace);
      next();
    } catch (error) {
      next(error);
    }
  };
};
