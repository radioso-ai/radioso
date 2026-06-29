import express from "express";
import pg from "pg";
import request from "supertest";
import { describe, expect, it, vi, afterEach } from "vitest";

import type { ApplicationRouteMount, UsageLimitDatabasePort } from "../radiosoModuleTypes.js";
import { hashStaffPassword } from "./staffCrypto.js";
import { createStaffConsoleRoutes } from "./staffConsoleRoutes.js";
import type { StaffPrincipal } from "./staffGuards.js";
import type { StaffSessionRepository, StaffUserRepository } from "./staffRepository.js";

class InertDatabase implements UsageLimitDatabasePort {
  readonly pool = new pg.Pool({ connectionString: "postgres://unused:unused@127.0.0.1:1/unused" });

  async query<T = Record<string, unknown>>(): Promise<T[]> {
    throw new Error("database should not be queried in route unit tests");
  }
}

type RouteDependencies = Parameters<ApplicationRouteMount["createRouter"]>[0];

const createDependencies = (input: {
  users: StaffUserRepository;
  sessions: StaffSessionRepository;
  auditRecord?: ReturnType<typeof vi.fn>;
}): RouteDependencies => ({
  connectorDb: new InertDatabase(),
  env: {
    SESSION_COOKIE_NAME: "customer_session",
    STAFF_SESSION_COOKIE_NAME: "staff_session",
    STAFF_SESSION_TTL_HOURS: 1,
  },
  auditService: {
    record: input.auditRecord ?? vi.fn(async () => undefined),
  },
} as unknown as RouteDependencies);

const createApp = (dependencies: RouteDependencies, repositories: {
  users: StaffUserRepository;
  sessions: StaffSessionRepository;
}) => {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    const cookieHeader = req.header("cookie") ?? "";
    req.cookies = Object.fromEntries(
      cookieHeader
        .split(";")
        .map((part) => part.trim().split("="))
        .filter((parts): parts is [string, string] => parts.length === 2 && Boolean(parts[0])),
    );
    next();
  });
  app.use("/api/v1/ee/operator-console", createStaffConsoleRoutes(dependencies, repositories));
  app.use((error: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
    const payload = error as { statusCode?: number; code?: string; message?: string };
    res.status(payload.statusCode ?? 500).json({
      error: {
        code: payload.code ?? "internal_error",
        message: payload.message ?? "Internal error",
      },
    });
  });
  return app;
};

const createMemoryRepositories = async (initialRole: StaffPrincipal["role"] = "owner") => {
  const staff = {
    id: "11111111-1111-1111-1111-111111111111",
    email: "owner@example.com",
    name: "Owner",
    passwordHash: await hashStaffPassword("password-123"),
    role: initialRole,
    status: "active" as const,
    createdAt: new Date(),
    updatedAt: new Date(),
    lastLoginAt: null,
  };
  const sessions = new Map<string, { staffId: string; expiresAt: Date; revokedAt: Date | null }>();
  const users: StaffUserRepository = {
    async findByEmail(email) {
      return email.toLowerCase() === staff.email ? staff : null;
    },
    async findById(id) {
      return id === staff.id ? staff : null;
    },
    async create(input) {
      Object.assign(staff, input);
      return staff;
    },
    async updatePassword(id, passwordHash) {
      if (id === staff.id) {
        staff.passwordHash = passwordHash;
        staff.status = "active";
      }
      return staff;
    },
    async setRole(_id, role) {
      staff.role = role;
      return staff;
    },
    async setStatus(_id, status) {
      staff.status = status;
      return staff;
    },
    async touchLastLogin() {},
  };
  const staffSessions: StaffSessionRepository = {
    async create(input) {
      sessions.set(input.sessionTokenHash, {
        staffId: input.staffId,
        expiresAt: input.expiresAt,
        revokedAt: null,
      });
      return {
        id: "22222222-2222-2222-2222-222222222222",
        staffId: input.staffId,
        sessionTokenHash: input.sessionTokenHash,
        expiresAt: input.expiresAt,
        revokedAt: null,
      };
    },
    async findActiveByTokenHash(tokenHash) {
      const row = sessions.get(tokenHash);
      if (!row || row.revokedAt || row.expiresAt <= new Date()) {
        return null;
      }
      return {
        id: "22222222-2222-2222-2222-222222222222",
        staffId: row.staffId,
        sessionTokenHash: tokenHash,
        expiresAt: row.expiresAt,
        revokedAt: row.revokedAt,
      };
    },
    async touch() {},
    async revoke(tokenHash) {
      const row = sessions.get(tokenHash);
      if (row) {
        row.revokedAt = new Date();
      }
    },
  };
  return { users, staffSessions, staff };
};

describe("staff console routes and guards", () => {
  afterEach(() => {
    delete process.env.EE_USAGE_ADMIN_TOKEN;
  });

  it("rejects missing staff sessions and ignores customer session cookies", async () => {
    const repositories = await createMemoryRepositories();
    const app = createApp(createDependencies({
      users: repositories.users,
      sessions: repositories.staffSessions,
    }), { users: repositories.users, sessions: repositories.staffSessions });

    await request(app).get("/api/v1/ee/operator-console/auth/me").expect(401);
    await request(app)
      .get("/api/v1/ee/operator-console/auth/me")
      .set("Cookie", "customer_session=valid-customer-token")
      .expect(401);
  });

  it("logs in, returns the staff principal, and logs out", async () => {
    const repositories = await createMemoryRepositories("billing_write");
    const app = createApp(createDependencies({
      users: repositories.users,
      sessions: repositories.staffSessions,
    }), { users: repositories.users, sessions: repositories.staffSessions });

    const login = await request(app)
      .post("/api/v1/ee/operator-console/auth/login")
      .send({ email: "owner@example.com", password: "password-123" })
      .expect(200);

    expect(login.body.staff).toMatchObject({ email: "owner@example.com", role: "billing_write" });
    const cookie = login.headers["set-cookie"][0];

    await request(app)
      .get("/api/v1/ee/operator-console/auth/me")
      .set("Cookie", cookie)
      .expect(200);

    await request(app)
      .post("/api/v1/ee/operator-console/auth/logout")
      .set("Cookie", cookie)
      .expect(204);
  });

  it("default-denies role-gated routes", async () => {
    const repositories = await createMemoryRepositories("support_read");
    const app = createApp(createDependencies({
      users: repositories.users,
      sessions: repositories.staffSessions,
    }), { users: repositories.users, sessions: repositories.staffSessions });

    const login = await request(app)
      .post("/api/v1/ee/operator-console/auth/login")
      .send({ email: "owner@example.com", password: "password-123" })
      .expect(200);

    await request(app)
      .get("/api/v1/ee/operator-console/_test/billing-write")
      .set("Cookie", login.headers["set-cookie"][0])
      .expect(403);
  });

  it("allows billing_write and owner through billing_write role gates", async () => {
    for (const role of ["billing_write", "owner"] as const) {
      const repositories = await createMemoryRepositories(role);
      const app = createApp(createDependencies({
        users: repositories.users,
        sessions: repositories.staffSessions,
      }), { users: repositories.users, sessions: repositories.staffSessions });
      const login = await request(app)
        .post("/api/v1/ee/operator-console/auth/login")
        .send({ email: "owner@example.com", password: "password-123" })
        .expect(200);

      await request(app)
        .get("/api/v1/ee/operator-console/_test/billing-write")
        .set("Cookie", login.headers["set-cookie"][0])
        .expect(204);
    }
  });

  it("bootstraps the first owner with the admin token and audits the action", async () => {
    process.env.EE_USAGE_ADMIN_TOKEN = "secret-admin-token";
    const auditRecord = vi.fn(async () => undefined);
    const repositories = await createMemoryRepositories();
    const app = createApp(createDependencies({
      users: repositories.users,
      sessions: repositories.staffSessions,
      auditRecord,
    }), { users: repositories.users, sessions: repositories.staffSessions });

    await request(app)
      .post("/api/v1/ee/operator-console/bootstrap")
      .set("Authorization", "Bearer secret-admin-token")
      .send({ email: "first-owner@example.com", name: "First Owner", password: "password-123" })
      .expect(200);

    expect(repositories.staff).toMatchObject({
      email: "first-owner@example.com",
      role: "owner",
      status: "active",
    });
    expect(auditRecord).toHaveBeenCalledWith(expect.objectContaining({
      eventType: "staff.bootstrap",
      eventStatus: "success",
      metadata: expect.objectContaining({ actor: "staff.bootstrap" }),
    }));
  });

  it("rejects absent or invalid bootstrap admin tokens without creating staff", async () => {
    process.env.EE_USAGE_ADMIN_TOKEN = "secret-admin-token";
    const repositories = await createMemoryRepositories();
    const createSpy = vi.spyOn(repositories.users, "create");
    const app = createApp(createDependencies({
      users: repositories.users,
      sessions: repositories.staffSessions,
    }), { users: repositories.users, sessions: repositories.staffSessions });

    await request(app)
      .post("/api/v1/ee/operator-console/bootstrap")
      .send({ email: "first-owner@example.com", name: "First Owner", password: "password-123" })
      .expect(401);
    await request(app)
      .post("/api/v1/ee/operator-console/bootstrap")
      .set("Authorization", "Bearer wrong")
      .send({ email: "first-owner@example.com", name: "First Owner", password: "password-123" })
      .expect(401);

    expect(createSpy).not.toHaveBeenCalled();
  });

  it("resets a locked-out owner credential through bootstrap", async () => {
    process.env.EE_USAGE_ADMIN_TOKEN = "secret-admin-token";
    const repositories = await createMemoryRepositories("owner");
    await repositories.users.setStatus(repositories.staff.id, "disabled");
    const app = createApp(createDependencies({
      users: repositories.users,
      sessions: repositories.staffSessions,
    }), { users: repositories.users, sessions: repositories.staffSessions });

    await request(app)
      .post("/api/v1/ee/operator-console/bootstrap")
      .set("Authorization", "Bearer secret-admin-token")
      .send({ email: "owner@example.com", name: "Owner", password: "new-password-123" })
      .expect(200);

    await request(app)
      .post("/api/v1/ee/operator-console/auth/login")
      .send({ email: "owner@example.com", password: "new-password-123" })
      .expect(200);
  });
});
