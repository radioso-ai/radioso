import { createHash, randomUUID } from "node:crypto";

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

  const insertClaim = async (
    accountId: string,
    level: "nearing_limit" | "limit_reached" | "grace_exhausted",
    periodStart: string = currentPeriodStart(),
  ): Promise<void> => {
    await database.query(
      `INSERT INTO ee_usage_limit_alerts (account_id, period_start, level) VALUES ($1, $2::date, $3)`,
      [accountId, periodStart, level],
    );
  };

  const readClaim = async (accountId: string, level: string, periodStart: string = currentPeriodStart()) => {
    const rows = await database.query<{
      sent_at: Date | null;
      outcome: string | null;
      attempts: number;
      next_attempt_at: Date;
      last_error_code: string | null;
    }>(
      `SELECT sent_at, outcome, attempts, next_attempt_at, last_error_code FROM ee_usage_limit_alerts
       WHERE account_id = $1 AND period_start = $2::date AND level = $3`,
      [accountId, periodStart, level],
    );
    return rows[0];
  };

  // `insertClaim` writes a claim row directly, bypassing the real usage path
  // (`reserveTenths`) that normally produces one. The dispatcher now reads the account's
  // actual current level before sending (fix 3), so a test that inserts a synthetic claim
  // must also set real usage that backs it, or the dispatcher correctly (and intentionally)
  // treats the claim as stale and deletes it before ever trying to send.
  const setUsageState = async (accountId: string, usedTenths: number, balanceTenths: number): Promise<void> => {
    const periodStart = currentPeriodStart();
    await database.query(
      `INSERT INTO ee_usage_limit_unit_counters (account_id, period_start, used_tenths) VALUES ($1, $2::date, $3)
       ON CONFLICT (account_id, period_start) DO UPDATE SET used_tenths = EXCLUDED.used_tenths`,
      [accountId, periodStart, usedTenths],
    );
    await database.query(
      `INSERT INTO ee_usage_limit_credits (account_id, balance_tenths) VALUES ($1, $2)
       ON CONFLICT (account_id) DO UPDATE SET balance_tenths = EXCLUDED.balance_tenths`,
      [accountId, balanceTenths],
    );
  };

  const readCreatedAtMs = async (
    accountId: string,
    level: string,
    periodStart: string = currentPeriodStart(),
  ): Promise<string> => {
    const rows = await database.query<{ created_at_ms: string }>(
      `SELECT (extract(epoch from created_at) * 1000)::bigint::text AS created_at_ms
       FROM ee_usage_limit_alerts WHERE account_id = $1 AND period_start = $2::date AND level = $3`,
      [accountId, periodStart, level],
    );
    return rows[0].created_at_ms;
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
    dispatched?: boolean;
  } = {}) => {
    const sent: Array<{ to: string; subject: string; idempotencyKey?: string; content: unknown }> = [];
    const noticeMail = {
      send: vi.fn(async (input: { to: string; subject: string; idempotencyKey?: string; content: unknown }) => {
        sent.push({ to: input.to, subject: input.subject, idempotencyKey: input.idempotencyKey, content: input.content });
        if (overrides.sendImpl) {
          await overrides.sendImpl(input);
        }
        return { dispatched: overrides.dispatched ?? true };
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
    await setUsageState(accountId, 100, 0);
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
      metadata: expect.objectContaining({ level: "nearing_limit", recipientCount: 2, dispatchedCount: 2 }),
    }));
  });

  it("keys each recipient's send with a fixed-length digest, not the raw recipient email", async () => {
    const accountId = await seedAccount();
    await assignProfile(accountId, 10);
    await setUsageState(accountId, 100, 0);
    await insertClaim(accountId, "limit_reached");
    const { dispatcher, sent } = createDispatcher({
      administrators: [
        { email: "owner@example.com", displayName: "Owner" },
        { email: "admin@example.com", displayName: "Admin" },
      ],
    });

    await dispatcher.run();

    const periodStart = currentPeriodStart();
    const createdAtMs = await readCreatedAtMs(accountId, "limit_reached");
    const expectedKey = (email: string) => {
      const digest = createHash("sha256")
        .update(`${accountId}:${periodStart}:limit_reached:${createdAtMs}:${email}`)
        .digest("hex");
      return `usage_alert:${digest}`;
    };
    const ownerKey = sent.find((m) => m.to === "owner@example.com")?.idempotencyKey;
    const adminKey = sent.find((m) => m.to === "admin@example.com")?.idempotencyKey;
    expect(ownerKey).toBe(expectedKey("owner@example.com"));
    expect(adminKey).toBe(expectedKey("admin@example.com"));
    expect(ownerKey).not.toContain("owner@example.com");
    expect(ownerKey?.length).toBeLessThanOrEqual(256);
    expect(ownerKey).toMatch(/^usage_alert:[0-9a-f]{64}$/);
  });

  it("reuses the same idempotency key on a retry, so the provider's dedup window catches a resend", async () => {
    const accountId = await seedAccount();
    await assignProfile(accountId, 10);
    await setUsageState(accountId, 100, 0);
    await insertClaim(accountId, "nearing_limit");
    let callCount = 0;
    const { dispatcher, sent } = createDispatcher({
      sendImpl: async () => {
        callCount += 1;
        if (callCount === 1) {
          throw new Error("temporary failure");
        }
      },
    });

    await dispatcher.run();
    await pushClaimDue(accountId, "nearing_limit");
    await dispatcher.run();

    expect(sent).toHaveLength(2);
    expect(sent[0].idempotencyKey).toBe(sent[1].idempotencyKey);
  });

  it("snapshots the email on the first attempt and resends identical content on retry, even once current usage has moved on", async () => {
    const accountId = await seedAccount();
    await assignProfile(accountId, 10);
    await setUsageState(accountId, 100, 0);
    await insertClaim(accountId, "nearing_limit");
    let callCount = 0;
    const { dispatcher, sent } = createDispatcher({
      sendImpl: async () => {
        callCount += 1;
        if (callCount === 1) {
          throw new Error("temporary failure");
        }
      },
    });

    await dispatcher.run();
    expect(sent).toHaveLength(1);
    expect(JSON.stringify(sent[0].content)).toContain("10 of 10");

    // Usage moves between attempts (a different conversation posts, say); a rebuilt email
    // would now read differently.
    await setUsageState(accountId, 90, 0);
    await pushClaimDue(accountId, "nearing_limit");
    await dispatcher.run();

    expect(sent).toHaveLength(2);
    expect(sent[1].content).toEqual(sent[0].content);
    expect(JSON.stringify(sent[1].content)).toContain("10 of 10");
    expect(JSON.stringify(sent[1].content)).not.toContain("9 of 10");
  });

  it("marks a claim from an earlier billing period superseded without sending it", async () => {
    const accountId = await seedAccount();
    await assignProfile(accountId, 10);
    const now = new Date();
    const lastMonth = currentPeriodStart(new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 1, 1)));
    await insertClaim(accountId, "limit_reached", lastMonth);
    const { dispatcher, noticeMail, audit } = createDispatcher();

    await dispatcher.run();

    expect(noticeMail.send).not.toHaveBeenCalled();
    expect(audit.record).not.toHaveBeenCalled();
    const claim = await readClaim(accountId, "limit_reached", lastMonth);
    expect(claim.outcome).toBe("superseded");
    expect(claim.sent_at).not.toBeNull();
  });

  it("reports a non-dispatching mail driver in the success audit's dispatchedCount", async () => {
    const accountId = await seedAccount();
    await assignProfile(accountId, 10);
    await setUsageState(accountId, 100, 0);
    await insertClaim(accountId, "nearing_limit");
    const { dispatcher, audit } = createDispatcher({ dispatched: false });

    await dispatcher.run();

    const claim = await readClaim(accountId, "nearing_limit");
    expect(claim.outcome).toBe("sent");
    expect(audit.record).toHaveBeenCalledWith(expect.objectContaining({
      eventStatus: "success",
      metadata: expect.objectContaining({ recipientCount: 1, dispatchedCount: 0 }),
    }));
  });

  it("marks a lower level superseded without sending it, once a higher level exists for the same period", async () => {
    const accountId = await seedAccount();
    await assignProfile(accountId, 10);
    await setUsageState(accountId, 100, 0);
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
    await setUsageState(accountId, 100, 0);
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
    await setUsageState(accountId, 100, 0);
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
    await setUsageState(accountId, 100, 0);
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

  it("finalizes a stranded claim (attempts already at the cap, sent_at null) as failed without trying to send", async () => {
    const accountId = await seedAccount();
    await assignProfile(accountId, 10);
    await insertClaim(accountId, "limit_reached");
    // Simulate a crash right after a prior sweep claimed the final allowed attempt: attempts
    // already at the cap, but sent_at never got written because the process died first.
    await database.query(
      `UPDATE ee_usage_limit_alerts SET attempts = 5, next_attempt_at = now() - interval '1 second'
       WHERE account_id = $1 AND period_start = $2::date AND level = $3`,
      [accountId, currentPeriodStart(), "limit_reached"],
    );
    const { dispatcher, noticeMail, audit } = createDispatcher();

    await dispatcher.run();

    expect(noticeMail.send).not.toHaveBeenCalled();
    const claim = await readClaim(accountId, "limit_reached");
    expect(claim.outcome).toBe("failed");
    expect(claim.sent_at).not.toBeNull();
    expect(claim.attempts).toBe(6);
    expect(audit.record).toHaveBeenCalledWith(expect.objectContaining({
      eventStatus: "failure",
      metadata: expect.objectContaining({ level: "limit_reached", reason: "attempts_exhausted" }),
    }));
  });

  it("deletes the claim and sends nothing once a release has refunded the crossing it represents, and a later real crossing claims again", async () => {
    const accountId = await seedAccount();
    const workspaceId = randomUUID();
    await database.query(
      `INSERT INTO workspaces (id, account_id, name, public_route_key) VALUES ($1, $2, 'w', $3)`,
      [workspaceId, accountId, `route-${workspaceId}`],
    );
    await assignProfile(accountId, 10);
    const service = new EnterpriseUsageLimitService(database);
    const reserveConversation = () => service.reserveAnswer({
      accountId, workspaceId, surface: "agent_api", usage: "conversation_reply", conversationId: randomUUID(),
    });

    // Cross into limit_reached (claims nearing_limit and limit_reached naturally), then
    // release the last reservation so the account's current level drops back down —
    // `release()` never re-arms (clears no claims), so the limit_reached row is still there.
    const reservations: Array<{ release(): Promise<void> }> = [];
    for (let i = 0; i < 10; i += 1) {
      reservations.push(await reserveConversation());
    }
    expect((await readClaim(accountId, "limit_reached"))?.outcome).toBeNull();
    await reservations[reservations.length - 1].release();
    // Isolate fix 3's own check from the supersede check: delete the nearing_limit claim
    // the earlier crossings also made, so this test's outcome does not depend on which of
    // the two claims this sweep happens to process first.
    await database.query(
      `DELETE FROM ee_usage_limit_alerts WHERE account_id = $1 AND period_start = $2::date AND level = 'nearing_limit'`,
      [accountId, currentPeriodStart()],
    );

    const { dispatcher, noticeMail } = createDispatcher();
    await dispatcher.run();

    expect(noticeMail.send).not.toHaveBeenCalled();
    expect(await readClaim(accountId, "limit_reached")).toBeUndefined();

    // A later real crossing claims again: the deleted row's primary key is free.
    await reserveConversation();
    expect((await readClaim(accountId, "limit_reached"))?.sent_at).toBeNull();

    // Cleanup: this claim is deliberately left pending (sent_at null) to prove the point
    // above. `claimDueAlerts` sweeps across every account with no account_id filter — exactly
    // as production must — so a row left pending here would otherwise be swept by a later
    // test's dispatcher.run() too.
    await database.query(
      `DELETE FROM ee_usage_limit_alerts WHERE account_id = $1 AND period_start = $2::date AND level = 'limit_reached'`,
      [accountId, currentPeriodStart()],
    );
  });

  it("sends the still-valid lower claim instead of letting a now-stale higher sibling suppress it", async () => {
    const accountId = await seedAccount();
    const workspaceId = randomUUID();
    await database.query(
      `INSERT INTO workspaces (id, account_id, name, public_route_key) VALUES ($1, $2, 'w', $3)`,
      [workspaceId, accountId, `route-${workspaceId}`],
    );
    await assignProfile(accountId, 10);
    const service = new EnterpriseUsageLimitService(database);
    const reserveConversation = () => service.reserveAnswer({
      accountId, workspaceId, surface: "agent_api", usage: "conversation_reply", conversationId: randomUUID(),
    });

    // Cross into limit_reached (claims both nearing_limit and limit_reached naturally), then
    // release the last reservation so the real level drops back to nearing_limit. Unlike the
    // test above, BOTH sibling claims are left in place: the supersede check alone (a higher
    // sibling exists) would wrongly swallow the still-valid nearing_limit claim, since the
    // higher one is itself stale and gets deleted rather than sent.
    const reservations: Array<{ release(): Promise<void> }> = [];
    for (let i = 0; i < 10; i += 1) {
      reservations.push(await reserveConversation());
    }
    await reservations[reservations.length - 1].release();

    const { dispatcher, noticeMail } = createDispatcher();
    await dispatcher.run();

    expect(noticeMail.send).toHaveBeenCalledTimes(1);
    expect(noticeMail.send.mock.calls[0][0].subject).toBe("You've used 80% of this month's conversations");
    expect(await readClaim(accountId, "limit_reached")).toBeUndefined();
    const nearing = await readClaim(accountId, "nearing_limit");
    expect(nearing?.outcome).toBe("sent");
  });

  it("a re-armed claim's new generation is unaffected by a finalize step still fenced to the old generation's created_at", async () => {
    const accountId = await seedAccount();
    await assignProfile(accountId, 10);
    await setUsageState(accountId, 100, 0);
    await insertClaim(accountId, "nearing_limit");
    let resolveSend!: () => void;
    const { dispatcher } = createDispatcher({
      sendImpl: () => new Promise<void>((resolve) => { resolveSend = resolve; }),
    });

    const running = dispatcher.run();
    // Give the dispatcher time to claim the row and enter the (still-pending) send call.
    await new Promise((resolve) => setTimeout(resolve, 20));

    // Re-arm concurrently, exactly as `addCredits`/`assignProfile` would: delete and
    // reinsert the same primary key, producing a new generation with a new created_at.
    await database.query(
      `DELETE FROM ee_usage_limit_alerts WHERE account_id = $1 AND period_start = $2::date AND level = $3`,
      [accountId, currentPeriodStart(), "nearing_limit"],
    );
    await insertClaim(accountId, "nearing_limit");

    resolveSend();
    await running;

    // The in-flight finalize was fenced to the old generation's created_at, so it could not
    // touch the new row: the new generation stays exactly as re-armed (unsent, zero attempts).
    const claim = await readClaim(accountId, "nearing_limit");
    expect(claim?.sent_at).toBeNull();
    expect(claim?.attempts).toBe(0);

    // Cleanup: this row is deliberately left pending to prove the point above (see the
    // "release" test's cleanup comment for why a pending row must not survive the test).
    await database.query(
      `DELETE FROM ee_usage_limit_alerts WHERE account_id = $1 AND period_start = $2::date AND level = 'nearing_limit'`,
      [accountId, currentPeriodStart()],
    );
  });

  it("never double-sends when two sweeps race the same claim", async () => {
    const accountId = await seedAccount();
    await assignProfile(accountId, 10);
    await setUsageState(accountId, 100, 0);
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
