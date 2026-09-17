import { Router, type RequestHandler } from "express";
import { z } from "zod";

import type { ApplicationRouteMount } from "../radiosoModuleTypes.js";
import { HttpError } from "../shared/httpError.js";
import { createRateLimitMiddleware } from "../shared/rateLimit.js";
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
  monthlyConversationLimit: nullableLimitSchema.optional(),
  repliesPerConversation: z.number().int().min(1).max(1000).optional(),
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

// Marks the 401 as already logged by the read-auth guard, so the catch block below it
// does not emit a duplicate "invalid_session" warning for a request with no session cookie.
class ReadAuthUnauthorizedError extends HttpError {
  readonly readAuthLogged = true;

  constructor() {
    super(401, "unauthorized", "Unauthorized");
  }
}

const parseRequest = <T>(schema: z.ZodType<T>, value: unknown, message: string): T => {
  const parsed = schema.safeParse(value);
  if (parsed.success) {
    return parsed.data;
  }
  throw new HttpError(400, "bad_request", message, parsed.error.flatten());
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
  return value || "radioso_staff_session";
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

interface StaffConsoleRouteRepositories {
  users?: StaffUserRepository;
  sessions?: StaffSessionRepository;
  organizationDirectoryService?: Pick<OrganizationDirectoryService, "listOrganizations" | "getOrganizationName">;
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

  // The login endpoint has no session yet, so it is the one route in this router throttled
  // pre-auth -- per attempted email, falling back to source IP -- mirroring the OSS backend's
  // own `auth.login` limiter (js/missing-rate-limiting correctly flagged this route: unlike
  // OSS's authRoutes.ts, it had no limiter at all).
  const staffLoginRateLimit = createRateLimitMiddleware({
    service: dependencies.abuseControlService,
    auditService: dependencies.auditService,
    scope: "ee.staff_console.auth.login",
    limit: dependencies.env.AUTH_RATE_LIMIT_MAX_ATTEMPTS ?? 10,
    windowMs: dependencies.env.AUTH_RATE_LIMIT_WINDOW_MS ?? 60_000,
    resolveSubjectKey: (req) => {
      const email = typeof req.body?.email === "string" ? req.body.email.trim().toLowerCase() : null;
      return email || String(req.ip ?? "unknown");
    },
  });

  // Every other route in this router runs behind an authenticated staff session. Authentication
  // narrows the caller pool but is not a rate limit: a compromised or malicious staff session
  // could still hammer the directory, tier, or staff-management endpoints. This budget is
  // enforced once per authenticated request, right after the session check succeeds, so it
  // covers every guarded route from one place. No EE-specific rate-limit env knob is threaded
  // through yet, so the limit mirrors the magnitude of OSS's own authenticated-route default
  // (`EXPENSIVE_AUTHENTICATED_RATE_LIMIT_*`, 60 requests / 60s) as a literal.
  const staffSessionRateLimit = createRateLimitMiddleware({
    service: dependencies.abuseControlService,
    auditService: dependencies.auditService,
    scope: "ee.staff_console.session",
    limit: 60,
    windowMs: 60_000,
    resolveSubjectKey: (_req, res) => {
      const staff = res.locals.staff as { id?: string } | undefined;
      return staff?.id ? `staff:${staff.id}` : null;
    },
  });

  // Kept as a single `RequestHandler` (not `[authenticate, rateLimit]`) so every call site's
  // route-handler argument still gets Express's normal parameter-type inference; an array here
  // makes the compiler fall back to implicit `any` for req/res/next on every downstream handler.
  const authenticateStaffSession = requireStaffSession(authService, cookieName);
  const staffSessionGuard: RequestHandler = (req, res, next) => {
    authenticateStaffSession(req, res, (error?: unknown) => {
      if (error) {
        next(error);
        return;
      }
      staffSessionRateLimit(req, res, next);
    });
  };
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
        throw new ReadAuthUnauthorizedError();
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
      // Shares the session-wide budget every other guarded route enforces, rather than
      // calling `next()` directly, so read routes are bounded the same way write routes are.
      staffSessionRateLimit(req, res, next);
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

  router.post("/auth/login", staffLoginRateLimit, async (req, res, next) => {
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
        const [usage, organizationName] = await Promise.all([
          usageLimitService.getAccountUsage(accountId),
          organizationDirectoryService.getOrganizationName(accountId),
        ]);
        res.status(200).json({ ...usage, organizationName });
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
        const hasStoredIndexedByteLimit = Object.prototype.hasOwnProperty.call(body, "storedIndexedByteLimit");
        const hasMonthlyIndexedByteLimit = Object.prototype.hasOwnProperty.call(body, "monthlyIndexedByteLimit");
        const hasMonthlyConversationLimit = Object.prototype.hasOwnProperty.call(body, "monthlyConversationLimit");
        const hasRepliesPerConversation = Object.prototype.hasOwnProperty.call(body, "repliesPerConversation");
        // The service treats a key's mere presence on this object as "the caller named this
        // field" (omitted = preserve, explicit null = clear). A key set to `undefined` still
        // counts as present in JS, so each optional field is spread in only when the request
        // body actually carried it — never assigned unconditionally with a `?? null` fallback.
        const profile = await usageLimitService.upsertProfile({
          key: profileKey,
          displayName: body.displayName,
          monthlyAnswerLimit: body.monthlyAnswerLimit,
          storedDocumentLimit: body.storedDocumentLimit,
          ...(hasStoredIndexedByteLimit ? { storedIndexedByteLimit: body.storedIndexedByteLimit ?? null } : {}),
          ...(hasMonthlyIndexedByteLimit ? { monthlyIndexedByteLimit: body.monthlyIndexedByteLimit ?? null } : {}),
          ...(hasMonthlyConversationLimit ? { monthlyConversationLimit: body.monthlyConversationLimit } : {}),
          ...(hasRepliesPerConversation ? { repliesPerConversation: body.repliesPerConversation } : {}),
        });
        const fields = [
          "monthlyAnswerLimit",
          "storedDocumentLimit",
          ...(hasStoredIndexedByteLimit ? ["storedIndexedByteLimit"] : []),
          ...(hasMonthlyIndexedByteLimit ? ["monthlyIndexedByteLimit"] : []),
          ...(hasMonthlyConversationLimit ? ["monthlyConversationLimit"] : []),
          ...(hasRepliesPerConversation ? ["repliesPerConversation"] : []),
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
          throw new HttpError(409, "conflict", "Staff user already exists.");
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
          throw new HttpError(404, "not_found", "Staff user not found.");
        }
        if (target.id === res.locals.staff.id && target.role === "owner" && body.role !== "owner") {
          throw new HttpError(409, "conflict", "Owners cannot demote their own account.");
        }
        if (target.role === "owner" && target.status === "active" && body.role !== "owner") {
          const activeOwners = await users.countActiveOwners();
          if (activeOwners <= 1) {
            throw new HttpError(409, "conflict", "Cannot demote the last active owner.");
          }
        }
        const fromRole = target.role;
        const updated = await users.setRole(staffId, body.role);
        if (!updated) {
          throw new HttpError(404, "not_found", "Staff user not found.");
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
          throw new HttpError(404, "not_found", "Staff user not found.");
        }
        if (target.id === res.locals.staff.id && body.status === "disabled") {
          throw new HttpError(409, "conflict", "Owners cannot disable their own account.");
        }
        if (target.role === "owner" && target.status === "active" && body.status === "disabled") {
          const activeOwners = await users.countActiveOwners();
          if (activeOwners <= 1) {
            throw new HttpError(409, "conflict", "Cannot disable the last active owner.");
          }
        }
        const fromStatus = target.status;
        const updated = await users.setStatus(staffId, body.status);
        if (!updated) {
          throw new HttpError(404, "not_found", "Staff user not found.");
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
