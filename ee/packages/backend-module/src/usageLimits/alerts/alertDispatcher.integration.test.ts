import { randomUUID } from "node:crypto";

import pg from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { EnterpriseUsageLimitService } from "../usageLimitService.js";
import { usageLimitMigrator } from "../usageLimitMigrator.js";
import { currentPeriodStart } from "../period.js";
import { UsageLimitAlertDispatcher } from "./alertDispatcher.js";
import type { AccountAdministratorContact, UsageLimitDatabasePort } from "../../radiosoModuleTypes.js";

const integrationDatabaseUrl = process.env.INTEGRATION_DATABASE_URL;

const canReachIntegrationDatabase = async (databaseUrl?: string): Promise<boolean> => {
  if (!databaseUrl) {
    return false;
  }
  const pool = new pg.Pool({ connectionString: databaseUrl });
  try {
    await pool.query("SELECT 1");
    return true;
  } catch {
    return false;
  } finally {
    await pool.end().catch(() => undefined);
  }
};

class PgDatabase implements UsageLimitDatabasePort {
  constructor(readonly pool: pg.Pool) {}

  async query<T = Record<string, unknown>>(text: string, params?: unknown[]): Promise<T[]> {
    const result = await this.pool.query(text, params);
    return result.rows as T[];
  }
}

const hasReachableIntegrationDatabase = await canReachIntegrationDatabase(integrationDatabaseUrl);
const describeIfDatabase = hasReachableIntegrationDatabase ? describe : describe.skip;

const createMinimalBaseSchema = async (database: UsageLimitDatabasePort): Promise<void> => {
  await database.query(`
    CREATE TABLE IF NOT EXISTS users (
      id UUID PRIMARY KEY,
      email TEXT NOT NULL UNIQUE,
      password_hash TEXT NOT NULL,
      email_verified_at TIMESTAMPTZ,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);

  await database.query(`
    CREATE TABLE IF NOT EXISTS accounts (
      id UUID PRIMARY KEY,
      name TEXT NOT NULL DEFAULT 'Integration Account',
      email TEXT NOT NULL DEFAULT 'integration@example.com',
      password_hash TEXT NOT NULL DEFAULT 'hash',
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);

  await database.query(`
    CREATE TABLE IF NOT EXISTS workspaces (
      id UUID PRIMARY KEY,
      account_id UUID NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
      name TEXT NOT NULL DEFAULT 'Integration Workspace',
      public_route_key TEXT NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);

  await database.query(`
    CREATE TABLE IF NOT EXISTS documents (
      id UUID PRIMARY KEY,
      workspace_id UUID NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
      content_size_bytes BIGINT,
      external_document_id TEXT,
      source_kind TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);

  await database.query(`
    CREATE TABLE IF NOT EXISTS messages (
      id UUID PRIMARY KEY,
      workspace_id UUID NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
      role TEXT NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);
};

describeIfDatabase("UsageLimitAlertDispatcher", () => {
  let pool: pg.Pool;
  let database: PgDatabase;
  const schema = `ee_test_dispatcher_${randomUUID().replace(/-/g, "")}`;

  beforeAll(async () => {
    const admin = new pg.Pool({ connectionString: integrationDatabaseUrl! });
    try {
      await admin.query(`CREATE SCHEMA "${schema}"`);
    } finally {
      await admin.end().catch(() => undefined);
    }
    pool = new pg.Pool({
      connectionString: integrationDatabaseUrl!,
      options: `-c search_path=${schema}`,
    });
    database = new PgDatabase(pool);
    await createMinimalBaseSchema(database);
    await usageLimitMigrator.migrate(database);
  });

  afterAll(async () => {
    await pool.end();
    const admin = new pg.Pool({ connectionString: integrationDatabaseUrl! });
    try {
      await admin.query(`DROP SCHEMA "${schema}" CASCADE`);
    } finally {
      await admin.end().catch(() => undefined);
    }
  });

  const seedAccount = async (): Promise<string> => {
    const accountId = randomUUID();
    await database.query(
      `INSERT INTO accounts (id, name, email, password_hash) VALUES ($1, $2, $3, 'hash')`,
      [accountId, "Dispatcher Account", `dispatcher-${accountId}@example.com`],
    );
    return accountId;
  };

  const assignProfile = async (accountId: string, monthlyConversationLimit: number): Promise<void> => {
    const service = new EnterpriseUsageLimitService(database);
    const key = `it_dispatch_${randomUUID().replace(/-/g, "").slice(0, 16)}`;
    await service.upsertProfile({
      key,
      displayName: "Dispatcher Profile",
      monthlyAnswerLimit: null,
      storedDocumentLimit: null,
      monthlyConversationLimit,
    });
    await service.assignProfile(accountId, key);
  };

  const insertClaim = async (accountId: string, level: "nearing_limit" | "limit_reached" | "grace_exhausted"): Promise<void> => {
    await database.query(
      `INSERT INTO ee_usage_limit_alerts (account_id, period_start, level) VALUES ($1, $2::date, $3)`,
      [accountId, currentPeriodStart(), level],
    );
  };

  const readClaim = async (accountId: string, level: string) => {
    const rows = await database.query<{
      sent_at: Date | null;
      outcome: string | null;
      attempts: number;
      next_attempt_at: Date;
      last_error_code: string | null;
    }>(
      `SELECT sent_at, outcome, attempts, next_attempt_at, last_error_code FROM ee_usage_limit_alerts
       WHERE account_id = $1 AND period_start = $2::date AND level = $3`,
      [accountId, currentPeriodStart(), level],
    );
    return rows[0];
  };

  const pushClaimDue = async (accountId: string, level: string): Promise<void> => {
    await database.query(
      `UPDATE ee_usage_limit_alerts SET next_attempt_at = now() - interval '1 second'
       WHERE account_id = $1 AND period_start = $2::date AND level = $3`,
      [accountId, currentPeriodStart(), level],
    );
  };

  const createDispatcher = (overrides: {
    administrators?: AccountAdministratorContact[];
    sendImpl?: (input: { to: string }) => Promise<void>;
  } = {}) => {
    const sent: Array<{ to: string; subject: string }> = [];
    const noticeMail = {
      send: vi.fn(async (input: { to: string; subject: string }) => {
        if (overrides.sendImpl) {
          await overrides.sendImpl(input);
        }
        sent.push({ to: input.to, subject: input.subject });
      }),
    };
    const accountAdministrators = {
      list: vi.fn(async (): Promise<AccountAdministratorContact[]> =>
        overrides.administrators ?? [{ email: "owner@example.com", displayName: "Owner" }]),
    };
    const audit = { record: vi.fn().mockResolvedValue(undefined) };
    const logger = { warn: vi.fn() };
    const dispatcher = new UsageLimitAlertDispatcher({
      database,
      audit,
      noticeMail,
      accountAdministrators,
      appBaseUrl: "https://app.example.com",
      logger,
    });
    return { dispatcher, noticeMail, accountAdministrators, audit, logger, sent };
  };

  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it("sends one email per administrator contact and marks the claim sent", async () => {
    const accountId = await seedAccount();
    await assignProfile(accountId, 10);
    await insertClaim(accountId, "nearing_limit");
    const { dispatcher, noticeMail, audit, sent } = createDispatcher({
      administrators: [
        { email: "owner@example.com", displayName: "Owner" },
        { email: "admin@example.com", displayName: "Admin" },
      ],
    });

    await dispatcher.run();

    expect(noticeMail.send).toHaveBeenCalledTimes(2);
    expect(sent.map((message) => message.to).sort()).toEqual(["admin@example.com", "owner@example.com"]);
    const claim = await readClaim(accountId, "nearing_limit");
    expect(claim.outcome).toBe("sent");
    expect(claim.sent_at).not.toBeNull();
    expect(audit.record).toHaveBeenCalledWith(expect.objectContaining({
      accountId,
      eventType: "usage_limits.alert_delivered",
      eventStatus: "success",
      metadata: expect.objectContaining({ level: "nearing_limit", recipientCount: 2 }),
    }));
  });

  it("marks a lower level superseded without sending it, once a higher level exists for the same period", async () => {
    const accountId = await seedAccount();
    await assignProfile(accountId, 10);
    await insertClaim(accountId, "nearing_limit");
    await insertClaim(accountId, "limit_reached");
    const { dispatcher, noticeMail } = createDispatcher();

    await dispatcher.run();

    const nearing = await readClaim(accountId, "nearing_limit");
    const reached = await readClaim(accountId, "limit_reached");
    expect(nearing.outcome).toBe("superseded");
    expect(reached.outcome).toBe("sent");
    expect(noticeMail.send.mock.calls.every((call) => call[0].subject !== "You've used 80% of this month's conversations")).toBe(true);
  });

  it("marks no_recipients and records a failure audit when the account has no administrators", async () => {
    const accountId = await seedAccount();
    await assignProfile(accountId, 10);
    await insertClaim(accountId, "limit_reached");
    const { dispatcher, noticeMail, audit } = createDispatcher({ administrators: [] });

    await dispatcher.run();

    expect(noticeMail.send).not.toHaveBeenCalled();
    const claim = await readClaim(accountId, "limit_reached");
    expect(claim.outcome).toBe("no_recipients");
    expect(claim.sent_at).not.toBeNull();
    expect(audit.record).toHaveBeenCalledWith(expect.objectContaining({
      eventStatus: "failure",
      metadata: expect.objectContaining({ reason: "no_recipients" }),
    }));
  });

  it("retries a failed send with backoff, logging accountId/level/attempt/errorCode and no email or content", async () => {
    const accountId = await seedAccount();
    await assignProfile(accountId, 10);
    await insertClaim(accountId, "nearing_limit");
    let callCount = 0;
    const { dispatcher, logger, audit } = createDispatcher({
      sendImpl: async () => {
        callCount += 1;
        if (callCount === 1) {
          const error = new Error("temporary failure") as Error & { code: string };
          error.code = "temporary_failure";
          throw error;
        }
      },
    });

    await dispatcher.run();
    const afterFirst = await readClaim(accountId, "nearing_limit");
    expect(afterFirst.outcome).toBeNull();
    expect(afterFirst.attempts).toBe(1);
    expect(afterFirst.last_error_code).toBe("temporary_failure");
    expect(afterFirst.next_attempt_at.getTime()).toBeGreaterThan(Date.now());
    expect(logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ accountId, level: "nearing_limit", attempt: 1, errorCode: "temporary_failure" }),
      expect.any(String),
    );
    const loggedPayload = logger.warn.mock.calls[0][0] as Record<string, unknown>;
    expect(JSON.stringify(loggedPayload)).not.toContain("owner@example.com");
    expect(audit.record).not.toHaveBeenCalled();

    await pushClaimDue(accountId, "nearing_limit");
    await dispatcher.run();

    const afterSecond = await readClaim(accountId, "nearing_limit");
    expect(afterSecond.outcome).toBe("sent");
    expect(afterSecond.attempts).toBe(2);
  });

  it("gives up after exhausting attempts: outcome failed plus a failure audit", async () => {
    const accountId = await seedAccount();
    await assignProfile(accountId, 10);
    await insertClaim(accountId, "limit_reached");
    const { dispatcher, audit } = createDispatcher({
      sendImpl: async () => {
        const error = new Error("always fails") as Error & { code: string };
        error.code = "permanent_failure";
        throw error;
      },
    });

    for (let attempt = 0; attempt < 5; attempt += 1) {
      await dispatcher.run();
      const claim = await readClaim(accountId, "limit_reached");
      if (claim.outcome !== "failed") {
        await pushClaimDue(accountId, "limit_reached");
      }
    }

    const finalClaim = await readClaim(accountId, "limit_reached");
    expect(finalClaim.outcome).toBe("failed");
    expect(finalClaim.attempts).toBe(5);
    expect(finalClaim.last_error_code).toBe("permanent_failure");
    expect(audit.record).toHaveBeenCalledWith(expect.objectContaining({
      eventStatus: "failure",
      metadata: expect.objectContaining({ reason: "attempts_exhausted" }),
    }));
  });

  it("never double-sends when two sweeps race the same claim", async () => {
    const accountId = await seedAccount();
    await assignProfile(accountId, 10);
    await insertClaim(accountId, "nearing_limit");
    const sendCalls: string[] = [];
    const slowSend = async (input: { to: string }) => {
      sendCalls.push(input.to);
      await new Promise((resolve) => setTimeout(resolve, 25));
    };
    const first = createDispatcher({ sendImpl: slowSend });
    const second = createDispatcher({ sendImpl: slowSend });

    await Promise.all([first.dispatcher.run(), second.dispatcher.run()]);

    expect(sendCalls).toHaveLength(1);
    const claim = await readClaim(accountId, "nearing_limit");
    expect(claim.outcome).toBe("sent");
    expect(claim.attempts).toBe(1);
  });
});
