import { randomBytes } from "node:crypto";

import { Router, type ErrorRequestHandler, type RequestHandler, type Response } from "express";

import {
  GoogleOAuthError,
  buildGoogleAuthorizationUrl,
  resolveGoogleIdentity,
  type GoogleOAuthConfig,
} from "../googleLogin/googleOAuthClient.js";
import { HttpError } from "../shared/httpError.js";
import type { StaffAuthResult, StaffAuthService } from "./staffAuthService.js";
import type { StaffSecurityEvents } from "./staffSecurityEvents.js";

const STATE_COOKIE = "radioso_staff_google_state";
const STATE_TTL_MS = 10 * 60 * 1000;
const SIGNED_IN_REDIRECT = "/operator/organizations";
const ACCOUNT_REFUSED_REDIRECT = "/operator/login?error=google_account_refused";
const SIGN_IN_FAILED_REDIRECT = "/operator/login?error=google_sign_in_failed";

interface StaffGoogleSignInRouterOptions {
  /** Null when Workspace sign-in is off or incomplete: both routes then answer 404. */
  oauth: GoogleOAuthConfig | null;
  workspaceDomain: string | null;
  authService: Pick<StaffAuthService, "loginWithGoogle">;
  events: Pick<StaffSecurityEvents, "signIn">;
  createEntryRateLimit: (scope: string) => RequestHandler;
  setSessionCookie: (res: Response, session: StaffAuthResult) => void;
  logger: { warn?(entry: unknown, message?: string): void };
  fetchImpl?: typeof fetch;
}

export const createStaffGoogleSignInRouter = (options: StaffGoogleSignInRouterOptions): Router => {
  const router = Router();
  const { oauth, workspaceDomain, authService, events } = options;

  const stateCookieOptions = {
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    path: "/",
  } as const;

  const requireConfigured: RequestHandler = (_req, _res, next) => {
    next(oauth && workspaceDomain ? undefined : new HttpError(404, "not_found", "Google sign-in is not enabled."));
  };

  router.get("/start", requireConfigured, options.createEntryRateLimit("ee.staff_console.google.start"), (_req, res) => {
    const state = randomBytes(32).toString("hex");
    res.cookie(STATE_COOKIE, state, { ...stateCookieOptions, maxAge: STATE_TTL_MS });
    res.redirect(buildGoogleAuthorizationUrl({
      config: oauth!,
      state,
      hostedDomain: workspaceDomain!,
    }));
  });

  router.get("/callback", requireConfigured, options.createEntryRateLimit("ee.staff_console.google.callback"), async (req, res) => {
    const expectedState: unknown = req.cookies?.[STATE_COOKIE];
    res.clearCookie(STATE_COOKIE, stateCookieOptions);

    const refuse = async (reason: "provider_error" | "invalid_state" | "oauth_exchange_failed"): Promise<void> => {
      await events.signIn({ method: "google", outcome: "failure", reason });
      res.redirect(SIGN_IN_FAILED_REDIRECT);
    };

    const { code, state, error } = req.query;
    if (typeof error === "string" && error.length > 0) {
      await refuse("provider_error");
      return;
    }
    if (typeof code !== "string" || typeof state !== "string" || typeof expectedState !== "string" || expectedState !== state) {
      await refuse("invalid_state");
      return;
    }

    let identity: Awaited<ReturnType<typeof resolveGoogleIdentity>>;
    try {
      identity = await resolveGoogleIdentity({ config: oauth!, code, fetchImpl: options.fetchImpl });
    } catch (caught) {
      options.logger.warn?.(
        {
          event: "staff_console.google_sign_in_error",
          step: "exchange",
          code: caught instanceof GoogleOAuthError ? caught.code : "unexpected",
        },
        "Staff Google sign-in could not complete the exchange with Google",
      );
      await refuse("oauth_exchange_failed");
      return;
    }

    try {
      options.setSessionCookie(res, await authService.loginWithGoogle(identity, workspaceDomain!));
      res.redirect(SIGNED_IN_REDIRECT);
    } catch (caught) {
      // `loginWithGoogle` records its own refusals, and those are an answer about this account.
      // Anything else is a broken step, and this is the only place that error exists.
      if (caught instanceof HttpError) {
        res.redirect(ACCOUNT_REFUSED_REDIRECT);
        return;
      }
      options.logger.warn?.(
        { event: "staff_console.google_sign_in_error", step: "sign_in", err: caught },
        "Staff Google sign-in did not complete",
      );
      res.redirect(SIGN_IN_FAILED_REDIRECT);
    }
  });

  // Both routes are browser navigations, so a limit's answer has to land where a person can act on it.
  const redirectWhenThrottled: ErrorRequestHandler = (error, _req, res, next) => {
    const { statusCode } = error as { statusCode?: number };
    if (statusCode === 429 || statusCode === 503) {
      res.redirect(SIGN_IN_FAILED_REDIRECT);
      return;
    }
    next(error);
  };
  router.use(redirectWhenThrottled);

  return router;
};
