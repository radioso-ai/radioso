import { createHash } from "node:crypto";
import { Router } from "express";
import { z } from "zod";

import type { AppDependencies } from "../../server/types.js";
import { normalizeEmail } from "../../../modules/auth/domain/authPrimitives.js";
import { createRateLimitMiddleware } from "../middleware/rateLimit.js";
import { requireSession, type SessionDependencies } from "../middleware/requireSession.js";
import { validateBody } from "../middleware/validate.js";

export const registerSchema = z.object({
  email: z.string().email(),
  password: z.string().min(8),
  organizationName: z.string().trim().min(1).max(80).optional(),
});

export const loginSchema = z.object({
  email: z.string().email(),
  password: z.string().min(1),
  preferredWorkspaceId: z.string().uuid().optional(),
  preferredAccountId: z.string().uuid().optional(),
});

export const invitationTokenParamsSchema = z.object({
  invitationToken: z.string().min(1),
});

export const invitationAcceptSchema = z.object({
  email: z.string().email(),
  password: z.string().min(8),
});

export const passwordResetRequestSchema = z.object({
  email: z.string().email(),
});

export const passwordResetConfirmSchema = z.object({
  token: z.string().min(1),
  password: z.string().min(8),
  preferredWorkspaceId: z.string().uuid().optional(),
  preferredAccountId: z.string().uuid().optional(),
});

export const emailVerificationVerifySchema = z.object({
  token: z.string().min(1),
});

export const emailVerificationResendSchema = z.object({
  email: z.string().email(),
});

type AuthRouteDependencies = SessionDependencies & Pick<
  AppDependencies,
  | "env"
  | "authService"
  | "passwordResetService"
  | "emailVerificationService"
  | "abuseControlService"
  | "auditService"
>;

export const createAuthRoutes = (dependencies: AuthRouteDependencies): Router => {
  const router = Router();
  const authWindowMs = dependencies.env.AUTH_RATE_LIMIT_WINDOW_MS;
  const authLimit = dependencies.env.AUTH_RATE_LIMIT_MAX_ATTEMPTS;
  const registerRateLimit = createRateLimitMiddleware({
    service: dependencies.abuseControlService,
    auditService: dependencies.auditService,
    scope: "auth.register",
    limit: authLimit,
    windowMs: authWindowMs,
    resolveSubjectKey: (req) => {
      const email = typeof req.body?.email === "string" ? req.body.email : null;
      return email ? normalizeEmail(email) : String(req.ip ?? "unknown");
    },
  });
  const loginRateLimit = createRateLimitMiddleware({
    service: dependencies.abuseControlService,
    auditService: dependencies.auditService,
    scope: "auth.login",
    limit: authLimit,
    windowMs: authWindowMs,
    resolveSubjectKey: (req) => {
      const email = typeof req.body?.email === "string" ? req.body.email : null;
      return email ? normalizeEmail(email) : String(req.ip ?? "unknown");
    },
  });
  const invitationAcceptRateLimit = createRateLimitMiddleware({
    service: dependencies.abuseControlService,
    auditService: dependencies.auditService,
    scope: "auth.invitation.accept",
    limit: authLimit,
    windowMs: authWindowMs,
    resolveSubjectKey: (req) => {
      const token = typeof req.params.invitationToken === "string" ? req.params.invitationToken : "unknown";
      const tokenHash = createHash("sha256").update(token).digest("hex");
      const source = req.ip ?? "unknown";
      return `${tokenHash}:${source}`;
    },
  });
  const passwordResetRequestRateLimit = createRateLimitMiddleware({
    service: dependencies.abuseControlService,
    auditService: dependencies.auditService,
    scope: "auth.password_reset.request",
    limit: authLimit,
    windowMs: authWindowMs,
    resolveSubjectKey: (req) => {
      const email = typeof req.body?.email === "string" ? req.body.email : null;
      return email ? normalizeEmail(email) : String(req.ip ?? "unknown");
    },
  });
  const passwordResetConfirmRateLimit = createRateLimitMiddleware({
    service: dependencies.abuseControlService,
    auditService: dependencies.auditService,
    scope: "auth.password_reset.confirm",
    limit: authLimit,
    windowMs: authWindowMs,
    resolveSubjectKey: (req) => String(req.ip ?? "unknown"),
  });
  const emailVerificationResendRateLimit = createRateLimitMiddleware({
    service: dependencies.abuseControlService,
    auditService: dependencies.auditService,
    scope: "auth.email_verification.resend",
    limit: authLimit,
    windowMs: authWindowMs,
    resolveSubjectKey: (req) => {
      const email = typeof req.body?.email === "string" ? req.body.email : null;
      return email ? normalizeEmail(email) : String(req.ip ?? "unknown");
    },
  });
  const emailVerificationVerifyRateLimit = createRateLimitMiddleware({
    service: dependencies.abuseControlService,
    auditService: dependencies.auditService,
    scope: "auth.email_verification.verify",
    limit: authLimit,
    windowMs: authWindowMs,
    resolveSubjectKey: (req) => String(req.ip ?? "unknown"),
  });
  router.get("/registration", async (_req, res, next) => {
    try {
      const available = await dependencies.authService.isRegistrationAvailable();
      res.setHeader("Cache-Control", "no-store");
      res.status(200).json({ available });
    } catch (error) {
      next(error);
    }
  });

  router.post("/register", validateBody(registerSchema), registerRateLimit, async (req, res, next) => {
    try {
      const result = await dependencies.authService.register({
        ...req.body,
        requestIp: req.ip,
        requestUserAgent: req.get("user-agent"),
      });
      if (result.requiresEmailVerification) {
        await dependencies.emailVerificationService.resend({
          email: req.body.email,
          requestIp: req.ip,
          requestUserAgent: req.get("user-agent"),
        });
      }
      if (result.sessionCookie) {
        res.setHeader("Set-Cookie", result.sessionCookie);
      }
      res.status(201).json({
        userId: result.userId,
        accountId: result.accountId,
        organizationName: result.organizationName,
        workspaceId: result.workspaceId,
        workspaceName: result.workspaceName,
        workspacePublicRouteKey: result.workspacePublicRouteKey,
        requiresEmailVerification: result.requiresEmailVerification,
      });
    } catch (error) {
      next(error);
    }
  });

  router.post("/login", validateBody(loginSchema), loginRateLimit, async (req, res, next) => {
    try {
      const result = await dependencies.authService.login(req.body);
      res.setHeader("Set-Cookie", result.sessionCookie);
      res.status(200).json({
        userId: result.userId,
        accountId: result.accountId,
        organizationName: result.organizationName,
        workspaceId: result.workspaceId,
        workspaceName: result.workspaceName,
        workspacePublicRouteKey: result.workspacePublicRouteKey,
      });
    } catch (error) {
      next(error);
    }
  });

  // Recovers the signed-in identity from the session cookie alone. Sign-in
  // paths that redirect the browser — provider OAuth in particular — set the
  // cookie and hand back no body, so this is how the app learns who arrived.
  router.get("/session", requireSession(dependencies, { requireActiveMembership: false }), async (_req, res, next) => {
    try {
      const { userId, accountId } = res.locals as { userId: string; accountId: string };
      const session = await dependencies.authService.describeSession({ userId, accountId });
      res.setHeader("Cache-Control", "no-store");
      res.status(200).json(session);
    } catch (error) {
      next(error);
    }
  });

  router.get("/invitations/:invitationToken", async (req, res, next) => {
    try {
      const params = invitationTokenParamsSchema.parse(req.params);
      const invitation = await dependencies.authService.getInvitation(params);
      res.status(200).json(invitation);
    } catch (error) {
      next(error);
    }
  });

  router.post(
    "/invitations/:invitationToken/accept",
    validateBody(invitationAcceptSchema),
    invitationAcceptRateLimit,
    async (req, res, next) => {
      try {
        const params = invitationTokenParamsSchema.parse(req.params);
        const result = await dependencies.authService.acceptInvitation({
          invitationToken: params.invitationToken,
          email: req.body.email,
          password: req.body.password,
        });
        res.setHeader("Set-Cookie", result.sessionCookie);
        res.status(200).json({
          userId: result.userId,
          accountId: result.accountId,
          organizationName: result.organizationName,
          workspaceId: result.workspaceId,
          workspaceName: result.workspaceName,
          workspacePublicRouteKey: result.workspacePublicRouteKey,
        });
      } catch (error) {
        next(error);
      }
    },
  );

  // A signed-in visitor proves who they are with the session cookie, so this
  // path collects no password at all. Federated logins have no usable password
  // hash, which makes this their only way to accept an invitation.
  router.post(
    "/invitations/:invitationToken/accept-as-current-user",
    requireSession(dependencies, { requireActiveMembership: false }),
    // Shares the accept limiter with the password path. A mismatched attempt
    // writes an audit row against the *inviting* account, so a signed-in holder
    // of somebody else's token could otherwise flood a third party's audit log.
    invitationAcceptRateLimit,
    async (req, res, next) => {
      try {
        const params = invitationTokenParamsSchema.parse(req.params);
        const { userId } = res.locals as { userId: string };
        const result = await dependencies.authService.acceptInvitationAsUser({
          invitationToken: params.invitationToken,
          userId,
        });
        res.setHeader("Set-Cookie", result.sessionCookie);
        res.status(200).json({
          userId: result.userId,
          accountId: result.accountId,
          organizationName: result.organizationName,
          workspaceId: result.workspaceId,
          workspaceName: result.workspaceName,
          workspacePublicRouteKey: result.workspacePublicRouteKey,
        });
      } catch (error) {
        next(error);
      }
    },
  );

  router.post(
    "/password-reset/request",
    validateBody(passwordResetRequestSchema),
    passwordResetRequestRateLimit,
    async (req, res, next) => {
      try {
        const result = await dependencies.passwordResetService.requestReset({
          email: req.body.email,
          requestIp: req.ip,
          requestUserAgent: req.get("user-agent"),
        });
        res.status(202).json(result);
      } catch (error) {
        next(error);
      }
    },
  );

  router.post(
    "/password-reset/confirm",
    validateBody(passwordResetConfirmSchema),
    passwordResetConfirmRateLimit,
    async (req, res, next) => {
      try {
        const result = await dependencies.passwordResetService.confirmReset(req.body);
        res.setHeader("Set-Cookie", result.sessionCookie);
        res.status(200).json({
          userId: result.userId,
          accountId: result.accountId,
          email: result.email,
          organizationName: result.organizationName,
          workspaceId: result.workspaceId,
          workspaceName: result.workspaceName,
          workspacePublicRouteKey: result.workspacePublicRouteKey,
        });
      } catch (error) {
        next(error);
      }
    },
  );

  router.post(
    "/email-verification/verify",
    validateBody(emailVerificationVerifySchema),
    emailVerificationVerifyRateLimit,
    async (req, res, next) => {
      try {
        const result = await dependencies.emailVerificationService.verify(req.body);
        res.status(200).json(result);
      } catch (error) {
        next(error);
      }
    },
  );

  router.post(
    "/email-verification/resend",
    validateBody(emailVerificationResendSchema),
    emailVerificationResendRateLimit,
    async (req, res, next) => {
      try {
        const result = await dependencies.emailVerificationService.resend({
          email: req.body.email,
          requestIp: req.ip,
          requestUserAgent: req.get("user-agent"),
        });
        res.status(202).json(result);
      } catch (error) {
        next(error);
      }
    },
  );

  return router;
};
