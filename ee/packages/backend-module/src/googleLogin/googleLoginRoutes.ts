import { randomBytes } from "node:crypto";

import { Router, type Request } from "express";

import type { ApplicationRouteMount } from "../radiosoModuleTypes.js";
import {
  buildGoogleAuthorizationUrl,
  resolveGoogleIdentity,
  type GoogleOAuthConfig,
} from "./googleOAuthClient.js";

type RouteDependencies = Parameters<ApplicationRouteMount["createRouter"]>[0];
type FetchLike = typeof fetch;

const STATE_COOKIE = "radioso_google_login_state";
const RETURN_TO_COOKIE = "radioso_google_login_return_to";
const STATE_TTL_SECONDS = 600;
const PROVIDER = "google";

export interface GoogleLoginRouterOptions {
  /** Resolved OAuth config, or `null` when the feature is not configured. */
  config: GoogleOAuthConfig | null;
  /** Where to send the browser after a successful (or failed) sign-in. */
  successRedirect: string;
  authService: Pick<RouteDependencies["authService"], "federatedLogin">;
  auditService?: Pick<RouteDependencies["auditService"], "record">;
  fetchImpl?: FetchLike;
  generateState?: () => string;
}

interface CookieAttributes {
  httpOnly?: boolean;
  secure?: boolean;
  sameSite?: "Lax" | "Strict" | "None";
  path?: string;
  maxAge?: number;
}

const serializeCookie = (name: string, value: string, attributes: CookieAttributes): string => {
  const parts = [`${name}=${value}`, `Path=${attributes.path ?? "/"}`];
  if (attributes.maxAge !== undefined) {
    parts.push(`Max-Age=${attributes.maxAge}`);
  }
  if (attributes.httpOnly) {
    parts.push("HttpOnly");
  }
  if (attributes.secure) {
    parts.push("Secure");
  }
  if (attributes.sameSite) {
    parts.push(`SameSite=${attributes.sameSite}`);
  }
  return parts.join("; ");
};

const clearCookie = (name: string): string =>
  serializeCookie(name, "", { path: "/", maxAge: 0 });

// Reads a cookie from the parsed `req.cookies` (cookie-parser, used by the host
// app) and falls back to parsing the raw header so the router also works when
// mounted standalone.
const readCookie = (req: Request, name: string): string | undefined => {
  const parsed = (req as { cookies?: Record<string, unknown> }).cookies?.[name];
  if (typeof parsed === "string") {
    return parsed;
  }
  const header = req.headers.cookie;
  if (!header) {
    return undefined;
  }
  for (const pair of header.split(";")) {
    const index = pair.indexOf("=");
    if (index === -1) {
      continue;
    }
    if (pair.slice(0, index).trim() === name) {
      return decodeURIComponent(pair.slice(index + 1).trim());
    }
  }
  return undefined;
};

const withErrorParam = (target: string): string => {
  const separator = target.includes("?") ? "&" : "?";
  return `${target}${separator}error=google_login_failed`;
};

const resolveReturnPath = (candidate: unknown, successRedirect: string): string | undefined => {
  if (typeof candidate !== "string" || !candidate.startsWith("/")) {
    return undefined;
  }

  try {
    const successUrl = new URL(successRedirect);
    const targetUrl = new URL(candidate, successUrl);
    return targetUrl.origin === successUrl.origin
      ? `${targetUrl.pathname}${targetUrl.search}${targetUrl.hash}`
      : undefined;
  } catch {
    return undefined;
  }
};

const resolveReturnTarget = (candidate: unknown, successRedirect: string): string => {
  const returnPath = resolveReturnPath(candidate, successRedirect);
  return returnPath ? new URL(returnPath, successRedirect).toString() : successRedirect;
};

export const createGoogleLoginRouter = (options: GoogleLoginRouterOptions): Router => {
  const router = Router();
  const { config, successRedirect, authService } = options;
  const fetchImpl = options.fetchImpl ?? fetch;
  const generateState = options.generateState ?? (() => randomBytes(32).toString("hex"));
  const returnTargetFor = (req: Request): string =>
    resolveReturnTarget(readCookie(req, RETURN_TO_COOKIE), successRedirect);

  const recordFailure = async (reason: string): Promise<void> => {
    try {
      await options.auditService?.record({
        eventType: "auth.federated_login",
        eventStatus: "failure",
        metadata: { provider: PROVIDER, reason },
      });
    } catch {
      // Audit must never block the auth redirect.
    }
  };

  router.get("/status", (_req, res) => {
    res.json({ enabled: config !== null });
  });

  router.get("/start", (req, res) => {
    if (!config) {
      res.status(404).json({ error: { code: "not_found", message: "Google login is not enabled" } });
      return;
    }
    const state = generateState();
    const returnPath = resolveReturnPath(req.query.return_to, successRedirect);
    res.append(
      "Set-Cookie",
      serializeCookie(STATE_COOKIE, state, {
        httpOnly: true,
        secure: true,
        sameSite: "Lax",
        path: "/",
        maxAge: STATE_TTL_SECONDS,
      }),
    );
    res.append(
      "Set-Cookie",
      returnPath
        ? serializeCookie(RETURN_TO_COOKIE, encodeURIComponent(returnPath), {
            httpOnly: true,
            secure: true,
            sameSite: "Lax",
            path: "/",
            maxAge: STATE_TTL_SECONDS,
          })
        : clearCookie(RETURN_TO_COOKIE),
    );
    res.redirect(buildGoogleAuthorizationUrl({ config, state }));
  });

  router.get("/callback", async (req, res) => {
    if (!config) {
      res.status(404).json({ error: { code: "not_found", message: "Google login is not enabled" } });
      return;
    }

    const returnTarget = returnTargetFor(req);
    const failureRedirect = withErrorParam(returnTarget);
    const { code, state, error } = req.query;
    if (typeof error === "string" && error.length > 0) {
      await recordFailure(`provider_error:${error}`);
      res.append("Set-Cookie", clearCookie(STATE_COOKIE));
      res.append("Set-Cookie", clearCookie(RETURN_TO_COOKIE));
      res.redirect(failureRedirect);
      return;
    }

    const cookieState = readCookie(req, STATE_COOKIE);
    if (typeof code !== "string" || typeof state !== "string" || !cookieState || cookieState !== state) {
      await recordFailure("invalid_state");
      res.append("Set-Cookie", clearCookie(STATE_COOKIE));
      res.append("Set-Cookie", clearCookie(RETURN_TO_COOKIE));
      res.redirect(failureRedirect);
      return;
    }

    res.append("Set-Cookie", clearCookie(STATE_COOKIE));
    res.append("Set-Cookie", clearCookie(RETURN_TO_COOKIE));

    try {
      const identity = await resolveGoogleIdentity({ config, code, fetchImpl });
      const result = await authService.federatedLogin({
        provider: PROVIDER,
        subject: identity.subject,
        email: identity.email,
        emailVerified: identity.emailVerified,
      });
      res.append("Set-Cookie", result.sessionCookie);
      res.redirect(returnTarget);
    } catch {
      // federatedLogin records its own audit for verified-but-rejected cases;
      // this covers OAuth exchange / userinfo failures.
      await recordFailure("oauth_exchange_failed");
      res.redirect(failureRedirect);
    }
  });

  return router;
};
