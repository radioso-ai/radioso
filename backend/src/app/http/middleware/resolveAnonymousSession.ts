import { createHmac, randomUUID, timingSafeEqual } from "node:crypto";
import type { NextFunction, Request, RequestHandler, Response } from "express";
import { z } from "zod";

import { notFound } from "../../../shared/domain/errors.js";
import type { WorkspaceRepositoryPort } from "../../../db/repositories/workspaceRepository.js";
import {
  isAssistantBootstrapActive,
  resolveAssistantDisplayName,
} from "../../../modules/settings/domain/assistantBootstrapSettings.js";
import { verifyPublicChatSession } from "../../../modules/settings/domain/publicChatSession.js";

const COOKIE_MAX_AGE_SECONDS = 30 * 24 * 60 * 60; // 30 days
export const ANONYMOUS_SESSION_HEADER = "x-radioso-anonymous-session";
export const PUBLIC_CHAT_SESSION_HEADER = "x-radioso-public-session";
export const PUBLIC_CHAT_SESSION_ID_HEADER = "x-radioso-public-session-id";
const ANONYMOUS_RATE_LIMIT_COOKIE_PREFIX = "anon_rate_limit_";
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
  if (forwardedHost) {
    return !isLoopbackHost(forwardedHost);
  }

  return !isLoopbackHost(req.get("host"));
};

const signRateLimitId = (secret: string, id: string) =>
  createHmac("sha256", secret).update(id).digest("base64url");

const issueAnonymousRateLimitCookie = (secret: string, id: string) => `${id}.${signRateLimitId(secret, id)}`;

const verifyAnonymousRateLimitCookie = (value: string | undefined, secret: string | undefined) => {
  if (!value || !secret) {
    return null;
  }

  const [id, providedSignature] = value.split(".");
  if (!id || !providedSignature) {
    return null;
  }

  const expectedSignature = signRateLimitId(secret, id);
  const providedBuffer = Buffer.from(providedSignature);
  const expectedBuffer = Buffer.from(expectedSignature);
  if (
    providedBuffer.length !== expectedBuffer.length ||
    !timingSafeEqual(providedBuffer, expectedBuffer)
  ) {
    return null;
  }

  return id;
};

export const resolveAnonymousSession = (
  workspaceRepository: WorkspaceRepositoryPort,
  publicChatSessionSecret: string | undefined,
  anonymousRateLimitCookieSecret: string | undefined = publicChatSessionSecret,
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
      const publicSession = verifyPublicChatSession(req.get(PUBLIC_CHAT_SESSION_HEADER), publicChatSessionSecret);
      const hasValidPublicSession =
        Boolean(publicSession) &&
        publicSession?.workspaceId === workspace?.id &&
        publicSession?.publicChatToken === token;

      if (!workspace || !hasValidPublicSession) {
        next(notFound("Not found"));
        return;
      }

      const cookieName = `anon_session_${workspace.id}`;
      const rateLimitCookieName = `${ANONYMOUS_RATE_LIMIT_COOKIE_PREFIX}${workspace.id}`;
      const rateLimitIdFromCookie = verifyAnonymousRateLimitCookie(
        req.cookies?.[rateLimitCookieName] as string | undefined,
        anonymousRateLimitCookieSecret,
      );
      const rateLimitId = rateLimitIdFromCookie ?? randomUUID();
      const sessionId = publicSession.publicSessionId;

      res.cookie(cookieName, sessionId, {
        httpOnly: true,
        secure: shouldUseSecureAnonymousCookie(req),
        sameSite: "lax",
        maxAge: COOKIE_MAX_AGE_SECONDS * 1000,
      });
      if (anonymousRateLimitCookieSecret) {
        res.cookie(rateLimitCookieName, issueAnonymousRateLimitCookie(anonymousRateLimitCookieSecret, rateLimitId), {
          httpOnly: true,
          secure: shouldUseSecureAnonymousCookie(req),
          sameSite: "lax",
          maxAge: COOKIE_MAX_AGE_SECONDS * 1000,
        });
      }
      res.setHeader(ANONYMOUS_SESSION_HEADER, sessionId);
      res.setHeader(PUBLIC_CHAT_SESSION_ID_HEADER, sessionId);

      res.locals.workspaceId = workspace.id;
      res.locals.workspaceName = resolveAssistantDisplayName({
        assistantName: workspace.assistantName,
        workspaceName: workspace.name,
      });
      res.locals.anonymousSessionId = sessionId;
      res.locals.anonymousRateLimitId = rateLimitId;
      res.locals.anonymousRateLimitIdFromCookie = Boolean(rateLimitIdFromCookie);
      res.locals.anonymousRateLimit = workspace.anonymousRateLimit;
      res.locals.sourceChannel = publicSession?.sourceChannel ?? "anonymous";
      res.locals.sourceOrigin = publicSession?.sourceOrigin ?? null;
      res.locals.assistantBootstrapActive = isAssistantBootstrapActive(workspace);
      next();
    } catch (error) {
      next(error);
    }
  };
};
