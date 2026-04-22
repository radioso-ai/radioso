import { Router } from "express";
import { z } from "zod";

import type { AppDependencies } from "../../server/types.js";
import { normalizeEmail } from "../../../modules/auth/domain/authPrimitives.js";
import { createRateLimitMiddleware } from "../middleware/rateLimit.js";
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
});

export const emailVerificationVerifySchema = z.object({
  token: z.string().min(1),
});

export const emailVerificationResendSchema = z.object({
  email: z.string().email(),
});

export const createAuthRoutes = (dependencies: AppDependencies): Router => {
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
  const passwordResetRequestRateLimit = createRateLimitMiddleware({
    service: dependencies.abuseControlService,
    auditService: dependencies.auditService,
    scope: "auth.password_reset.request",
    limit: dependencies.env.PASSWORD_RESET_RATE_LIMIT_MAX_ATTEMPTS,
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
    limit: dependencies.env.PASSWORD_RESET_RATE_LIMIT_MAX_ATTEMPTS,
    windowMs: authWindowMs,
    resolveSubjectKey: (req) => {
      const token = typeof req.body?.token === "string" ? req.body.token : null;
      return token ?? String(req.ip ?? "unknown");
    },
  });
  const emailVerificationResendRateLimit = createRateLimitMiddleware({
    service: dependencies.abuseControlService,
    auditService: dependencies.auditService,
    scope: "auth.email_verification.resend",
    limit: dependencies.env.PASSWORD_RESET_RATE_LIMIT_MAX_ATTEMPTS,
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
    limit: dependencies.env.PASSWORD_RESET_RATE_LIMIT_MAX_ATTEMPTS,
    windowMs: authWindowMs,
    resolveSubjectKey: (req) => {
      const token = typeof req.body?.token === "string" ? req.body.token : null;
      return token ?? String(req.ip ?? "unknown");
    },
  });

  router.post("/register", validateBody(registerSchema), registerRateLimit, async (req, res, next) => {
    try {
      const result = await dependencies.authService.register({
        ...req.body,
        requestIp: req.ip,
        requestUserAgent: req.get("user-agent"),
      });
      if (result.sessionCookie) {
        res.setHeader("Set-Cookie", result.sessionCookie);
      }
      res.status(201).json({
        userId: result.userId,
        accountId: result.accountId,
        organizationName: result.organizationName,
        workspaceId: result.workspaceId,
        workspaceName: result.workspaceName,
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
      });
    } catch (error) {
      next(error);
    }
  });

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
          organizationName: result.organizationName,
          workspaceId: result.workspaceId,
          workspaceName: result.workspaceName,
        });
      } catch (error) {
        next(error);
      }
    },
  );

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
        });
      } catch (error) {
        next(error);
      }
    },
  );

  return router;
};
