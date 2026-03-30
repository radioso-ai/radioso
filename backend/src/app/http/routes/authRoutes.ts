import { Router } from "express";
import { z } from "zod";

import type { AppDependencies } from "../../server/types.js";
import { normalizeEmail } from "../../../modules/auth/domain/authPrimitives.js";
import { createRateLimitMiddleware } from "../middleware/rateLimit.js";
import { validateBody } from "../middleware/validate.js";

export const registerSchema = z.object({
  email: z.string().email(),
  password: z.string().min(8),
});

export const loginSchema = z.object({
  email: z.string().email(),
  password: z.string().min(1),
  preferredWorkspaceId: z.string().uuid().optional(),
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
        workspaceId: result.workspaceId,
        workspaceName: result.workspaceName,
      });
    } catch (error) {
      next(error);
    }
  });

  return router;
};
