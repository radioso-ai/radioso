import { Router, type RequestHandler } from "express";
import { z } from "zod";

import type { ApplicationRouteMount } from "../radiosoModuleTypes.js";
import { StaffAuthService, defaultStaffSessionTtlHours } from "./staffAuthService.js";
import { StaffBootstrapService } from "./staffBootstrap.js";
import { PostgresStaffSessionRepository, type StaffSessionRepository } from "./staffSessionRepository.js";
import { PostgresStaffUserRepository, type StaffUserRepository } from "./staffRepository.js";
import { requireStaffRole, requireStaffSession } from "./staffGuards.js";
import type { StaffUser } from "./staffTypes.js";

type RouteDependencies = Parameters<ApplicationRouteMount["createRouter"]>[0];

const loginBodySchema = z.object({
  email: z.string().trim().email(),
  password: z.string().min(1),
});

const bootstrapBodySchema = z.object({
  email: z.string().trim().email(),
  name: z.string().trim().min(1).max(120),
  password: z.string().min(8),
});

const parseRequest = <T>(schema: z.ZodType<T>, value: unknown, message: string): T => {
  const parsed = schema.safeParse(value);
  if (parsed.success) {
    return parsed.data;
  }
  throw {
    statusCode: 400,
    code: "bad_request",
    message,
    details: parsed.error.flatten(),
  };
};

const requireAdminToken = (): RequestHandler => (req, res, next) => {
  const expectedToken = process.env.EE_USAGE_ADMIN_TOKEN;
  if (!expectedToken) {
    res.status(503).json({
      error: {
        code: "service_unavailable",
        message: "EE staff bootstrap is not configured.",
        details: { missingEnv: "EE_USAGE_ADMIN_TOKEN" },
      },
    });
    return;
  }

  const authorization = req.header("authorization");
  const bearerToken = authorization?.startsWith("Bearer ")
    ? authorization.slice("Bearer ".length).trim()
    : null;
  if (bearerToken !== expectedToken) {
    res.status(401).json({
      error: {
        code: "unauthorized",
        message: "Unauthorized",
      },
    });
    return;
  }

  next();
};

const resolveStaffCookieName = (dependencies: RouteDependencies): string => {
  const value = dependencies.env.STAFF_SESSION_COOKIE_NAME?.trim() || process.env.STAFF_SESSION_COOKIE_NAME?.trim();
  if (!value) {
    throw new Error("STAFF_SESSION_COOKIE_NAME is required for the operator console");
  }
  return value;
};

const resolveStaffTtlHours = (dependencies: RouteDependencies): number => {
  const raw = dependencies.env.STAFF_SESSION_TTL_HOURS ?? process.env.STAFF_SESSION_TTL_HOURS;
  const parsed = typeof raw === "number" ? raw : Number(raw);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : defaultStaffSessionTtlHours;
};

const publicStaff = (staff: StaffUser) => ({
  id: staff.id,
  email: staff.email,
  name: staff.name,
  role: staff.role,
});

export interface StaffConsoleRouteRepositories {
  users?: StaffUserRepository;
  sessions?: StaffSessionRepository;
}

export const createStaffConsoleRoutes = (
  dependencies: RouteDependencies,
  repositories: StaffConsoleRouteRepositories = {},
): Router => {
  const router = Router();
  const users = repositories.users ?? new PostgresStaffUserRepository(dependencies.connectorDb);
  const sessions = repositories.sessions ?? new PostgresStaffSessionRepository(dependencies.connectorDb);
  const cookieName = resolveStaffCookieName(dependencies);
  const ttlHours = resolveStaffTtlHours(dependencies);
  const authService = new StaffAuthService(users, sessions, { ttlHours });
  const bootstrapService = new StaffBootstrapService(users, dependencies.auditService);
  const staffSessionGuard = requireStaffSession(authService, cookieName);

  router.post("/auth/login", async (req, res, next) => {
    try {
      const body = parseRequest(loginBodySchema, req.body, "Invalid staff login payload");
      const result = await authService.login(body);
      res.cookie(cookieName, result.sessionToken, {
        httpOnly: true,
        sameSite: "lax",
        secure: process.env.NODE_ENV === "production",
        path: "/",
        expires: result.expiresAt,
      });
      res.status(200).json({ staff: publicStaff(result.staff) });
    } catch (error) {
      next(error);
    }
  });

  router.post("/auth/logout", staffSessionGuard, async (req, res, next) => {
    try {
      const sessionToken = req.cookies?.[cookieName];
      if (typeof sessionToken === "string" && sessionToken.length > 0) {
        await authService.revoke(sessionToken);
      }
      res.clearCookie(cookieName, { path: "/" });
      res.status(204).end();
    } catch (error) {
      next(error);
    }
  });

  router.get("/auth/me", staffSessionGuard, (_req, res) => {
    res.status(200).json({ staff: res.locals.staff });
  });

  router.post("/bootstrap", requireAdminToken(), async (req, res, next) => {
    try {
      const body = parseRequest(bootstrapBodySchema, req.body, "Invalid staff bootstrap payload");
      const staff = await bootstrapService.bootstrapOwner(body);
      res.status(200).json({ staff: publicStaff(staff) });
    } catch (error) {
      next(error);
    }
  });

  if (process.env.NODE_ENV === "test") {
    router.get("/_test/billing-write", staffSessionGuard, requireStaffRole("billing_write"), (_req, res) => {
      res.status(204).end();
    });
  }

  return router;
};
