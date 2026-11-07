import { Router, type Request, type RequestHandler, type Response } from "express";
import { z } from "zod";

import type { ConversationSpend } from "../conversationSpend/conversationSpend.js";
import { ConversationSpendService } from "../conversationSpend/conversationSpendService.js";
import type { ApplicationRouteMount } from "../radiosoModuleTypes.js";
import { HttpError } from "../shared/httpError.js";
import { createRateLimitMiddleware } from "../shared/rateLimit.js";
import { EnterpriseUsageLimitService } from "../usageLimits/usageLimitService.js";
import type { AccountUsageSummary, UsageLimitProfile } from "../usageLimits/usageLimitService.js";
import { OrganizationDirectoryService } from "./organizationDirectoryService.js";
import type { OrganizationDirectoryPage } from "./organizationDirectoryService.js";
import { StaffAuthService, defaultStaffSessionTtlHours, type StaffAuthResult } from "./staffAuthService.js";
import { hashStaffPassword, STAFF_PASSWORD_MIN_LENGTH } from "./staffCrypto.js";
import { PostgresStaffSessionRepository, type StaffSessionRepository } from "./staffSessionRepository.js";
import { PostgresStaffUserRepository, type StaffUserRepository } from "./staffRepository.js";
import { createStaffGoogleSignInRouter } from "./staffGoogleSignInRoutes.js";
import { requireJsonWrites, requireStaffRole, requireStaffSession, type StaffPrincipal } from "./staffGuards.js";
import { StaffSecurityEvents } from "./staffSecurityEvents.js";
import { staffRoles, staffStatuses, type StaffUser } from "./staffTypes.js";
import { resolveStaffSignIn } from "./staffWorkspaceSignIn.js";

type RouteDependencies = Parameters<ApplicationRouteMount["createRouter"]>[0];

const loginBodySchema = z.object({
  email: z.string().trim().email(),
  password: z.string().min(1),
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
  password: z.string().min(STAFF_PASSWORD_MIN_LENGTH).optional(),
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
  throw new HttpError(400, "bad_request", message, parsed.error.flatten());
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

// A route mount standing alone in a test gets no logger, so each method is
// optional at the call site; the shape itself is the host's, declared once.
type StaffConsoleLogger = Partial<NonNullable<RouteDependencies["logger"]>>;

const resolveLogger = (dependencies: RouteDependencies): StaffConsoleLogger => dependencies.logger ?? {};

/** Puts each account's conversation spend for the month on its directory row, next to its tier. */
const withConversationSpend = (page: OrganizationDirectoryPage, spend: ReadonlyMap<string, ConversationSpend>) => ({
  ...page,
  rows: page.rows.map((row) => ({ ...row, conversationSpend: spend.get(row.accountId) ?? null })),
});

interface StaffConsoleRouteRepositories {
  users?: StaffUserRepository;
  sessions?: StaffSessionRepository;
  organizationDirectoryService?: Pick<OrganizationDirectoryService, "listOrganizations" | "getOrganizationName">;
  conversationSpendService?: Pick<ConversationSpendService, "listForAccounts" | "getRecentMonths">;
  usageLimitService?: Pick<
    EnterpriseUsageLimitService,
    "getAccountUsage" | "listProfiles" | "assignProfile" | "upsertProfile"
  >;
  fetchImpl?: typeof fetch;
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
  const logger = resolveLogger(dependencies);
  const securityEvents = new StaffSecurityEvents(dependencies.auditService, logger);
  const authService = new StaffAuthService(users, sessions, securityEvents, { ttlHours });
  const signIn = resolveStaffSignIn({ appBaseUrl: dependencies.env.APP_BASE_URL });
  if (signIn.mode === "workspace" && !signIn.oauth) {
    logger.warn?.(
      { event: "staff_console.sign_in_unavailable", missing: signIn.missing },
      "Operator console sign-in is closed: Workspace sign-in is on but its configuration is incomplete",
    );
  }
  const setSessionCookie = (res: Response, session: StaffAuthResult): void => {
    res.cookie(cookieName, session.sessionToken, {
      httpOnly: true,
      sameSite: "lax",
      secure: process.env.NODE_ENV === "production",
      path: "/",
      expires: session.expiresAt,
    });
  };
  const organizationDirectoryService =
    repositories.organizationDirectoryService ?? new OrganizationDirectoryService(dependencies.connectorDb);
  const usageLimitService =
    repositories.usageLimitService ?? new EnterpriseUsageLimitService(dependencies.connectorDb);
  const conversationSpendService =
    repositories.conversationSpendService ?? new ConversationSpendService(dependencies.connectorDb);

  // The login endpoint has no session yet, so it is the one route in this router throttled
  // pre-auth. The per-address budget stops guessing one account from many sources; the per-source
  // budget stops one source spraying many addresses. Both mirror the OSS backend's `auth.login`
  // limit (js/missing-rate-limiting flagged this route when it had none).
  const loginRateLimit = (scope: string, resolveSubjectKey: (req: Request, res: Response) => string | null) =>
    createRateLimitMiddleware({
      service: dependencies.abuseControlService,
      auditService: dependencies.auditService,
      scope,
      limit: dependencies.env.AUTH_RATE_LIMIT_MAX_ATTEMPTS ?? 10,
      windowMs: dependencies.env.AUTH_RATE_LIMIT_WINDOW_MS ?? 60_000,
      resolveSubjectKey,
    });
  const staffLoginSourceRateLimit = loginRateLimit(
    "ee.staff_console.auth.login_source",
    (req, res) => `source:${dependencies.requestSource.digest(req, res)}`,
  );
  const staffLoginRateLimit = loginRateLimit(
    "ee.staff_console.auth.login",
    (req) => (typeof req.body?.email === "string" ? req.body.email.trim().toLowerCase() : null),
  );

  const hasSessionCookie = (req: Request): boolean => {
    const sessionToken: unknown = req.cookies?.[cookieName];
    return typeof sessionToken === "string" && sessionToken.length > 0;
  };

  // A session cookie costs a database lookup before anyone is known, so this budget comes first.
  // A request without one is refused for free and spends nothing. The limit is well above what a
  // few people using the console send, and only bounds a flood.
  const staffSessionSourceRateLimit = createRateLimitMiddleware({
    service: dependencies.abuseControlService,
    auditService: dependencies.auditService,
    scope: "ee.staff_console.session_source",
    limit: 300,
    windowMs: 60_000,
    resolveSubjectKey: (req, res) =>
      (hasSessionCookie(req) ? `source:${dependencies.requestSource.digest(req, res)}` : null),
  });

  // Authentication narrows the caller pool but is not a rate limit: a compromised or malicious
  // staff session could still hammer the directory, tier, or staff-management endpoints. This
  // budget is enforced once per authenticated request, right after the session check succeeds,
  // so it covers every guarded route from one place. No EE-specific rate-limit env knob is threaded
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

  const authenticateStaffSession = requireStaffSession(authService, cookieName);
  const staffSessionGuard: RequestHandler = (req, res, next) => {
    authenticateStaffSession(req, res, (error?: unknown) => {
      if (error) {
        // A broken lookup is a fault, not a rejected caller, and the error handler reports it.
        if (error instanceof HttpError && error.statusCode === 401) {
          logger.warn?.({
            event: "staff_console.session_rejected",
            method: req.method,
            path: req.path,
            reason: hasSessionCookie(req) ? "invalid_session" : "missing_session",
          }, "Staff console session rejected");
        }
        next(error);
        return;
      }
      staffSessionRateLimit(req, res, next);
    });
  };
  const logStaffRead = (input: {
    action: string;
    targetId?: (req: Parameters<RequestHandler>[0]) => string | null;
  }): RequestHandler => (req, res, next) => {
    const staff = res.locals.staff as StaffPrincipal;
    logger.info?.({
      event: "staff_console.read_auth",
      action: input.action,
      targetId: input.targetId?.(req) ?? null,
      staffId: staff.id,
      role: staff.role,
      outcome: "success",
    }, "Staff console read authentication succeeded");
    next();
  };

  const requirePasswordSignIn: RequestHandler = (_req, _res, next) => {
    next(signIn.mode === "password"
      ? undefined
      : new HttpError(403, "password_sign_in_disabled", "Sign in with Google."));
  };

  router.use(requireJsonWrites);

  // Only routes that exist without a session go above this guard. Its position is the rule:
  // anything registered below it answers 401 to a caller without a staff session.
  router.get("/auth/methods", (_req, res) => {
    res.status(200).json({
      methods: {
        password: signIn.mode === "password",
        google: signIn.mode === "workspace" && signIn.oauth !== null,
      },
    });
  });

  router.use("/auth/google", createStaffGoogleSignInRouter({
    oauth: signIn.mode === "workspace" ? signIn.oauth : null,
    workspaceDomain: signIn.mode === "workspace" ? signIn.workspaceDomain : null,
    authService,
    events: securityEvents,
    createEntryRateLimit: (scope) => loginRateLimit(scope, (req, res) => `source:${dependencies.requestSource.digest(req, res)}`),
    setSessionCookie,
    logger,
    fetchImpl: repositories.fetchImpl,
  }));

  router.post("/auth/login", requirePasswordSignIn, staffLoginSourceRateLimit, staffLoginRateLimit, async (req, res, next) => {
    try {
      const body = parseRequest(loginBodySchema, req.body, "Invalid staff login payload");
      const result = await authService.login(body);
      setSessionCookie(res, result);
      res.status(200).json({ staff: publicStaff(result.staff) });
    } catch (error) {
      next(error);
    }
  });

  router.use(staffSessionSourceRateLimit, staffSessionGuard);

  router.post("/auth/logout", async (req, res, next) => {
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

  router.get("/auth/me", (_req, res) => {
    res.status(200).json({ staff: res.locals.staff });
  });

  router.get(
    "/organizations",
    logStaffRead({ action: "organizations.list" }),
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
        const spend = await conversationSpendService.listForAccounts(page.rows.map((row) => row.accountId));
        res.status(200).json(withConversationSpend(page, spend));
      } catch (error) {
        next(error);
      }
    },
  );

  router.get(
    "/organizations/:accountId/usage",
    logStaffRead({
      action: "organizations.usage.read",
      targetId: (req) => String(req.params.accountId),
    }),
    async (req, res, next) => {
      try {
        const { accountId } = parseRequest(accountIdParamsSchema, req.params, "Invalid organization identifier");
        const [usage, organizationName, conversationSpend] = await Promise.all([
          usageLimitService.getAccountUsage(accountId),
          organizationDirectoryService.getOrganizationName(accountId),
          conversationSpendService.getRecentMonths(accountId),
        ]);
        res.status(200).json({ ...usage, organizationName, conversationSpend });
      } catch (error) {
        next(error);
      }
    },
  );

  router.get(
    "/tiers",
    logStaffRead({ action: "tiers.list" }),
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
    requireStaffRole("owner"),
    async (req, res, next) => {
      try {
        const body = parseRequest(staffCreateBodySchema, req.body, "Invalid staff create payload");
        const existing = await users.findByEmail(body.email);
        if (existing) {
          throw new HttpError(409, "conflict", "Staff user already exists.");
        }
        if (signIn.mode === "workspace" && body.password !== undefined) {
          throw new HttpError(400, "password_sign_in_disabled", "Staff sign in with Google here, so a password would never be used.");
        }
        if (signIn.mode === "password" && body.password === undefined) {
          throw new HttpError(400, "bad_request", "A temporary password is required.");
        }
        const passwordHash = body.password === undefined ? null : await hashStaffPassword(body.password);
        const staff = await users.create({
          email: body.email,
          name: body.name,
          passwordHash,
          role: body.role,
          status: "active",
        });
        await securityEvents.privilegedChange({
          eventType: "staff.user.created",
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
        await securityEvents.privilegedChange({
          eventType: "staff.user.role_changed",
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
        await securityEvents.privilegedChange({
          eventType: "staff.user.status_changed",
          metadata: {
            actorStaffId: res.locals.staff.id,
            targetStaffId: target.id,
            fromStatus,
            toStatus: updated.status,
          },
        });
        // After the record: a disabled identity is already refused on every request, so this
        // failing leaves nothing usable, while the change itself must not go unreported.
        if (updated.status === "disabled") {
          await sessions.revokeAllForStaff(updated.id);
        }
        res.status(200).json({ staff: publicStaff(updated) });
      } catch (error) {
        next(error);
      }
    },
  );

  return router;
};
