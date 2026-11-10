import express from "express";
import pg from "pg";
import request from "supertest";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { ApplicationRouteMount, UsageLimitDatabasePort } from "../radiosoModuleTypes.js";
import { hashStaffPassword } from "./staffCrypto.js";
import { createStaffConsoleRoutes } from "./staffConsoleRoutes.js";
import type { StaffSessionRepository, StaffUserRepository } from "./staffRepository.js";
import type { StaffSession, StaffUser } from "./staffTypes.js";

type RouteDependencies = Parameters<ApplicationRouteMount["createRouter"]>[0];

const MOUNT = "/api/v1/ee/operator-console";
const WORKSPACE_DOMAIN = "radioso.example";
const GOOGLE_SUBJECT = "google-subject-1";

class InertDatabase implements UsageLimitDatabasePort {
  readonly pool = new pg.Pool({ connectionString: "postgres://unused:unused@127.0.0.1:1/unused" });

  async query<T = Record<string, unknown>>(): Promise<T[]> {
    throw new Error("database should not be queried in route unit tests");
  }
}

const createRepositories = async (seed: Partial<StaffUser> = {}) => {
  const staff: StaffUser = {
    id: "11111111-1111-1111-8111-111111111111",
    email: `owner@${WORKSPACE_DOMAIN}`,
    name: "Owner",
    passwordHash: await hashStaffPassword("password-123"),
    googleSubject: null,
    role: "owner",
    status: "active",
    createdAt: new Date(),
    updatedAt: new Date(),
    lastLoginAt: null,
    ...seed,
  };
  const created: StaffUser[] = [];
  const sessionRows = new Map<string, StaffSession>();
  const findById = async (id: string) => [staff, ...created].find((candidate) => candidate.id === id) ?? null;
  const users = {
    async findByEmail(email: string) {
      return [staff, ...created].find((candidate) => candidate.email === email.toLowerCase()) ?? null;
    },
    findById,
    async create(input: Parameters<StaffUserRepository["create"]>[0]) {
      const row: StaffUser = {
        ...staff,
        id: "22222222-2222-4222-8222-222222222222",
        email: input.email,
        name: input.name,
        passwordHash: input.passwordHash,
        googleSubject: null,
        role: input.role,
      };
      created.push(row);
      return row;
    },
    async bindGoogleSubject(id: string, subject: string) {
      const row = await findById(id);
      if (!row || (row.googleSubject !== null && row.googleSubject !== subject)) {
        return false;
      }
      row.googleSubject = subject;
      return true;
    },
    async touchLastLogin() {},
  } as unknown as StaffUserRepository;
  const sessions: StaffSessionRepository = {
    async create(input) {
      const row: StaffSession = {
        id: "33333333-3333-4333-8333-333333333333",
        staffId: input.staffId,
        sessionTokenHash: input.sessionTokenHash,
        expiresAt: input.expiresAt,
        lastSeenAt: new Date(),
        revokedAt: null,
      };
      sessionRows.set(input.sessionTokenHash, row);
      return row;
    },
    async findActiveByTokenHash(tokenHash) {
      return sessionRows.get(tokenHash) ?? null;
    },
    async touch() {},
    async revoke() {},
    async revokeAllForStaff() {
      return 0;
    },
  };
  return { staff, created, users, sessions };
};

const jsonResponse = (status: number, body: unknown): Response =>
  ({ ok: status >= 200 && status < 300, status, json: async () => body }) as unknown as Response;

const googleAnswering = (userinfo: Record<string, unknown>, tokenStatus = 200) =>
  vi.fn(async (input: string) => input.includes("/token")
    ? jsonResponse(tokenStatus, { access_token: "google-access-token" })
    : jsonResponse(200, userinfo)) as unknown as typeof fetch;

const workspaceIdentity = {
  sub: GOOGLE_SUBJECT,
  email: `owner@${WORKSPACE_DOMAIN}`,
  email_verified: true,
  hd: WORKSPACE_DOMAIN,
};

const createApp = async (input: {
  seed?: Partial<StaffUser>;
  fetchImpl?: typeof fetch;
  abuseControlEnforce?: ReturnType<typeof vi.fn>;
} = {}) => {
  const repositories = await createRepositories(input.seed);
  const auditRecord = vi.fn(async () => undefined);
  const logger = { info: vi.fn(), warn: vi.fn() };
  const dependencies = {
    connectorDb: new InertDatabase(),
    env: {
      SESSION_COOKIE_NAME: "customer_session",
      STAFF_SESSION_COOKIE_NAME: "staff_session",
      APP_BASE_URL: "https://app.example.com/",
    },
    auditService: { record: auditRecord },
    abuseControlService: { enforce: input.abuseControlEnforce ?? vi.fn(async () => undefined) },
    requestSource: { digest: () => "host-source-digest" },
    logger,
  } as unknown as RouteDependencies;
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    req.cookies = Object.fromEntries(
      (req.header("cookie") ?? "")
        .split(";")
        .map((part) => part.trim().split("="))
        .filter((parts): parts is [string, string] => parts.length === 2 && Boolean(parts[0])),
    );
    next();
  });
  app.use(MOUNT, createStaffConsoleRoutes(dependencies, {
    users: repositories.users,
    sessions: repositories.sessions,
    fetchImpl: input.fetchImpl ?? googleAnswering(workspaceIdentity),
  }));
  app.use((error: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
    const payload = error as { statusCode?: number; code?: string; message?: string };
    res.status(payload.statusCode ?? 500).json({
      error: { code: payload.code ?? "internal_error", message: payload.message ?? "Internal error" },
    });
  });
  return { app, auditRecord, logger, ...repositories };
};

const useWorkspaceSignIn = () => {
  process.env.STAFF_GOOGLE_WORKSPACE_DOMAIN = ` ${WORKSPACE_DOMAIN.toUpperCase()} `;
  process.env.GOOGLE_LOGIN_CLIENT_ID = "client-id";
  process.env.GOOGLE_LOGIN_CLIENT_SECRET = "client-secret";
};

/** The browser's round trip: `/start` plants the state cookie, Google sends it back to `/callback`. */
const completeGoogleSignIn = async (app: express.Express) => {
  const start = await request(app).get(`${MOUNT}/auth/google/start`).expect(302);
  const state = new URL(start.headers.location).searchParams.get("state") ?? "";
  const stateCookie = (start.headers["set-cookie"] as unknown as string[])[0].split(";")[0];
  return request(app)
    .get(`${MOUNT}/auth/google/callback`)
    .query({ code: "authorization-code", state })
    .set("Cookie", stateCookie)
    .expect(302);
};

const sessionCookieOf = (response: request.Response): string | undefined =>
  (response.headers["set-cookie"] as unknown as string[] | undefined)
    ?.find((cookie) => cookie.startsWith("staff_session=") && !cookie.startsWith("staff_session=;"));

const REFUSED_REDIRECT = "/operator/login?error=google_account_refused";
const FAILURE_REDIRECT = "/operator/login?error=google_sign_in_failed";

describe("operator console Workspace sign-in", () => {
  afterEach(() => {
    delete process.env.STAFF_GOOGLE_WORKSPACE_DOMAIN;
    delete process.env.GOOGLE_LOGIN_CLIENT_ID;
    delete process.env.GOOGLE_LOGIN_CLIENT_SECRET;
  });

  describe("choosing how staff sign in", () => {
    it("keeps password sign-in, and no Google route, until a Workspace domain is set", async () => {
      process.env.GOOGLE_LOGIN_CLIENT_ID = "client-id";
      process.env.GOOGLE_LOGIN_CLIENT_SECRET = "client-secret";
      const { app } = await createApp();

      const methods = await request(app).get(`${MOUNT}/auth/methods`).expect(200);

      expect(methods.body).toEqual({ methods: { password: true, google: false } });
      await request(app).get(`${MOUNT}/auth/google/start`).expect(404);
      await request(app)
        .post(`${MOUNT}/auth/login`)
        .send({ email: `owner@${WORKSPACE_DOMAIN}`, password: "password-123" })
        .expect(200);
    });

    it("turns password sign-in off once a Workspace domain is set, even for the right password", async () => {
      useWorkspaceSignIn();
      const { app } = await createApp();

      const methods = await request(app).get(`${MOUNT}/auth/methods`).expect(200);
      const login = await request(app)
        .post(`${MOUNT}/auth/login`)
        .send({ email: `owner@${WORKSPACE_DOMAIN}`, password: "password-123" })
        .expect(403);

      expect(methods.body).toEqual({ methods: { password: false, google: true } });
      expect(login.body.error.code).toBe("password_sign_in_disabled");
      expect(sessionCookieOf(login)).toBeUndefined();
    });

    it("fails closed when the domain is set but the Google client is missing", async () => {
      process.env.STAFF_GOOGLE_WORKSPACE_DOMAIN = WORKSPACE_DOMAIN;
      const { app, logger } = await createApp();

      const methods = await request(app).get(`${MOUNT}/auth/methods`).expect(200);

      expect(methods.body).toEqual({ methods: { password: false, google: false } });
      await request(app)
        .post(`${MOUNT}/auth/login`)
        .send({ email: `owner@${WORKSPACE_DOMAIN}`, password: "password-123" })
        .expect(403);
      await request(app).get(`${MOUNT}/auth/google/start`).expect(404);
      expect(logger.warn).toHaveBeenCalledWith(
        expect.objectContaining({ missing: ["GOOGLE_LOGIN_CLIENT_ID", "GOOGLE_LOGIN_CLIENT_SECRET"] }),
        expect.any(String),
      );
    });
  });

  describe("signing in", () => {
    it("sends the browser to Google, restricted to the domain, with the console's own callback", async () => {
      useWorkspaceSignIn();
      const { app } = await createApp();

      const start = await request(app).get(`${MOUNT}/auth/google/start`).expect(302);
      const location = new URL(start.headers.location);

      expect(location.origin).toBe("https://accounts.google.com");
      expect(location.searchParams.get("hd")).toBe(WORKSPACE_DOMAIN);
      expect(location.searchParams.get("redirect_uri"))
        .toBe(`https://app.example.com/backend${MOUNT}/auth/google/callback`);
      expect(location.searchParams.get("state")).toBeTruthy();
    });

    it("signs in a listed staff member with a verified Workspace account and remembers the account", async () => {
      useWorkspaceSignIn();
      const { app, staff, auditRecord } = await createApp();

      const callback = await completeGoogleSignIn(app);

      expect(callback.headers.location).toBe("/operator/organizations");
      const sessionCookie = sessionCookieOf(callback);
      expect(sessionCookie).toContain("HttpOnly");
      await request(app).get(`${MOUNT}/auth/me`).set("Cookie", sessionCookie!).expect(200);
      expect(staff.googleSubject).toBe(GOOGLE_SUBJECT);
      expect(auditRecord).toHaveBeenCalledWith(expect.objectContaining({
        eventType: "staff.auth.login",
        eventStatus: "success",
        metadata: { method: "google", targetStaffId: staff.id },
      }));
    });

    it("signs a returning staff member in when the Google account still matches", async () => {
      useWorkspaceSignIn();
      const { app } = await createApp({ seed: { googleSubject: GOOGLE_SUBJECT } });

      const callback = await completeGoogleSignIn(app);

      expect(callback.headers.location).toBe("/operator/organizations");
      expect(sessionCookieOf(callback)).toBeDefined();
    });

    it.each([
      ["an unverified address", { ...workspaceIdentity, email_verified: false }, {}, "email_unverified"],
      ["a personal Google account", { ...workspaceIdentity, hd: undefined }, {}, "wrong_workspace"],
      ["another company's Workspace", { ...workspaceIdentity, hd: "elsewhere.example" }, {}, "wrong_workspace"],
      ["someone who is not staff", { ...workspaceIdentity, email: `stranger@${WORKSPACE_DOMAIN}` }, {}, "not_staff"],
      ["disabled staff", workspaceIdentity, { status: "disabled" as const }, "disabled"],
      ["a different Google account on the same address", { ...workspaceIdentity, sub: "someone-new" }, { googleSubject: GOOGLE_SUBJECT }, "subject_mismatch"],
    ])("refuses %s, opens no session, and records why", async (_label, userinfo, seed, reason) => {
      useWorkspaceSignIn();
      const { app, auditRecord, logger } = await createApp({ seed, fetchImpl: googleAnswering(userinfo) });

      const callback = await completeGoogleSignIn(app);

      expect(callback.headers.location).toBe(REFUSED_REDIRECT);
      expect(sessionCookieOf(callback)).toBeUndefined();
      expect(auditRecord).toHaveBeenCalledWith(expect.objectContaining({
        eventType: "staff.auth.login",
        eventStatus: "failure",
        metadata: expect.objectContaining({ method: "google", reason }),
      }));
      expect(logger.warn).toHaveBeenCalledWith(expect.objectContaining({
        event: "staff_console.sign_in",
        outcome: "failure",
        reason,
      }), expect.any(String));
      expect(JSON.stringify(auditRecord.mock.calls)).not.toContain(`@${WORKSPACE_DOMAIN}`);
      expect(JSON.stringify(logger.warn.mock.calls)).not.toContain(`@${WORKSPACE_DOMAIN}`);
    });

    it("refuses a callback whose state does not match the browser that started it", async () => {
      useWorkspaceSignIn();
      const fetchImpl = googleAnswering(workspaceIdentity);
      const { app, auditRecord } = await createApp({ fetchImpl });

      const callback = await request(app)
        .get(`${MOUNT}/auth/google/callback`)
        .query({ code: "authorization-code", state: "attacker-state" })
        .set("Cookie", "radioso_staff_google_state=victim-state")
        .expect(302);

      expect(callback.headers.location).toBe(FAILURE_REDIRECT);
      expect(fetchImpl).not.toHaveBeenCalled();
      expect(auditRecord).toHaveBeenCalledWith(expect.objectContaining({
        metadata: { method: "google", reason: "invalid_state" },
      }));
    });

    it("reports a failed exchange with Google as a failed sign-in", async () => {
      useWorkspaceSignIn();
      const { app, auditRecord, logger } = await createApp({ fetchImpl: googleAnswering(workspaceIdentity, 500) });

      const callback = await completeGoogleSignIn(app);

      expect(callback.headers.location).toBe(FAILURE_REDIRECT);
      expect(auditRecord).toHaveBeenCalledWith(expect.objectContaining({
        metadata: { method: "google", reason: "oauth_exchange_failed" },
      }));
      expect(logger.warn).toHaveBeenCalledWith(expect.objectContaining({
        event: "staff_console.google_sign_in_error",
        code: "token_exchange_failed",
      }), expect.any(String));
    });

    it("does not tell staff their account was refused when a step of ours broke", async () => {
      useWorkspaceSignIn();
      const { app, users, logger } = await createApp();
      vi.spyOn(users, "findByEmail").mockRejectedValue(new Error("database unavailable"));

      const callback = await completeGoogleSignIn(app);

      expect(callback.headers.location).toBe(FAILURE_REDIRECT);
      expect(logger.warn).toHaveBeenCalledWith(
        expect.objectContaining({ event: "staff_console.google_sign_in_error" }),
        expect.any(String),
      );
    });

    it.each([
      ["start", "ee.staff_console.google.start"],
      ["callback", "ee.staff_console.google.callback"],
    ])("sends a throttled %s back to the sign-in page rather than a JSON error", async (route, scope) => {
      useWorkspaceSignIn();
      const abuseControlEnforce = vi.fn(async (input: { scope: string }) => {
        if (input.scope === scope) {
          throw Object.assign(new Error("Too many requests"), { statusCode: 429 });
        }
      });
      const { app } = await createApp({ abuseControlEnforce });

      const response = await request(app).get(`${MOUNT}/auth/google/${route}`).expect(302);

      expect(response.headers.location).toBe(FAILURE_REDIRECT);
    });

    it("reports a refusal at Google's consent screen as a failed sign-in", async () => {
      useWorkspaceSignIn();
      const { app, auditRecord } = await createApp();

      const callback = await request(app)
        .get(`${MOUNT}/auth/google/callback`)
        .query({ error: "access_denied" })
        .expect(302);

      expect(callback.headers.location).toBe(FAILURE_REDIRECT);
      expect(auditRecord).toHaveBeenCalledWith(expect.objectContaining({
        metadata: { method: "google", reason: "provider_error" },
      }));
    });
  });

  describe("adding staff", () => {
    const signInAsOwner = async (app: express.Express) => {
      const callback = await completeGoogleSignIn(app);
      return sessionCookieOf(callback)!;
    };

    it("needs no password, since the new person signs in with Google", async () => {
      useWorkspaceSignIn();
      const { app, created } = await createApp();
      const cookie = await signInAsOwner(app);

      await request(app)
        .post(`${MOUNT}/staff`)
        .set("Cookie", cookie)
        .send({ email: `new@${WORKSPACE_DOMAIN}`, name: "New", role: "support_read" })
        .expect(201);

      expect(created[0]).toMatchObject({ email: `new@${WORKSPACE_DOMAIN}`, passwordHash: null });
    });

    it("refuses a password that could never be used", async () => {
      useWorkspaceSignIn();
      const { app, created } = await createApp();
      const cookie = await signInAsOwner(app);

      const response = await request(app)
        .post(`${MOUNT}/staff`)
        .set("Cookie", cookie)
        .send({ email: `new@${WORKSPACE_DOMAIN}`, name: "New", role: "support_read", password: "password-1234" })
        .expect(400);

      expect(response.body.error.code).toBe("password_sign_in_disabled");
      expect(created).toEqual([]);
    });

    it("still requires a password while staff sign in with one", async () => {
      const { app, created } = await createApp();
      const login = await request(app)
        .post(`${MOUNT}/auth/login`)
        .send({ email: `owner@${WORKSPACE_DOMAIN}`, password: "password-123" })
        .expect(200);

      await request(app)
        .post(`${MOUNT}/staff`)
        .set("Cookie", (login.headers["set-cookie"] as unknown as string[])[0])
        .send({ email: `new@${WORKSPACE_DOMAIN}`, name: "New", role: "support_read" })
        .expect(400);

      expect(created).toEqual([]);
    });
  });
});
