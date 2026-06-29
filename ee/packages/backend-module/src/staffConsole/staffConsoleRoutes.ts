import { Router, type RequestHandler } from "express";
import { z } from "zod";

import type { ApplicationRouteMount } from "../radiosoModuleTypes.js";
import { EnterpriseUsageLimitService } from "../usageLimits/usageLimitService.js";
import type { AccountUsageSummary, UsageLimitProfile } from "../usageLimits/usageLimitService.js";
import { OrganizationDirectoryService } from "./organizationDirectoryService.js";
import type { OrganizationDirectoryPage } from "./organizationDirectoryService.js";
import { StaffAuthService, defaultStaffSessionTtlHours } from "./staffAuthService.js";
import { StaffBootstrapService } from "./staffBootstrap.js";
import { hashStaffPassword } from "./staffCrypto.js";
import { PostgresStaffSessionRepository, type StaffSessionRepository } from "./staffSessionRepository.js";
import { PostgresStaffUserRepository, type StaffUserRepository } from "./staffRepository.js";
import { requireStaffRole, requireStaffSession } from "./staffGuards.js";
import { staffRoles, staffStatuses, type StaffUser } from "./staffTypes.js";

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

const listOrganizationsQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(100).optional().default(25),
  offset: z.coerce.number().int().min(0).optional(),
  cursor: z.string().trim().min(1).max(64).optional(),
  search: z.string().trim().min(1).max(200).optional(),
});

const accountIdParamsSchema = z.object({
  accountId: z.string().uuid(),
});

const profileKeySchema = z.string().trim().regex(/^[a-z0-9][a-z0-9_-]{1,62}[a-z0-9]$/);

const tierAssignmentBodySchema = z.object({
  profileKey: profileKeySchema.nullable(),
});

const nullableLimitSchema = z.number().int().min(0).nullable();
const nullableByteLimitSchema = z.union([z.number().int().min(0), z.null()]).optional();

const tierProfileParamsSchema = z.object({
  profileKey: profileKeySchema,
});

const tierProfileBodySchema = z.object({
  displayName: z.string().trim().min(1).max(120),
  monthlyAnswerLimit: nullableLimitSchema,
  storedDocumentLimit: nullableLimitSchema,
  storedIndexedByteLimit: nullableByteLimitSchema,
  monthlyIndexedByteLimit: nullableByteLimitSchema,
});

const staffIdParamsSchema = z.object({
  staffId: z.string().uuid(),
});

const staffCreateBodySchema = z.object({
  email: z.string().trim().email().transform((value) => value.toLowerCase()),
  name: z.string().trim().min(1).max(120),
  role: z.enum(staffRoles),
  password: z.string().min(8),
});

const staffRoleBodySchema = z.object({
  role: z.enum(staffRoles),
});

const staffStatusBodySchema = z.object({
  status: z.enum(staffStatuses),
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
  status: staff.status,
  lastLoginAt: staff.lastLoginAt ? staff.lastLoginAt.toISOString() : null,
});

type StaffConsoleLogger = {
  info?(entry: Record<string, unknown>, message?: string): void;
  warn?(entry: Record<string, unknown>, message?: string): void;
};

const resolveLogger = (dependencies: RouteDependencies): StaffConsoleLogger => {
  const logger = (dependencies as RouteDependencies & { logger?: StaffConsoleLogger }).logger;
  return logger ?? {};
};

export interface StaffConsoleRouteRepositories {
  users?: StaffUserRepository;
  sessions?: StaffSessionRepository;
  organizationDirectoryService?: Pick<OrganizationDirectoryService, "listOrganizations">;
  usageLimitService?: Pick<
    EnterpriseUsageLimitService,
    "getAccountUsage" | "listProfiles" | "assignProfile" | "upsertProfile"
  >;
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
  const organizationDirectoryService =
    repositories.organizationDirectoryService ?? new OrganizationDirectoryService(dependencies.connectorDb);
  const usageLimitService =
    repositories.usageLimitService ?? new EnterpriseUsageLimitService(dependencies.connectorDb);
  const logger = resolveLogger(dependencies);
  const staffSessionGuard = requireStaffSession(authService, cookieName);
  const staffReadSessionGuard = (input: {
    action: string;
    targetId?: (req: Parameters<RequestHandler>[0]) => string | null;
  }): RequestHandler => async (req, res, next) => {
    const targetId = input.targetId?.(req) ?? null;
    try {
      const sessionToken = req.cookies?.[cookieName];
      if (typeof sessionToken !== "string" || sessionToken.length === 0) {
        logger.warn?.({
          event: "staff_console.read_auth",
          action: input.action,
          targetId,
          outcome: "failure",
          reason: "missing_session",
        }, "Staff console read authentication failed");
        throw { statusCode: 401, code: "unauthorized", message: "Unauthorized", readAuthLogged: true };
      }
      const { staff } = await authService.authenticateStaffSession(sessionToken);
      res.locals.staff = {
        id: staff.id,
        role: staff.role,
        email: staff.email,
        name: staff.name,
      };
      logger.info?.({
        event: "staff_console.read_auth",
        action: input.action,
        targetId,
        staffId: staff.id,
        role: staff.role,
        outcome: "success",
      }, "Staff console read authentication succeeded");
      next();
    } catch (error) {
      const authError = error as { statusCode?: number; readAuthLogged?: boolean };
      if (authError.statusCode === 401 && !authError.readAuthLogged) {
        logger.warn?.({
          event: "staff_console.read_auth",
          action: input.action,
          targetId,
          outcome: "failure",
          reason: "invalid_session",
        }, "Staff console read authentication failed");
      }
      next(error);
    }
  };

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

  router.get(
    "/organizations",
    staffReadSessionGuard({ action: "organizations.list" }),
    async (req, res, next) => {
      try {
        const query = parseRequest(
          listOrganizationsQuerySchema,
          req.query,
          "Invalid organization directory query",
        );
        const page: OrganizationDirectoryPage = await organizationDirectoryService.listOrganizations({
          limit: query.limit ?? 25,
          offset: query.offset,
          cursor: query.cursor,
          search: query.search,
        });
        res.status(200).json(page);
      } catch (error) {
        next(error);
      }
    },
  );

  router.get(
    "/organizations/:accountId/usage",
    staffReadSessionGuard({
      action: "organizations.usage.read",
      targetId: (req) => String(req.params.accountId),
    }),
    async (req, res, next) => {
      try {
        const { accountId } = parseRequest(accountIdParamsSchema, req.params, "Invalid organization identifier");
        const usage: AccountUsageSummary = await usageLimitService.getAccountUsage(accountId);
        res.status(200).json(usage);
      } catch (error) {
        next(error);
      }
    },
  );

  router.get(
    "/tiers",
    staffReadSessionGuard({ action: "tiers.list" }),
    async (_req, res, next) => {
      try {
        const tiers: UsageLimitProfile[] = await usageLimitService.listProfiles();
        res.status(200).json({ tiers });
      } catch (error) {
        next(error);
      }
    },
  );

  router.put(
    "/organizations/:accountId/tier",
    staffSessionGuard,
    requireStaffRole("billing_write"),
    async (req, res, next) => {
      try {
        const { accountId } = parseRequest(accountIdParamsSchema, req.params, "Invalid organization identifier");
        const body = parseRequest(tierAssignmentBodySchema, req.body, "Invalid tier assignment payload");
        const currentUsage = await usageLimitService.getAccountUsage(accountId);
        const fromProfileKey = currentUsage.profile?.key ?? null;
        const usage: AccountUsageSummary = await usageLimitService.assignProfile(accountId, body.profileKey);
        await dependencies.auditService.record({
          accountId,
          workspaceId: null,
          eventType: "staff.tier.assigned",
          eventStatus: "success",
          metadata: {
            actorStaffId: res.locals.staff.id,
            fromProfileKey,
            toProfileKey: body.profileKey,
          },
        });
        res.status(200).json(usage);
      } catch (error) {
        next(error);
      }
    },
  );

  router.put(
    "/tiers/:profileKey",
    staffSessionGuard,
    requireStaffRole("billing_write"),
    async (req, res, next) => {
      try {
        const { profileKey } = parseRequest(tierProfileParamsSchema, req.params, "Invalid tier profile key");
        const body = parseRequest(tierProfileBodySchema, req.body, "Invalid tier profile payload");
        const profile = await usageLimitService.upsertProfile({
          key: profileKey,
          displayName: body.displayName,
          monthlyAnswerLimit: body.monthlyAnswerLimit,
          storedDocumentLimit: body.storedDocumentLimit,
          storedIndexedByteLimit: body.storedIndexedByteLimit ?? null,
          monthlyIndexedByteLimit: body.monthlyIndexedByteLimit ?? null,
        });
        const fields = [
          "monthlyAnswerLimit",
          "storedDocumentLimit",
          ...(Object.prototype.hasOwnProperty.call(body, "storedIndexedByteLimit")
            ? ["storedIndexedByteLimit"]
            : []),
          ...(Object.prototype.hasOwnProperty.call(body, "monthlyIndexedByteLimit")
            ? ["monthlyIndexedByteLimit"]
            : []),
        ];
        await dependencies.auditService.record({
          accountId: null,
          workspaceId: null,
          eventType: "staff.tier.upserted",
          eventStatus: "success",
          metadata: {
            actorStaffId: res.locals.staff.id,
            profileKey,
            fields,
          },
        });
        res.status(200).json({ profile });
      } catch (error) {
        next(error);
      }
    },
  );

  router.get(
    "/staff",
    staffSessionGuard,
    requireStaffRole("owner"),
    async (_req, res, next) => {
      try {
        const staff = await users.listStaff();
        res.status(200).json({ staff: staff.map(publicStaff) });
      } catch (error) {
        next(error);
      }
    },
  );

  router.post(
    "/staff",
    staffSessionGuard,
    requireStaffRole("owner"),
    async (req, res, next) => {
      try {
        const body = parseRequest(staffCreateBodySchema, req.body, "Invalid staff create payload");
        const existing = await users.findByEmail(body.email);
        if (existing) {
          throw {
            statusCode: 409,
            code: "conflict",
            message: "Staff user already exists.",
          };
        }
        const passwordHash = await hashStaffPassword(body.password);
        const staff = await users.create({
          email: body.email,
          name: body.name,
          passwordHash,
          role: body.role,
          status: "active",
        });
        await dependencies.auditService.record({
          accountId: null,
          workspaceId: null,
          eventType: "staff.user.created",
          eventStatus: "success",
          metadata: {
            actorStaffId: res.locals.staff.id,
            targetStaffId: staff.id,
            role: staff.role,
          },
        });
        res.status(201).json({ staff: publicStaff(staff) });
      } catch (error) {
        next(error);
      }
    },
  );

  router.put(
    "/staff/:staffId/role",
    staffSessionGuard,
    requireStaffRole("owner"),
    async (req, res, next) => {
      try {
        const { staffId } = parseRequest(staffIdParamsSchema, req.params, "Invalid staff identifier");
        const body = parseRequest(staffRoleBodySchema, req.body, "Invalid staff role payload");
        const target = await users.findById(staffId);
        if (!target) {
          throw {
            statusCode: 404,
            code: "not_found",
            message: "Staff user not found.",
          };
        }
        if (target.id === res.locals.staff.id && target.role === "owner" && body.role !== "owner") {
          throw {
            statusCode: 409,
            code: "conflict",
            message: "Owners cannot demote their own account.",
          };
        }
        if (target.role === "owner" && target.status === "active" && body.role !== "owner") {
          const activeOwners = await users.countActiveOwners();
          if (activeOwners <= 1) {
            throw {
              statusCode: 409,
              code: "conflict",
              message: "Cannot demote the last active owner.",
            };
          }
        }
        const fromRole = target.role;
        const updated = await users.setRole(staffId, body.role);
        if (!updated) {
          throw {
            statusCode: 404,
            code: "not_found",
            message: "Staff user not found.",
          };
        }
        await dependencies.auditService.record({
          accountId: null,
          workspaceId: null,
          eventType: "staff.user.role_changed",
          eventStatus: "success",
          metadata: {
            actorStaffId: res.locals.staff.id,
            targetStaffId: target.id,
            fromRole,
            toRole: updated.role,
          },
        });
        res.status(200).json({ staff: publicStaff(updated) });
      } catch (error) {
        next(error);
      }
    },
  );

  router.put(
    "/staff/:staffId/status",
    staffSessionGuard,
    requireStaffRole("owner"),
    async (req, res, next) => {
      try {
        const { staffId } = parseRequest(staffIdParamsSchema, req.params, "Invalid staff identifier");
        const body = parseRequest(staffStatusBodySchema, req.body, "Invalid staff status payload");
        const target = await users.findById(staffId);
        if (!target) {
          throw {
            statusCode: 404,
            code: "not_found",
            message: "Staff user not found.",
          };
        }
        if (target.id === res.locals.staff.id && body.status === "disabled") {
          throw {
            statusCode: 409,
            code: "conflict",
            message: "Owners cannot disable their own account.",
          };
        }
        if (target.role === "owner" && target.status === "active" && body.status === "disabled") {
          const activeOwners = await users.countActiveOwners();
          if (activeOwners <= 1) {
            throw {
              statusCode: 409,
              code: "conflict",
              message: "Cannot disable the last active owner.",
            };
          }
        }
        const fromStatus = target.status;
        const updated = await users.setStatus(staffId, body.status);
        if (!updated) {
          throw {
            statusCode: 404,
            code: "not_found",
            message: "Staff user not found.",
          };
        }
        await dependencies.auditService.record({
          accountId: null,
          workspaceId: null,
          eventType: "staff.user.status_changed",
          eventStatus: "success",
          metadata: {
            actorStaffId: res.locals.staff.id,
            targetStaffId: target.id,
            fromStatus,
            toStatus: updated.status,
          },
        });
        res.status(200).json({ staff: publicStaff(updated) });
      } catch (error) {
        next(error);
      }
    },
  );

  return router;
};
