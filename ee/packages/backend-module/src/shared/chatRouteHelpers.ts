import { createHmac, timingSafeEqual } from "node:crypto";

import type { RequestHandler } from "express";
import { z } from "zod";

import type { ApplicationRouteMount } from "../radiosoModuleTypes.js";

type RouteDependencies = Parameters<ApplicationRouteMount["createRouter"]>[0];

const WORKSPACE_HEADER = "x-workspace-id";
const PUBLIC_CHAT_SESSION_HEADER = "x-radioso-public-session";
const BEARER_PREFIX = "Bearer ";

export const parseBody = <T>(schema: z.ZodType<T>, value: unknown): T => {
  const parsed = schema.safeParse(value);
  if (parsed.success) {
    return parsed.data;
  }

  throw {
    statusCode: 400,
    code: "bad_request",
    message: "Invalid request body",
    details: parsed.error.flatten(),
  };
};

export const parseParams = <T>(schema: z.ZodType<T>, value: unknown): T => {
  const parsed = schema.safeParse(value);
  if (parsed.success) {
    return parsed.data;
  }

  throw {
    statusCode: 400,
    code: "bad_request",
    message: "Invalid request params",
    details: parsed.error.flatten(),
  };
};

export const unauthorized = () => ({
  statusCode: 401,
  code: "unauthorized",
  message: "Unauthorized",
});

export const notFound = (message = "Not found") => ({
  statusCode: 404,
  code: "not_found",
  message,
});

export const requireWorkspaceSession = (dependencies: RouteDependencies): RequestHandler => async (req, res, next) => {
  try {
    const sessionToken = req.cookies?.[dependencies.env.SESSION_COOKIE_NAME];
    if (typeof sessionToken === "string" && sessionToken) {
      try {
        const session = await dependencies.authService.authenticateSession(sessionToken);
        await dependencies.accountAccessService.requireActiveMembership(session.accountId, session.userId);
        const resolved = await dependencies.workspaceSessionService.resolve({
          accountId: session.accountId,
          workspaceId: req.header(WORKSPACE_HEADER) ?? undefined,
        });
        res.locals.accountId = resolved.accountId;
        res.locals.workspaceId = resolved.workspaceId;
        res.locals.userId = session.userId;
        res.locals.authType = "authenticated_user";
        next();
        return;
      } catch {
        // Fall through to bearer auth.
      }
    }

    const authorization = req.header("authorization");
    const bearerToken = authorization?.startsWith(BEARER_PREFIX)
      ? authorization.slice(BEARER_PREFIX.length).trim()
      : null;
    if (!bearerToken) {
      throw unauthorized();
    }

    const auth = await dependencies.authService.authenticateApiToken(bearerToken);
    res.locals.accountId = auth.accountId;
    res.locals.workspaceId = auth.workspaceId;
    res.locals.authType = "api_token";
    next();
  } catch (error) {
    next(error);
  }
};

const signPayload = (secret: string, payload: string) =>
  createHmac("sha256", secret).update(payload).digest("base64url");

export const verifyPublicChatSession = (token: string | undefined, secret: string | undefined) => {
  if (!token || !secret) {
    return null;
  }

  const [encodedPayload, providedSignature] = token.split(".");
  if (!encodedPayload || !providedSignature) {
    return null;
  }

  const expectedSignature = signPayload(secret, encodedPayload);
  const providedBuffer = Buffer.from(providedSignature);
  const expectedBuffer = Buffer.from(expectedSignature);
  if (
    providedBuffer.length !== expectedBuffer.length ||
    !timingSafeEqual(providedBuffer, expectedBuffer)
  ) {
    return null;
  }

  try {
    const payload = JSON.parse(Buffer.from(encodedPayload, "base64url").toString("utf8")) as {
      workspaceId?: unknown;
      publicChatToken?: unknown;
      publicSessionId?: unknown;
      sourceChannel?: unknown;
      sourceOrigin?: unknown;
      expiresAt?: unknown;
    };
    if (
      typeof payload.workspaceId !== "string" ||
      typeof payload.publicChatToken !== "string" ||
      typeof payload.publicSessionId !== "string" ||
      typeof payload.expiresAt !== "string" ||
      Date.parse(payload.expiresAt) <= Date.now()
    ) {
      return null;
    }
    return {
      workspaceId: payload.workspaceId,
      publicChatToken: payload.publicChatToken,
      publicSessionId: payload.publicSessionId,
      sourceChannel: typeof payload.sourceChannel === "string" ? payload.sourceChannel : null,
      sourceOrigin: typeof payload.sourceOrigin === "string" ? payload.sourceOrigin : null,
    };
  } catch {
    return null;
  }
};

export const requirePublicChatSession = (dependencies: RouteDependencies): RequestHandler => async (req, res, next) => {
  try {
    const token = String(req.params.token ?? "");
    const workspace = await dependencies.workspaceRepository.findByAnonymousChatToken(token);
    const publicSession = verifyPublicChatSession(
      req.header(PUBLIC_CHAT_SESSION_HEADER),
      dependencies.env.PUBLIC_CHAT_SESSION_SECRET,
    );
    if (!workspace || !publicSession || publicSession.workspaceId !== workspace.id || publicSession.publicChatToken !== token) {
      throw notFound();
    }

    res.locals.workspaceId = workspace.id;
    res.locals.anonymousSessionId = publicSession.publicSessionId;
    res.locals.sourceChannel = publicSession.sourceChannel ?? "anonymous";
    res.locals.sourceOrigin = publicSession.sourceOrigin;
    next();
  } catch (error) {
    next(error);
  }
};
