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

  router.post("/register", validateBody(registerSchema), registerRateLimit, async (req, res, next) => {
    try {
      const result = await dependencies.authService.register(req.body);
      res.setHeader("Set-Cookie", result.sessionCookie);
      res.status(201).json({
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
