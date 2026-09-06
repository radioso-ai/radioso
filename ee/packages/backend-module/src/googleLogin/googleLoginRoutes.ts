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
      const raw = pair.slice(index + 1).trim();
      try {
        return decodeURIComponent(raw);
      } catch {
        // A malformed percent sequence is not a usable cookie value. Hand back
        // the raw text the way cookie-parser does rather than throwing inside
        // the request handler.
        return raw;
      }
    }
  }
  return undefined;
};

const withErrorParam = (target: string): string => {
  const separator = target.includes("?") ? "&" : "?";
  return `${target}${separator}error=google_login_failed`;
};

// Stands in for the app origin when `successRedirect` is relative, so the same
// origin comparison decides both cases.
const RELATIVE_RESOLUTION_BASE = "https://return-to.invalid";

/**
 * Resolves a caller-supplied return target and accepts it only if it lands on
 * the same origin as the configured landing page.
 *
 * The check is deliberately made on the *parsed* URL rather than on the raw
 * characters. A blocklist cannot work here: the URL parser strips ASCII tab,
 * CR and LF before parsing, so `/<TAB>//host` inspects as a harmless path and
 * then resolves to `//host`. Comparing origins after resolution is decidable no
 * matter what the parser does with the input.
 *
 * Returns the target to redirect to, or null when the value is unusable.
 */
const sameOriginTarget = (successRedirect: string, returnTo: unknown): string | null => {
  if (typeof returnTo !== "string" || returnTo.length === 0) {
    return null;
  }

  let appOrigin: URL | null = null;
  try {
    appOrigin = new URL(successRedirect);
  } catch {
    appOrigin = null;
  }
  const base = appOrigin ?? new URL(RELATIVE_RESOLUTION_BASE);

  let target: URL;
  try {
    target = new URL(returnTo, base);
  } catch {
    return null;
  }
  if (target.origin !== base.origin) {
    return null;
  }

  // Without a configured app origin there is nothing absolute to hand back, so
  // return the resolved path — same-origin by construction.
  return appOrigin ? target.toString() : `${target.pathname}${target.search}${target.hash}`;
};

export const createGoogleLoginRouter = (options: GoogleLoginRouterOptions): Router => {
  const router = Router();
  const { config, successRedirect, authService } = options;
  const fetchImpl = options.fetchImpl ?? fetch;
  const generateState = options.generateState ?? (() => randomBytes(32).toString("hex"));
  const failureRedirect = withErrorParam(successRedirect);

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
    const cookieAttributes = {
      httpOnly: true,
      secure: true,
      sameSite: "Lax",
      path: "/",
      maxAge: STATE_TTL_SECONDS,
    } as const;
    res.append("Set-Cookie", serializeCookie(STATE_COOKIE, state, cookieAttributes));

    // Carried in a cookie rather than the OAuth state so the provider never
    // sees where the visitor came from, and so the value survives the round
    // trip without widening what `state` means. The stored form is already
    // resolved and origin-checked.
    const returnTo = sameOriginTarget(successRedirect, req.query.returnTo);
    res.append(
      "Set-Cookie",
      returnTo
        ? serializeCookie(RETURN_TO_COOKIE, encodeURIComponent(returnTo), cookieAttributes)
        : clearCookie(RETURN_TO_COOKIE),
    );

    const loginHint = typeof req.query.loginHint === "string" ? req.query.loginHint : undefined;
    res.redirect(buildGoogleAuthorizationUrl({ config, state, loginHint }));
  });

  router.get("/callback", async (req, res) => {
    if (!config) {
      res.status(404).json({ error: { code: "not_found", message: "Google login is not enabled" } });
      return;
    }

    // Checked again on the way back rather than trusted: a cookie is writable
    // by anyone who can reach the browser, unlike the handshake itself.
    // `readCookie` percent-decodes, which undoes the encoding `/start` applied.
    const returnTo = sameOriginTarget(successRedirect, readCookie(req, RETURN_TO_COOKIE));
    const successTarget = returnTo ?? successRedirect;
    const failureTarget = returnTo ? withErrorParam(returnTo) : failureRedirect;
    const clearHandshakeCookies = () => {
      res.append("Set-Cookie", clearCookie(STATE_COOKIE));
      res.append("Set-Cookie", clearCookie(RETURN_TO_COOKIE));
    };

    const { code, state, error } = req.query;
    if (typeof error === "string" && error.length > 0) {
      await recordFailure(`provider_error:${error}`);
      clearHandshakeCookies();
      res.redirect(failureTarget);
      return;
    }

    const cookieState = readCookie(req, STATE_COOKIE);
    if (typeof code !== "string" || typeof state !== "string" || !cookieState || cookieState !== state) {
      await recordFailure("invalid_state");
      clearHandshakeCookies();
      res.redirect(failureTarget);
      return;
    }

    clearHandshakeCookies();

    try {
      const identity = await resolveGoogleIdentity({ config, code, fetchImpl });
      const result = await authService.federatedLogin({
        provider: PROVIDER,
        subject: identity.subject,
        email: identity.email,
        emailVerified: identity.emailVerified,
      });
      res.append("Set-Cookie", result.sessionCookie);
      res.redirect(successTarget);
    } catch {
      // federatedLogin records its own audit for verified-but-rejected cases;
      // this covers OAuth exchange / userinfo failures.
      await recordFailure("oauth_exchange_failed");
      res.redirect(failureTarget);
    }
  });

  return router;
};
