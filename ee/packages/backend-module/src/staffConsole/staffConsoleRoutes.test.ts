import express from "express";
import pg from "pg";
import request from "supertest";
import { describe, expect, it, vi, afterEach } from "vitest";

import type { ApplicationRouteMount, UsageLimitDatabasePort } from "../radiosoModuleTypes.js";
import type { AccountUsageSummary, UsageLimitProfile } from "../usageLimits/usageLimitService.js";
import { hashStaffPassword } from "./staffCrypto.js";
import { createStaffConsoleRoutes } from "./staffConsoleRoutes.js";
import { requireStaffRole, type StaffPrincipal } from "./staffGuards.js";
import type { StaffSessionRepository, StaffUserRepository } from "./staffRepository.js";
import type { OrganizationDirectoryService } from "./organizationDirectoryService.js";
import type { StaffRole, StaffStatus, StaffUser } from "./staffTypes.js";

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
  logger?: {
    info: ReturnType<typeof vi.fn>;
    warn: ReturnType<typeof vi.fn>;
  };
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
  logger: input.logger,
} as unknown as RouteDependencies);

const createApp = (dependencies: RouteDependencies, repositories: {
  users: StaffUserRepository;
  sessions: StaffSessionRepository;
  organizationDirectoryService?: OrganizationDirectoryService;
  usageLimitService?: {
    getAccountUsage(accountId: string): Promise<AccountUsageSummary>;
    listProfiles(): Promise<UsageLimitProfile[]>;
    assignProfile?(accountId: string, profileKey: string | null): Promise<AccountUsageSummary>;
    upsertProfile?(input: {
      key: string;
      displayName: string;
      monthlyAnswerLimit: number | null;
      storedDocumentLimit: number | null;
      storedIndexedByteLimit?: number | null;
      monthlyIndexedByteLimit?: number | null;
    }): Promise<UsageLimitProfile>;
  };
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
  const staff: StaffUser = {
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
  const staffById = new Map<string, StaffUser>([[staff.id, staff]]);
  const sessions = new Map<string, { staffId: string; expiresAt: Date; revokedAt: Date | null }>();
  const users: StaffUserRepository = {
    async findByEmail(email) {
      return Array.from(staffById.values()).find((candidate) => candidate.email === email.toLowerCase()) ?? null;
    },
    async findById(id) {
      return staffById.get(id) ?? null;
    },
    async create(input) {
      const existing = Array.from(staffById.values()).find((candidate) => candidate.email === input.email.toLowerCase());
      if (existing) {
        Object.assign(existing, {
          email: input.email.toLowerCase(),
          name: input.name,
          passwordHash: input.passwordHash,
          role: input.role,
          status: input.status ?? "active",
          updatedAt: new Date(),
        });
        return existing;
      }
      const created: StaffUser = {
        id: `22222222-2222-4222-8222-${String(staffById.size + 1).padStart(12, "0")}`,
        email: input.email.toLowerCase(),
        name: input.name,
        passwordHash: input.passwordHash,
        role: input.role,
        status: input.status ?? "active",
        createdAt: new Date(),
        updatedAt: new Date(),
        lastLoginAt: null,
      };
      staffById.set(created.id, created);
      return created;
    },
    async updatePassword(id, passwordHash) {
      const found = staffById.get(id);
      if (found) {
        found.passwordHash = passwordHash;
        found.status = "active";
        found.updatedAt = new Date();
      }
      return found ?? null;
    },
    async setRole(_id, role) {
      const found = staffById.get(_id);
      if (!found) {
        return null;
      }
      found.role = role;
      found.updatedAt = new Date();
      return found;
    },
    async setStatus(_id, status) {
      const found = staffById.get(_id);
      if (!found) {
        return null;
      }
      found.status = status;
      found.updatedAt = new Date();
      return found;
    },
    async touchLastLogin(id) {
      const found = staffById.get(id);
      if (found) {
        found.lastLoginAt = new Date();
        found.updatedAt = new Date();
      }
    },
    async listStaff() {
      return Array.from(staffById.values()).sort((left, right) => left.createdAt.getTime() - right.createdAt.getTime());
    },
    async countActiveOwners() {
      return Array.from(staffById.values()).filter(
        (candidate) => candidate.role === "owner" && candidate.status === "active",
      ).length;
    },
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
  const addStaff = async (input: {
    id: string;
    email: string;
    name: string;
    role: StaffRole;
    status?: StaffStatus;
    password?: string;
    createdAt?: Date;
  }): Promise<StaffUser> => {
    const created: StaffUser = {
      id: input.id,
      email: input.email.toLowerCase(),
      name: input.name,
      passwordHash: await hashStaffPassword(input.password ?? "password-123"),
      role: input.role,
      status: input.status ?? "active",
      createdAt: input.createdAt ?? new Date(),
      updatedAt: input.createdAt ?? new Date(),
      lastLoginAt: null,
    };
    staffById.set(created.id, created);
    return created;
  };
  return { users, staffSessions, staff, addStaff };
};

const sampleOrganizationRows = {
  rows: [
    {
      accountId: "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa",
      name: "Alpha Research",
      ownerEmail: "owner@example.com",
      ownerCount: 2,
      profileKey: "starter",
      profileDisplayName: "Starter",
      monthlyAnswers: { used: 7, limit: 10 },
    },
  ],
  pageInfo: {
    limit: 25,
    offset: 0,
    nextOffset: null,
    hasMore: false,
  },
};

const sampleUsageSummary: AccountUsageSummary = {
  accountId: "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa",
  profile: {
    key: "starter",
    displayName: "Starter",
    monthlyAnswerLimit: 10,
    storedDocumentLimit: 20,
    storedIndexedByteLimit: null,
    monthlyIndexedByteLimit: 1_000_000,
    createdAt: "2026-06-01T00:00:00.000Z",
    updatedAt: "2026-06-01T00:00:00.000Z",
  },
  monthlyAnswers: {
    periodStart: "2026-06-01",
    resetAt: "2026-07-01T00:00:00.000Z",
    used: 7,
    limit: 10,
  },
  storedDocuments: { used: 3, limit: 20 },
  storedIndexedBytes: { used: 1000, limit: null },
  monthlyIndexedBytes: {
    periodStart: "2026-06-01",
    resetAt: "2026-07-01T00:00:00.000Z",
    used: 500,
    limit: 1_000_000,
  },
};

const sampleProfiles: UsageLimitProfile[] = [
  {
    key: "starter",
    displayName: "Starter",
    monthlyAnswerLimit: 10,
    storedDocumentLimit: 20,
    storedIndexedByteLimit: null,
    monthlyIndexedByteLimit: 1_000_000,
    createdAt: "2026-06-01T00:00:00.000Z",
    updatedAt: "2026-06-01T00:00:00.000Z",
  },
];

const sampleGrowthProfile: UsageLimitProfile = {
  key: "growth",
  displayName: "Growth",
  monthlyAnswerLimit: 100,
  storedDocumentLimit: 200,
  storedIndexedByteLimit: 10_000_000,
  monthlyIndexedByteLimit: null,
  createdAt: "2026-06-01T00:00:00.000Z",
  updatedAt: "2026-06-01T00:00:00.000Z",
};

const sampleGrowthUsageSummary: AccountUsageSummary = {
  ...sampleUsageSummary,
  profile: sampleGrowthProfile,
  monthlyAnswers: {
    ...sampleUsageSummary.monthlyAnswers,
    limit: 100,
  },
  storedDocuments: {
    ...sampleUsageSummary.storedDocuments,
    limit: 200,
  },
  storedIndexedBytes: {
    ...sampleUsageSummary.storedIndexedBytes,
    limit: 10_000_000,
  },
  monthlyIndexedBytes: {
    ...sampleUsageSummary.monthlyIndexedBytes,
    limit: null,
  },
};

const sampleUnassignedUsageSummary: AccountUsageSummary = {
  ...sampleUsageSummary,
  profile: null,
  monthlyAnswers: {
    ...sampleUsageSummary.monthlyAnswers,
    limit: null,
  },
  storedDocuments: {
    ...sampleUsageSummary.storedDocuments,
    limit: null,
  },
  storedIndexedBytes: {
    ...sampleUsageSummary.storedIndexedBytes,
    limit: null,
  },
  monthlyIndexedBytes: {
    ...sampleUsageSummary.monthlyIndexedBytes,
    limit: null,
  },
};

const createReadServiceMocks = () => ({
  organizationDirectoryService: {
    listOrganizations: vi.fn(async () => sampleOrganizationRows),
  } as unknown as OrganizationDirectoryService,
  usageLimitService: {
    getAccountUsage: vi.fn(async () => sampleUsageSummary),
    listProfiles: vi.fn(async () => sampleProfiles),
  },
});

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

  const runRoleGuard = (role: StaffRole) => {
    const res = {
      locals: { staff: { id: "s", role, email: "s@example.com", name: "S" } satisfies StaffPrincipal },
      statusCode: 200,
      body: undefined as unknown,
      status(code: number) { this.statusCode = code; return this; },
      json(payload: unknown) { this.body = payload; return this; },
    };
    let passed = false;
    requireStaffRole("billing_write")({} as never, res as never, () => { passed = true; });
    return { passed, statusCode: res.statusCode };
  };

  it("default-denies a role below the required gate (support_read on billing_write)", () => {
    const result = runRoleGuard("support_read");
    expect(result.passed).toBe(false);
    expect(result.statusCode).toBe(403);
  });

  it("allows billing_write and owner through a billing_write gate", () => {
    for (const role of ["billing_write", "owner"] as const) {
      const result = runRoleGuard(role);
      expect(result.passed).toBe(true);
      expect(result.statusCode).toBe(200);
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

    await expect(repositories.users.findByEmail("first-owner@example.com")).resolves.toMatchObject({
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

  it("lists organizations for any staff role and requires a staff session", async () => {
    const repositories = await createMemoryRepositories("support_read");
    const readServices = createReadServiceMocks();
    const app = createApp(createDependencies({
      users: repositories.users,
      sessions: repositories.staffSessions,
    }), { users: repositories.users, sessions: repositories.staffSessions, ...readServices });

    await request(app)
      .get("/api/v1/ee/operator-console/organizations")
      .expect(401);

    const login = await request(app)
      .post("/api/v1/ee/operator-console/auth/login")
      .send({ email: "owner@example.com", password: "password-123" })
      .expect(200);

    const response = await request(app)
      .get("/api/v1/ee/operator-console/organizations?limit=25&offset=0&search=Alpha")
      .set("Cookie", login.headers["set-cookie"][0])
      .expect(200);

    expect(response.body).toEqual(sampleOrganizationRows);
    expect(readServices.organizationDirectoryService.listOrganizations).toHaveBeenCalledWith({
      limit: 25,
      offset: 0,
      search: "Alpha",
    });
  });

  it("returns per-organization full usage for any staff role and requires a staff session", async () => {
    const repositories = await createMemoryRepositories("support_read");
    const readServices = createReadServiceMocks();
    const app = createApp(createDependencies({
      users: repositories.users,
      sessions: repositories.staffSessions,
    }), { users: repositories.users, sessions: repositories.staffSessions, ...readServices });

    await request(app)
      .get("/api/v1/ee/operator-console/organizations/aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa/usage")
      .expect(401);

    const login = await request(app)
      .post("/api/v1/ee/operator-console/auth/login")
      .send({ email: "owner@example.com", password: "password-123" })
      .expect(200);

    const response = await request(app)
      .get("/api/v1/ee/operator-console/organizations/aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa/usage")
      .set("Cookie", login.headers["set-cookie"][0])
      .expect(200);

    expect(response.body).toEqual(sampleUsageSummary);
    expect(readServices.usageLimitService.getAccountUsage).toHaveBeenCalledWith(
      "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa",
    );
  });

  it("lists usage tiers for any staff role and requires a staff session", async () => {
    const repositories = await createMemoryRepositories("support_read");
    const readServices = createReadServiceMocks();
    const app = createApp(createDependencies({
      users: repositories.users,
      sessions: repositories.staffSessions,
    }), { users: repositories.users, sessions: repositories.staffSessions, ...readServices });

    await request(app)
      .get("/api/v1/ee/operator-console/tiers")
      .expect(401);

    const login = await request(app)
      .post("/api/v1/ee/operator-console/auth/login")
      .send({ email: "owner@example.com", password: "password-123" })
      .expect(200);

    const response = await request(app)
      .get("/api/v1/ee/operator-console/tiers")
      .set("Cookie", login.headers["set-cookie"][0])
      .expect(200);

    expect(response.body).toEqual({ tiers: sampleProfiles });
    expect(readServices.usageLimitService.listProfiles).toHaveBeenCalled();
  });

  it("emits structured read-path auth logs without email fields", async () => {
    const repositories = await createMemoryRepositories("support_read");
    const readServices = createReadServiceMocks();
    const logger = {
      info: vi.fn(),
      warn: vi.fn(),
    };
    const app = createApp(createDependencies({
      users: repositories.users,
      sessions: repositories.staffSessions,
      logger,
    }), { users: repositories.users, sessions: repositories.staffSessions, ...readServices });

    await request(app)
      .get("/api/v1/ee/operator-console/organizations")
      .expect(401);

    const login = await request(app)
      .post("/api/v1/ee/operator-console/auth/login")
      .send({ email: "owner@example.com", password: "password-123" })
      .expect(200);

    await request(app)
      .get("/api/v1/ee/operator-console/organizations")
      .set("Cookie", login.headers["set-cookie"][0])
      .expect(200);

    expect(logger.warn).toHaveBeenCalledWith(expect.objectContaining({
      event: "staff_console.read_auth",
      action: "organizations.list",
      outcome: "failure",
      reason: "missing_session",
    }), expect.any(String));
    expect(logger.info).toHaveBeenCalledWith(expect.objectContaining({
      event: "staff_console.read_auth",
      action: "organizations.list",
      staffId: repositories.staff.id,
      role: "support_read",
      outcome: "success",
    }), expect.any(String));
    expect(JSON.stringify(logger.info.mock.calls)).not.toContain("owner@example.com");
    expect(JSON.stringify(logger.warn.mock.calls)).not.toContain("owner@example.com");
  });

  it("assigns and unassigns organization tiers for billing_write staff and rejects support_read", async () => {
    const billingRepositories = await createMemoryRepositories("billing_write");
    const assignProfile = vi.fn(async (_accountId: string, profileKey: string | null) =>
      profileKey === null ? sampleUnassignedUsageSummary : sampleGrowthUsageSummary,
    );
    const getAccountUsage = vi.fn(async () => sampleUsageSummary);
    const billingApp = createApp(createDependencies({
      users: billingRepositories.users,
      sessions: billingRepositories.staffSessions,
    }), {
      users: billingRepositories.users,
      sessions: billingRepositories.staffSessions,
      usageLimitService: {
        getAccountUsage,
        listProfiles: vi.fn(async () => sampleProfiles),
        assignProfile,
      },
    });
    const billingLogin = await request(billingApp)
      .post("/api/v1/ee/operator-console/auth/login")
      .send({ email: "owner@example.com", password: "password-123" })
      .expect(200);

    const assigned = await request(billingApp)
      .put("/api/v1/ee/operator-console/organizations/aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa/tier")
      .set("Cookie", billingLogin.headers["set-cookie"][0])
      .send({ profileKey: "growth" })
      .expect(200);
    expect(assigned.body).toEqual(sampleGrowthUsageSummary);
    expect(getAccountUsage).toHaveBeenCalledWith("aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa");
    expect(assignProfile).toHaveBeenCalledWith("aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa", "growth");

    const unassigned = await request(billingApp)
      .put("/api/v1/ee/operator-console/organizations/aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa/tier")
      .set("Cookie", billingLogin.headers["set-cookie"][0])
      .send({ profileKey: null })
      .expect(200);
    expect(unassigned.body).toEqual(sampleUnassignedUsageSummary);
    expect(assignProfile).toHaveBeenCalledWith("aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa", null);

    const readOnlyRepositories = await createMemoryRepositories("support_read");
    const readOnlyAssignProfile = vi.fn(async () => sampleGrowthUsageSummary);
    const readOnlyApp = createApp(createDependencies({
      users: readOnlyRepositories.users,
      sessions: readOnlyRepositories.staffSessions,
    }), {
      users: readOnlyRepositories.users,
      sessions: readOnlyRepositories.staffSessions,
      usageLimitService: {
        getAccountUsage: vi.fn(async () => sampleUsageSummary),
        listProfiles: vi.fn(async () => sampleProfiles),
        assignProfile: readOnlyAssignProfile,
      },
    });
    const readOnlyLogin = await request(readOnlyApp)
      .post("/api/v1/ee/operator-console/auth/login")
      .send({ email: "owner@example.com", password: "password-123" })
      .expect(200);

    await request(readOnlyApp)
      .put("/api/v1/ee/operator-console/organizations/aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa/tier")
      .set("Cookie", readOnlyLogin.headers["set-cookie"][0])
      .send({ profileKey: "growth" })
      .expect(403);
    expect(readOnlyAssignProfile).not.toHaveBeenCalled();
  });

  it("audits successful organization tier changes with sanitized metadata", async () => {
    const repositories = await createMemoryRepositories("billing_write");
    const auditRecord = vi.fn(async () => undefined);
    const app = createApp(createDependencies({
      users: repositories.users,
      sessions: repositories.staffSessions,
      auditRecord,
    }), {
      users: repositories.users,
      sessions: repositories.staffSessions,
      usageLimitService: {
        getAccountUsage: vi.fn(async () => sampleUsageSummary),
        listProfiles: vi.fn(async () => sampleProfiles),
        assignProfile: vi.fn(async () => sampleGrowthUsageSummary),
      },
    });
    const login = await request(app)
      .post("/api/v1/ee/operator-console/auth/login")
      .send({ email: "owner@example.com", password: "password-123" })
      .expect(200);

    await request(app)
      .put("/api/v1/ee/operator-console/organizations/aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa/tier")
      .set("Cookie", login.headers["set-cookie"][0])
      .send({ profileKey: "growth" })
      .expect(200);

    expect(auditRecord).toHaveBeenCalledWith({
      accountId: "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa",
      workspaceId: null,
      eventType: "staff.tier.assigned",
      eventStatus: "success",
      metadata: {
        actorStaffId: repositories.staff.id,
        fromProfileKey: "starter",
        toProfileKey: "growth",
      },
    });
    expect(JSON.stringify(auditRecord.mock.calls)).not.toContain("owner@example.com");
  });

  it("creates or edits tiers for billing_write staff, validates payloads, and rejects support_read", async () => {
    const billingRepositories = await createMemoryRepositories("billing_write");
    const upsertProfile = vi.fn(async () => sampleGrowthProfile);
    const billingApp = createApp(createDependencies({
      users: billingRepositories.users,
      sessions: billingRepositories.staffSessions,
    }), {
      users: billingRepositories.users,
      sessions: billingRepositories.staffSessions,
      usageLimitService: {
        getAccountUsage: vi.fn(async () => sampleUsageSummary),
        listProfiles: vi.fn(async () => sampleProfiles),
        upsertProfile,
      },
    });
    const billingLogin = await request(billingApp)
      .post("/api/v1/ee/operator-console/auth/login")
      .send({ email: "owner@example.com", password: "password-123" })
      .expect(200);

    const response = await request(billingApp)
      .put("/api/v1/ee/operator-console/tiers/growth")
      .set("Cookie", billingLogin.headers["set-cookie"][0])
      .send({
        displayName: "  Growth  ",
        monthlyAnswerLimit: 100,
        storedDocumentLimit: null,
        storedIndexedByteLimit: 10_000_000,
        monthlyIndexedByteLimit: null,
      })
      .expect(200);
    expect(response.body).toEqual({ profile: sampleGrowthProfile });
    expect(upsertProfile).toHaveBeenCalledWith({
      key: "growth",
      displayName: "Growth",
      monthlyAnswerLimit: 100,
      storedDocumentLimit: null,
      storedIndexedByteLimit: 10_000_000,
      monthlyIndexedByteLimit: null,
    });

    await request(billingApp)
      .put("/api/v1/ee/operator-console/tiers/NOPE")
      .set("Cookie", billingLogin.headers["set-cookie"][0])
      .send({
        displayName: "Growth",
        monthlyAnswerLimit: 100,
        storedDocumentLimit: null,
      })
      .expect(400);
    await request(billingApp)
      .put("/api/v1/ee/operator-console/tiers/growth")
      .set("Cookie", billingLogin.headers["set-cookie"][0])
      .send({
        displayName: "Growth",
        monthlyAnswerLimit: -1,
        storedDocumentLimit: null,
      })
      .expect(400);

    const readOnlyRepositories = await createMemoryRepositories("support_read");
    const readOnlyUpsertProfile = vi.fn(async () => sampleGrowthProfile);
    const readOnlyApp = createApp(createDependencies({
      users: readOnlyRepositories.users,
      sessions: readOnlyRepositories.staffSessions,
    }), {
      users: readOnlyRepositories.users,
      sessions: readOnlyRepositories.staffSessions,
      usageLimitService: {
        getAccountUsage: vi.fn(async () => sampleUsageSummary),
        listProfiles: vi.fn(async () => sampleProfiles),
        upsertProfile: readOnlyUpsertProfile,
      },
    });
    const readOnlyLogin = await request(readOnlyApp)
      .post("/api/v1/ee/operator-console/auth/login")
      .send({ email: "owner@example.com", password: "password-123" })
      .expect(200);

    await request(readOnlyApp)
      .put("/api/v1/ee/operator-console/tiers/growth")
      .set("Cookie", readOnlyLogin.headers["set-cookie"][0])
      .send({
        displayName: "Growth",
        monthlyAnswerLimit: 100,
        storedDocumentLimit: null,
      })
      .expect(403);
    expect(readOnlyUpsertProfile).not.toHaveBeenCalled();
  });

  it("audits tier create and edit with sanitized metadata", async () => {
    const repositories = await createMemoryRepositories("billing_write");
    const auditRecord = vi.fn(async () => undefined);
    const app = createApp(createDependencies({
      users: repositories.users,
      sessions: repositories.staffSessions,
      auditRecord,
    }), {
      users: repositories.users,
      sessions: repositories.staffSessions,
      usageLimitService: {
        getAccountUsage: vi.fn(async () => sampleUsageSummary),
        listProfiles: vi.fn(async () => sampleProfiles),
        upsertProfile: vi.fn(async () => sampleGrowthProfile),
      },
    });
    const login = await request(app)
      .post("/api/v1/ee/operator-console/auth/login")
      .send({ email: "owner@example.com", password: "password-123" })
      .expect(200);

    await request(app)
      .put("/api/v1/ee/operator-console/tiers/growth")
      .set("Cookie", login.headers["set-cookie"][0])
      .send({
        displayName: "Growth",
        monthlyAnswerLimit: 100,
        storedDocumentLimit: null,
        storedIndexedByteLimit: 10_000_000,
      })
      .expect(200);

    expect(auditRecord).toHaveBeenCalledWith({
      accountId: null,
      workspaceId: null,
      eventType: "staff.tier.upserted",
      eventStatus: "success",
      metadata: {
        actorStaffId: repositories.staff.id,
        profileKey: "growth",
        fields: ["monthlyAnswerLimit", "storedDocumentLimit", "storedIndexedByteLimit"],
      },
    });
    expect(JSON.stringify(auditRecord.mock.calls)).not.toContain("owner@example.com");
  });

  it("enforces the mutating endpoint authorization matrix across staff roles", async () => {
    const roles = ["support_read", "billing_write", "owner"] as const;

    for (const role of roles) {
      const repositories = await createMemoryRepositories(role);
      const app = createApp(createDependencies({
        users: repositories.users,
        sessions: repositories.staffSessions,
      }), {
        users: repositories.users,
        sessions: repositories.staffSessions,
        usageLimitService: {
          getAccountUsage: vi.fn(async () => sampleUsageSummary),
          listProfiles: vi.fn(async () => sampleProfiles),
          assignProfile: vi.fn(async () => sampleGrowthUsageSummary),
          upsertProfile: vi.fn(async () => sampleGrowthProfile),
        },
      });
      const login = await request(app)
        .post("/api/v1/ee/operator-console/auth/login")
        .send({ email: "owner@example.com", password: "password-123" })
        .expect(200);
      const cookie = login.headers["set-cookie"][0];

      const tierStatus = role === "support_read" ? 403 : 200;
      await request(app)
        .put("/api/v1/ee/operator-console/organizations/aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa/tier")
        .set("Cookie", cookie)
        .send({ profileKey: "growth" })
        .expect(tierStatus);
      await request(app)
        .put("/api/v1/ee/operator-console/tiers/growth")
        .set("Cookie", cookie)
        .send({
          displayName: "Growth",
          monthlyAnswerLimit: 100,
          storedDocumentLimit: null,
        })
        .expect(tierStatus);

      const staffStatus = role === "owner" ? 200 : 403;
      await request(app)
        .get("/api/v1/ee/operator-console/staff")
        .set("Cookie", cookie)
        .expect(staffStatus);
      await request(app)
        .put("/api/v1/ee/operator-console/staff/22222222-2222-4222-8222-222222222222/role")
        .set("Cookie", cookie)
        .send({ role: "support_read" })
        .expect(role === "owner" ? 404 : 403);
      await request(app)
        .put("/api/v1/ee/operator-console/staff/22222222-2222-4222-8222-222222222222/status")
        .set("Cookie", cookie)
        .send({ status: "disabled" })
        .expect(role === "owner" ? 404 : 403);
      await request(app)
        .post("/api/v1/ee/operator-console/staff")
        .set("Cookie", cookie)
        .send({
          email: `staff-${role}@example.com`,
          name: "New Staff",
          role: "support_read",
          password: "password-123",
        })
        .expect(role === "owner" ? 201 : 403);
    }
  });

  it("lets owners list and create staff users with audited sanitized metadata", async () => {
    const repositories = await createMemoryRepositories("owner");
    await repositories.addStaff({
      id: "22222222-2222-4222-8222-222222222222",
      email: "support@example.com",
      name: "Support",
      role: "support_read",
      createdAt: new Date(Date.UTC(2026, 11, 2)),
    });
    const auditRecord = vi.fn(async () => undefined);
    const app = createApp(createDependencies({
      users: repositories.users,
      sessions: repositories.staffSessions,
      auditRecord,
    }), { users: repositories.users, sessions: repositories.staffSessions });
    const login = await request(app)
      .post("/api/v1/ee/operator-console/auth/login")
      .send({ email: "owner@example.com", password: "password-123" })
      .expect(200);
    const cookie = login.headers["set-cookie"][0];

    const listResponse = await request(app)
      .get("/api/v1/ee/operator-console/staff")
      .set("Cookie", cookie)
      .expect(200);
    expect(listResponse.body.staff).toEqual([
      expect.objectContaining({
        id: repositories.staff.id,
        email: "owner@example.com",
        name: "Owner",
        role: "owner",
        status: "active",
        lastLoginAt: expect.anything(),
      }),
      expect.objectContaining({
        id: "22222222-2222-4222-8222-222222222222",
        email: "support@example.com",
        role: "support_read",
        status: "active",
        lastLoginAt: null,
      }),
    ]);

    const createResponse = await request(app)
      .post("/api/v1/ee/operator-console/staff")
      .set("Cookie", cookie)
      .send({
        email: "BILLING@EXAMPLE.COM",
        name: "Billing",
        role: "billing_write",
        password: "password-123",
      })
      .expect(201);
    expect(createResponse.body.staff).toMatchObject({
      email: "billing@example.com",
      name: "Billing",
      role: "billing_write",
      status: "active",
      lastLoginAt: null,
    });
    await request(app)
      .post("/api/v1/ee/operator-console/staff")
      .set("Cookie", cookie)
      .send({
        email: "billing@example.com",
        name: "Billing",
        role: "billing_write",
        password: "password-123",
      })
      .expect(409);
    expect(auditRecord).toHaveBeenCalledWith(expect.objectContaining({
      eventType: "staff.user.created",
      eventStatus: "success",
      metadata: {
        actorStaffId: repositories.staff.id,
        targetStaffId: createResponse.body.staff.id,
        role: "billing_write",
      },
    }));
    expect(JSON.stringify(auditRecord.mock.calls)).not.toContain("billing@example.com");
    expect(JSON.stringify(auditRecord.mock.calls)).not.toContain("password-123");
  });

  it("lets owners change staff role and status with 404, self-lockout, last-owner, and audit guards", async () => {
    const repositories = await createMemoryRepositories("owner");
    await repositories.addStaff({
      id: "22222222-2222-4222-8222-222222222222",
      email: "support@example.com",
      name: "Support",
      role: "support_read",
    });
    await repositories.addStaff({
      id: "33333333-3333-4333-8333-333333333333",
      email: "other-owner@example.com",
      name: "Other Owner",
      role: "owner",
    });
    const auditRecord = vi.fn(async () => undefined);
    const app = createApp(createDependencies({
      users: repositories.users,
      sessions: repositories.staffSessions,
      auditRecord,
    }), { users: repositories.users, sessions: repositories.staffSessions });
    const login = await request(app)
      .post("/api/v1/ee/operator-console/auth/login")
      .send({ email: "owner@example.com", password: "password-123" })
      .expect(200);
    const cookie = login.headers["set-cookie"][0];

    await request(app)
      .put("/api/v1/ee/operator-console/staff/99999999-9999-4999-8999-999999999999/role")
      .set("Cookie", cookie)
      .send({ role: "billing_write" })
      .expect(404);
    await request(app)
      .put(`/api/v1/ee/operator-console/staff/${repositories.staff.id}/role`)
      .set("Cookie", cookie)
      .send({ role: "billing_write" })
      .expect(409);
    await request(app)
      .put(`/api/v1/ee/operator-console/staff/${repositories.staff.id}/status`)
      .set("Cookie", cookie)
      .send({ status: "disabled" })
      .expect(409);

    const roleResponse = await request(app)
      .put("/api/v1/ee/operator-console/staff/22222222-2222-4222-8222-222222222222/role")
      .set("Cookie", cookie)
      .send({ role: "billing_write" })
      .expect(200);
    expect(roleResponse.body.staff).toMatchObject({
      id: "22222222-2222-4222-8222-222222222222",
      role: "billing_write",
    });
    const statusResponse = await request(app)
      .put("/api/v1/ee/operator-console/staff/22222222-2222-4222-8222-222222222222/status")
      .set("Cookie", cookie)
      .send({ status: "disabled" })
      .expect(200);
    expect(statusResponse.body.staff).toMatchObject({
      id: "22222222-2222-4222-8222-222222222222",
      status: "disabled",
    });
    expect(auditRecord).toHaveBeenCalledWith(expect.objectContaining({
      eventType: "staff.user.role_changed",
      metadata: {
        actorStaffId: repositories.staff.id,
        targetStaffId: "22222222-2222-4222-8222-222222222222",
        fromRole: "support_read",
        toRole: "billing_write",
      },
    }));
    expect(auditRecord).toHaveBeenCalledWith(expect.objectContaining({
      eventType: "staff.user.status_changed",
      metadata: {
        actorStaffId: repositories.staff.id,
        targetStaffId: "22222222-2222-4222-8222-222222222222",
        fromStatus: "active",
        toStatus: "disabled",
      },
    }));

    const countActiveOwners = vi.spyOn(repositories.users, "countActiveOwners").mockResolvedValue(1);
    await request(app)
      .put("/api/v1/ee/operator-console/staff/33333333-3333-4333-8333-333333333333/role")
      .set("Cookie", cookie)
      .send({ role: "billing_write" })
      .expect(409);
    await request(app)
      .put("/api/v1/ee/operator-console/staff/33333333-3333-4333-8333-333333333333/status")
      .set("Cookie", cookie)
      .send({ status: "disabled" })
      .expect(409);
    countActiveOwners.mockRestore();

    await request(app)
      .put("/api/v1/ee/operator-console/staff/33333333-3333-4333-8333-333333333333/role")
      .set("Cookie", cookie)
      .send({ role: "billing_write" })
      .expect(200);
    await request(app)
      .put(`/api/v1/ee/operator-console/staff/${repositories.staff.id}/role`)
      .set("Cookie", cookie)
      .send({ role: "billing_write" })
      .expect(409);
  });
});
