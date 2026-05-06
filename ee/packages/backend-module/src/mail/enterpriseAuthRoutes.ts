import { createHash, randomBytes, randomUUID } from "node:crypto";

import bcrypt from "bcryptjs";
import { Router, type RequestHandler } from "express";
import { z } from "zod";

import type { UsageLimitDatabasePort } from "../radiosoModuleTypes.js";
import { createEnterpriseEmailService } from "./emailService.js";

interface EnterpriseAuthRouteDependencies {
  connectorDb: UsageLimitDatabasePort;
  env: {
    AUTH_RATE_LIMIT_WINDOW_MS?: number;
    AUTH_RATE_LIMIT_MAX_ATTEMPTS?: number;
  };
  abuseControlService: {
    enforce(input: {
      scope: string;
      subjectKey: string;
      limit: number;
      windowMs: number;
      blockMs?: number;
    }): Promise<unknown>;
  };
  auditService: {
    record(input: {
      accountId?: string | null;
      workspaceId?: string | null;
      eventType: string;
      eventStatus: "success" | "failure";
      metadata?: Record<string, unknown>;
    }): Promise<void>;
  };
}

interface UserRow {
  id: string;
  email: string;
  password_hash: string;
  email_verified_at: Date | string | null;
}

interface TokenRow {
  id: string;
  user_id: string;
  token_hash: string;
  expires_at: Date | string;
  used_at: Date | string | null;
  created_at: Date | string;
}

interface MembershipRow {
  account_id: string;
}

interface AccountRow {
  name: string;
}

interface WorkspaceRow {
  id: string;
  name: string;
  public_route_key: string;
}

const passwordResetRequestSchema = z.object({
  email: z.string().email(),
});

const loginSchema = z.object({
  email: z.string().email(),
  password: z.string().min(1),
  preferredWorkspaceId: z.string().uuid().optional(),
  preferredAccountId: z.string().uuid().optional(),
});

const registerSchema = z.object({
  email: z.string().email(),
  password: z.string().min(8),
  organizationName: z.string().trim().min(1).max(80).optional(),
});

const passwordResetConfirmSchema = z.object({
  token: z.string().min(1),
  password: z.string().min(8),
});

const emailVerificationVerifySchema = z.object({
  token: z.string().min(1),
});

const normalizeEmail = (email: string): string => email.trim().toLowerCase();
const sha256 = (value: string): string => createHash("sha256").update(value).digest("hex");
const generateToken = (): string => randomBytes(32).toString("base64url");
const hashPassword = async (password: string): Promise<string> => bcrypt.hash(password, 12);
const verifyPassword = async (password: string, passwordHash: string): Promise<boolean> =>
  bcrypt.compare(password, passwordHash);
const generatePublicRouteKey = (): string => randomUUID().replace(/\D/g, "").padEnd(10, "0").slice(0, 10);

const deriveOrganizationName = (email: string): string => {
  const localPart = normalizeEmail(email).split("@")[0] ?? "";
  const normalized = localPart.replace(/[._+-]+/g, " ").trim();
  const words = normalized
    .split(/\s+/)
    .filter(Boolean)
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1));

  const label = words.join(" ").trim();
  return `${label.length > 0 ? label : "My"} Organization`;
};

const queryRows = async <T>(database: UsageLimitDatabasePort, text: string, params: unknown[] = []): Promise<T[]> => {
  const result = await database.query<T>(text, params);
  return Array.isArray(result) ? result : result.rows;
};

const parseBody = <T>(schema: z.ZodType<T>, value: unknown): T => {
  const parsed = schema.safeParse(value);
  if (parsed.success) {
    return parsed.data;
  }

  throw {
    statusCode: 400,
    code: "bad_request",
    message: "Invalid auth payload",
    details: parsed.error.flatten(),
  };
};

const unauthorized = (message: string) => ({
  statusCode: 401,
  code: "unauthorized",
  message,
});

const isAppErrorStatus = (error: unknown, statusCode: number): boolean =>
  Boolean(error && typeof error === "object" && "statusCode" in error && error.statusCode === statusCode);

const createEnterpriseRateLimitMiddleware = (
  dependencies: EnterpriseAuthRouteDependencies,
  input: {
    scope: string;
    resolveSubjectKey(req: Parameters<RequestHandler>[0]): string | null | undefined;
  },
): RequestHandler => {
  const limit = dependencies.env.AUTH_RATE_LIMIT_MAX_ATTEMPTS ?? 10;
  const windowMs = dependencies.env.AUTH_RATE_LIMIT_WINDOW_MS ?? 60_000;

  return async (req, _res, next) => {
    const subjectKey = input.resolveSubjectKey(req);
    if (!subjectKey) {
      next();
      return;
    }

    try {
      await dependencies.abuseControlService.enforce({
        scope: input.scope,
        subjectKey,
        limit,
        windowMs,
      });
      next();
    } catch (error) {
      if (isAppErrorStatus(error, 429)) {
        void dependencies.auditService.record({
          eventType: "security.rate_limit_enforced",
          eventStatus: "success",
          metadata: {
            scope: input.scope,
            subjectKey,
          },
        }).catch(() => undefined);
      }
      if (isAppErrorStatus(error, 503)) {
        void dependencies.auditService.record({
          eventType: "security.rate_limit_unavailable",
          eventStatus: "failure",
          metadata: {
            scope: input.scope,
            subjectKey,
          },
        }).catch(() => undefined);
      }
      next(error);
    }
  };
};

const getAppBaseUrl = (): string =>
  process.env.APP_BASE_URL ??
  process.env.RADIOSO_ENTERPRISE_WIDGET_ORIGIN ??
  "http://localhost:3000";

const getTokenTtlMinutes = (): number => {
  const raw = process.env.EE_PASSWORD_RESET_TOKEN_TTL_MINUTES;
  const parsed = raw ? Number.parseInt(raw, 10) : 30;
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 30;
};

const conflict = (message: string) => ({
  statusCode: 409,
  code: "conflict",
  message,
});

const createSessionCookie = async (
  database: UsageLimitDatabasePort,
  input: {
    userId: string;
    accountId: string;
  },
): Promise<string> => {
  const sessionToken = randomBytes(32).toString("hex");
  const ttlHoursRaw = process.env.SESSION_TTL_HOURS;
  const ttlHours = ttlHoursRaw ? Number.parseInt(ttlHoursRaw, 10) : 168;
  const maxAge = (Number.isFinite(ttlHours) && ttlHours > 0 ? ttlHours : 168) * 60 * 60;
  const expiresAt = new Date(Date.now() + maxAge * 1000);

  await database.query(
    `INSERT INTO sessions (id, user_id, account_id, session_token_hash, expires_at)
     VALUES ($1, $2, $3, $4, $5)`,
    [randomUUID(), input.userId, input.accountId, sha256(sessionToken), expiresAt],
  );

  const cookieName = process.env.SESSION_COOKIE_NAME ?? "radioso_session";
  return [
    `${cookieName}=${encodeURIComponent(sessionToken)}`,
    "Max-Age=" + String(maxAge),
    "Path=/",
    "HttpOnly",
    "SameSite=Lax",
    "Secure",
  ].join("; ");
};

const findUserByEmail = async (database: UsageLimitDatabasePort, email: string): Promise<UserRow | null> => {
  const [user] = await queryRows<UserRow>(
    database,
    `SELECT id, email, password_hash, email_verified_at
     FROM users
     WHERE email = $1`,
    [email],
  );
  return user ?? null;
};

const createDefaultWorkspace = async (
  database: UsageLimitDatabasePort,
  accountId: string,
): Promise<WorkspaceRow> => {
  let attempts = 0;

  while (attempts < 5) {
    attempts += 1;
    try {
      const [workspace] = await queryRows<WorkspaceRow>(
        database,
        `INSERT INTO workspaces (id, account_id, name, public_route_key)
         VALUES ($1, $2, $3, $4)
         RETURNING id, name, public_route_key`,
        [randomUUID(), accountId, "Default", generatePublicRouteKey()],
      );

      if (!workspace) {
        throw new Error("Workspace creation returned no row");
      }

      return workspace;
    } catch (error) {
      if (!(error instanceof Error) || !/public_route_key/i.test(error.message) || attempts >= 5) {
        throw error;
      }
    }
  }

  throw new Error("Failed to generate unique workspace route key");
};

const issueVerificationEmail = async (
  database: UsageLimitDatabasePort,
  input: {
    userId: string;
    email: string;
    requestIp?: string | null;
    requestUserAgent?: string | null;
    emailService: ReturnType<typeof createEnterpriseEmailService>;
  },
): Promise<void> => {
  const now = new Date();
  const token = generateToken();
  const expiresAt = new Date(now.getTime() + getTokenTtlMinutes() * 60 * 1000);
  const id = randomUUID();

  await database.query(
    `INSERT INTO ee_email_verification_tokens (
       id,
       user_id,
       token_hash,
       expires_at,
       request_ip,
       request_user_agent
     )
     VALUES ($1, $2, $3, $4, $5, $6)`,
    [id, input.userId, sha256(token), expiresAt, input.requestIp ?? null, input.requestUserAgent ?? null],
  );

  const verificationUrl = new URL("/verify-email", getAppBaseUrl());
  verificationUrl.searchParams.set("token", token);

  try {
    await input.emailService.sendEmailVerificationEmail({
      to: input.email,
      verificationUrl: verificationUrl.toString(),
    });
  } catch (error) {
    await markTokenUsed(database, "ee_email_verification_tokens", id, now);
    throw error;
  }
};

const findUserById = async (database: UsageLimitDatabasePort, id: string): Promise<UserRow | null> => {
  const [user] = await queryRows<UserRow>(
    database,
    `SELECT id, email, password_hash, email_verified_at
     FROM users
     WHERE id = $1`,
    [id],
  );
  return user ?? null;
};

const findToken = async (
  database: UsageLimitDatabasePort,
  tableName: "ee_password_reset_tokens" | "ee_email_verification_tokens",
  token: string,
): Promise<TokenRow | null> => {
  const [record] = await queryRows<TokenRow>(
    database,
    `SELECT id, user_id, token_hash, expires_at, used_at, created_at
     FROM ${tableName}
     WHERE token_hash = $1`,
    [sha256(token)],
  );
  return record ?? null;
};

const findLatestActiveToken = async (
  database: UsageLimitDatabasePort,
  tableName: "ee_password_reset_tokens" | "ee_email_verification_tokens",
  userId: string,
  now: Date,
): Promise<TokenRow | null> => {
  const [record] = await queryRows<TokenRow>(
    database,
    `SELECT id, user_id, token_hash, expires_at, used_at, created_at
     FROM ${tableName}
     WHERE user_id = $1
       AND used_at IS NULL
       AND expires_at > $2
     ORDER BY created_at DESC
     LIMIT 1`,
    [userId, now],
  );
  return record ?? null;
};

const markTokenUsed = async (
  database: UsageLimitDatabasePort,
  tableName: "ee_password_reset_tokens" | "ee_email_verification_tokens",
  id: string,
  usedAt: Date,
): Promise<void> => {
  await database.query(
    `UPDATE ${tableName}
     SET used_at = COALESCE(used_at, $2)
     WHERE id = $1`,
    [id, usedAt],
  );
};

const markAllActiveTokensUsed = async (
  database: UsageLimitDatabasePort,
  tableName: "ee_password_reset_tokens" | "ee_email_verification_tokens",
  userId: string,
  usedAt: Date,
): Promise<void> => {
  await database.query(
    `UPDATE ${tableName}
     SET used_at = COALESCE(used_at, $2)
     WHERE user_id = $1
       AND used_at IS NULL
       AND expires_at > $2`,
    [userId, usedAt],
  );
};

const deleteProvisionedRegistration = async (
  database: UsageLimitDatabasePort,
  input: {
    accountId: string;
    userId: string;
  },
): Promise<void> => {
  await database.query("DELETE FROM accounts WHERE id = $1", [input.accountId]);
  await database.query("DELETE FROM users WHERE id = $1", [input.userId]);
};

const resolveLoginContext = async (
  database: UsageLimitDatabasePort,
  userId: string,
  input: {
    preferredAccountId?: string | null;
    preferredWorkspaceId?: string | null;
  } = {},
): Promise<{
  accountId: string;
  organizationName: string;
  workspaceId: string;
  workspaceName: string;
  workspacePublicRouteKey: string;
}> => {
  const resolveMembership = async (preferredAccountId?: string | null): Promise<MembershipRow | null> => {
    const [record] = await queryRows<MembershipRow>(
      database,
      `SELECT account_id
       FROM account_memberships
       WHERE user_id = $1
         AND status = 'active'
         AND ($2::uuid IS NULL OR account_id = $2::uuid)
       ORDER BY created_at DESC
       LIMIT 1`,
      [userId, preferredAccountId ?? null],
    );
    return record ?? null;
  };
  const membership = await resolveMembership(input.preferredAccountId ?? null) ?? await resolveMembership(null);

  if (!membership) {
    throw unauthorized("Password reset link is invalid or expired");
  }

  const resolveWorkspace = async (preferredWorkspaceId?: string | null): Promise<WorkspaceRow | null> => {
    const [record] = await queryRows<WorkspaceRow>(
      database,
      `SELECT id, name, public_route_key
       FROM workspaces
       WHERE account_id = $1
         AND ($2::uuid IS NULL OR id = $2::uuid)
       ORDER BY
         CASE WHEN name = 'Default' THEN 0 ELSE 1 END,
         created_at DESC
       LIMIT 1`,
      [membership.account_id, preferredWorkspaceId ?? null],
    );
    return record ?? null;
  };
  const workspace = await resolveWorkspace(input.preferredWorkspaceId ?? null) ?? await resolveWorkspace(null);

  if (!workspace) {
    throw unauthorized("Password reset link is invalid or expired");
  }

  const [account] = await queryRows<AccountRow>(
    database,
    `SELECT name
     FROM accounts
     WHERE id = $1`,
    [membership.account_id],
  );

  return {
    accountId: membership.account_id,
    organizationName: account?.name ?? "Organization",
    workspaceId: workspace.id,
    workspaceName: workspace.name,
    workspacePublicRouteKey: workspace.public_route_key,
  };
};

export const createEnterpriseAuthRoutes = (dependencies: EnterpriseAuthRouteDependencies): Router => {
  const router = Router();
  const database = dependencies.connectorDb;
  const emailService = createEnterpriseEmailService();
  const registerRateLimit = createEnterpriseRateLimitMiddleware(dependencies, {
    scope: "ee.auth.register",
    resolveSubjectKey: (req) => {
      const email = typeof req.body?.email === "string" ? req.body.email : null;
      return email ? normalizeEmail(email) : String(req.ip ?? "unknown");
    },
  });
  const loginRateLimit = createEnterpriseRateLimitMiddleware(dependencies, {
    scope: "ee.auth.login",
    resolveSubjectKey: (req) => {
      const email = typeof req.body?.email === "string" ? req.body.email : null;
      return email ? normalizeEmail(email) : String(req.ip ?? "unknown");
    },
  });
  const passwordResetRequestRateLimit = createEnterpriseRateLimitMiddleware(dependencies, {
    scope: "ee.auth.password_reset.request",
    resolveSubjectKey: (req) => {
      const email = typeof req.body?.email === "string" ? req.body.email : null;
      return email ? normalizeEmail(email) : String(req.ip ?? "unknown");
    },
  });
  const tokenRateLimit = (scope: string): RequestHandler => createEnterpriseRateLimitMiddleware(dependencies, {
    scope,
    resolveSubjectKey: (req) => {
      return String(req.ip ?? "unknown");
    },
  });

  router.post("/register", registerRateLimit, async (req, res, next) => {
    try {
      const body = parseBody(registerSchema, req.body);
      const email = normalizeEmail(body.email);
      const existing = await findUserByEmail(database, email);

      if (existing) {
        throw conflict("Account already exists");
      }

      const accountId = randomUUID();
      const userId = accountId;
      const organizationName = body.organizationName?.trim() || deriveOrganizationName(email);
      const passwordHash = await hashPassword(body.password);

      await database.query(
        `INSERT INTO accounts (id, name, email, password_hash)
         VALUES ($1, $2, $3, $4)`,
        [accountId, organizationName, email, passwordHash],
      );

      try {
        await database.query(
          `INSERT INTO users (id, email, password_hash, email_verified_at)
           VALUES ($1, $2, $3, NULL)`,
          [userId, email, passwordHash],
        );
        await database.query(
          `INSERT INTO account_memberships (id, account_id, user_id, role, status)
           VALUES ($1, $2, $3, 'owner', 'active')`,
          [randomUUID(), accountId, userId],
        );
        const workspace = await createDefaultWorkspace(database, accountId);
        await issueVerificationEmail(database, {
          userId,
          email,
          requestIp: req.ip ?? null,
          requestUserAgent: req.get("user-agent") ?? null,
          emailService,
        });
        await database.query(
          `INSERT INTO audit_events (id, account_id, workspace_id, event_type, event_status, metadata_json)
           VALUES ($1, $2, $3, 'auth.register', 'success', $4::jsonb)`,
          [randomUUID(), accountId, workspace.id, JSON.stringify({ email, requiresEmailVerification: true })],
        );

        res.status(201).json({
          userId,
          accountId,
          organizationName,
          workspaceId: workspace.id,
          workspaceName: workspace.name,
          workspacePublicRouteKey: workspace.public_route_key,
          requiresEmailVerification: true,
        });
      } catch (error) {
        await deleteProvisionedRegistration(database, { accountId, userId });
        throw error;
      }
    } catch (error) {
      next(error);
    }
  });

  router.post("/login", loginRateLimit, async (req, res, next) => {
    try {
      const body = parseBody(loginSchema, req.body);
      const email = normalizeEmail(body.email);
      const user = await findUserByEmail(database, email);

      if (!user || !(await verifyPassword(body.password, user.password_hash))) {
        throw unauthorized("Invalid email or password");
      }

      if (!user.email_verified_at) {
        throw unauthorized("Verify your email before signing in");
      }

      const context = await resolveLoginContext(database, user.id, {
        preferredAccountId: body.preferredAccountId ?? null,
        preferredWorkspaceId: body.preferredWorkspaceId ?? null,
      });
      const sessionCookie = await createSessionCookie(database, {
        userId: user.id,
        accountId: context.accountId,
      });

      res.setHeader("Set-Cookie", sessionCookie);
      res.status(200).json({
        userId: user.id,
        accountId: context.accountId,
        organizationName: context.organizationName,
        workspaceId: context.workspaceId,
        workspaceName: context.workspaceName,
        workspacePublicRouteKey: context.workspacePublicRouteKey,
      });
    } catch (error) {
      next(error);
    }
  });

  router.post("/password-reset/request", passwordResetRequestRateLimit, async (req, res, next) => {
    try {
      const body = parseBody(passwordResetRequestSchema, req.body);
      const email = normalizeEmail(body.email);
      const user = await findUserByEmail(database, email);

      if (!user) {
        res.status(202).json({ accepted: true });
        return;
      }

      const token = generateToken();
      const now = new Date();
      const expiresAt = new Date(now.getTime() + getTokenTtlMinutes() * 60 * 1000);
      const id = randomUUID();

      await database.query(
        `INSERT INTO ee_password_reset_tokens (
           id,
           user_id,
           token_hash,
           expires_at,
           request_ip,
           request_user_agent
         )
         VALUES ($1, $2, $3, $4, $5, $6)`,
        [id, user.id, sha256(token), expiresAt, req.ip ?? null, req.get("user-agent") ?? null],
      );

      const resetUrl = new URL("/reset-password", getAppBaseUrl());
      resetUrl.searchParams.set("token", token);

      try {
        await emailService.sendPasswordResetEmail({
          to: email,
          resetUrl: resetUrl.toString(),
        });
      } catch {
        await markTokenUsed(database, "ee_password_reset_tokens", id, now);
      }

      res.status(202).json({ accepted: true });
    } catch (error) {
      next(error);
    }
  });

  router.post("/password-reset/confirm", tokenRateLimit("ee.auth.password_reset.confirm"), async (req, res, next) => {
    try {
      const body = parseBody(passwordResetConfirmSchema, req.body);
      const now = new Date();
      const record = await findToken(database, "ee_password_reset_tokens", body.token);

      if (!record || record.used_at || new Date(record.expires_at) <= now) {
        throw unauthorized("Password reset link is invalid or expired");
      }

      const latestActive = await findLatestActiveToken(database, "ee_password_reset_tokens", record.user_id, now);
      if (!latestActive || latestActive.id !== record.id) {
        await markTokenUsed(database, "ee_password_reset_tokens", record.id, now);
        throw unauthorized("Password reset link is invalid or expired");
      }

      const user = await findUserById(database, record.user_id);
      if (!user) {
        throw unauthorized("Password reset link is invalid or expired");
      }

      const passwordHash = await hashPassword(body.password);
      await database.query(
        `UPDATE users
         SET password_hash = $2,
             email_verified_at = COALESCE(email_verified_at, $3),
             updated_at = NOW()
         WHERE id = $1`,
        [user.id, passwordHash, now],
      );
      await database.query(
        `UPDATE accounts
         SET password_hash = $2,
             updated_at = NOW()
         WHERE id IN (
           SELECT account_id
           FROM account_memberships
           WHERE user_id = $1
         )`,
        [user.id, passwordHash],
      );
      await markAllActiveTokensUsed(database, "ee_password_reset_tokens", user.id, now);
      await database.query(
        `UPDATE sessions
         SET revoked_at = $2
         WHERE user_id = $1
           AND revoked_at IS NULL`,
        [user.id, now],
      );

      const context = await resolveLoginContext(database, user.id);
      const sessionCookie = await createSessionCookie(database, {
        userId: user.id,
        accountId: context.accountId,
      });

      res.setHeader("Set-Cookie", sessionCookie);
      res.status(200).json({
        userId: user.id,
        accountId: context.accountId,
        email: user.email,
        organizationName: context.organizationName,
        workspaceId: context.workspaceId,
        workspaceName: context.workspaceName,
        workspacePublicRouteKey: context.workspacePublicRouteKey,
      });
    } catch (error) {
      next(error);
    }
  });

  router.post("/email-verification/verify", tokenRateLimit("ee.auth.email_verification.verify"), async (req, res, next) => {
    try {
      const body = parseBody(emailVerificationVerifySchema, req.body);
      const now = new Date();
      const record = await findToken(database, "ee_email_verification_tokens", body.token);

      if (!record || record.used_at || new Date(record.expires_at) <= now) {
        throw unauthorized("Verification link is invalid or expired");
      }

      const latestActive = await findLatestActiveToken(database, "ee_email_verification_tokens", record.user_id, now);
      if (!latestActive || latestActive.id !== record.id) {
        await markTokenUsed(database, "ee_email_verification_tokens", record.id, now);
        throw unauthorized("Verification link is invalid or expired");
      }

      await database.query(
        `UPDATE users
         SET email_verified_at = COALESCE(email_verified_at, $2),
             updated_at = NOW()
         WHERE id = $1`,
        [record.user_id, now],
      );
      await markAllActiveTokensUsed(database, "ee_email_verification_tokens", record.user_id, now);

      res.status(200).json({ verified: true });
    } catch (error) {
      next(error);
    }
  });

  return router;
};
