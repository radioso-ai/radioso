import { randomUUID } from "node:crypto";

import type { Kysely } from "kysely";
import { afterAll, beforeAll, beforeEach, expect, it } from "vitest";

import { AuditEventRepository } from "../../../src/db/repositories/auditEventRepository.js";
import {
  AuditOutboxRepository,
  AuditService,
  createAuditOutboxDispatcher,
} from "../../../src/modules/audit/composition.js";
import type { AuditOutboxIntent } from "../../../src/modules/audit/composition.js";
import { Database } from "../../../src/shared/infra/database.js";
import type { AppLogger } from "../../../src/shared/observability/logger.js";
import type { DB } from "../../../src/shared/infra/kysely/types.js";
import { resolveIntegrationDatabase } from "../support/integrationDatabase.js";

const { describeIntegration, integrationDatabaseUrl } = await resolveIntegrationDatabase();

const silentLogger = { warn: (): void => undefined };

/** The real audit sink `audit_events` actually holds, on a given connection. */
const buildAuditService = (kysely: Kysely<DB>): AuditService =>
  new AuditService(
    { info: (): void => undefined } as unknown as AppLogger,
    new AuditEventRepository(kysely),
  );

const intent = (overrides: Partial<AuditOutboxIntent> = {}): AuditOutboxIntent => ({
  accountId: null,
  workspaceId: randomUUID(),
  eventType: "app.data.deletion.completed",
  eventStatus: "success",
  metadata: { recordCount: 1 },
  ...overrides,
});

// The platform's one durable audit outbox against real Postgres. The unit suite
// on the dispatcher proves the publish/ack/retry rules against a stub
// repository; what only a database can show is that the claim's SKIP LOCKED
// predicate, the lease, and the workspace-existence check hold against the real
// table, and that a row survives the workspace deletion it is deliberately
// built to outlive.
describeIntegration("Audit outbox (Postgres)", () => {
  const database = new Database(integrationDatabaseUrl);
  const repository = new AuditOutboxRepository(database.kysely);

  const accountId = randomUUID();

  beforeAll(async () => {
    await database.query(`INSERT INTO accounts (id, name, email, password_hash) VALUES ($1, $2, $3, $4)`, [
      accountId,
      "Audit Outbox Test Co",
      `acct-${accountId}@example.com`,
      "hash",
    ]);
  });

  afterAll(async () => {
    await database.query(`DELETE FROM accounts WHERE id = $1`, [accountId]).catch(() => undefined);
    await database.close().catch(() => undefined);
  });

  /**
   * `claim` has no tenant scope — it is a single global queue by design — so a
   * row an earlier test left unacknowledged would otherwise bleed into this
   * one's claim. Draining first gives every test a table it can reason about.
   */
  beforeEach(async () => {
    let drained = true;
    while (drained) {
      const claim = await repository.claim({ limit: 100, leaseSeconds: 60 });
      if (claim.entries.length === 0) break;
      await repository.acknowledge({
        claimToken: claim.claimToken,
        eventIds: claim.entries.map((entry) => entry.eventId),
      });
      drained = claim.entries.length === 100;
    }
  });

  const outboxRowCount = async (workspaceId: string): Promise<number> => {
    const rows = await database.query<{ count: string }>(
      `SELECT count(*)::text AS count FROM audit_outbox WHERE workspace_id = $1`,
      [workspaceId],
    );
    return Number(rows[0]?.count ?? "0");
  };

  it("leaves nothing when the enqueuing transaction rolls back", async () => {
    const workspaceId = randomUUID();
    await expect(
      database.kysely.transaction().execute(async (trx) => {
        await repository.enqueue(trx, [intent({ workspaceId })]);
        throw new Error("rollback marker");
      }),
    ).rejects.toThrow("rollback marker");

    expect(await outboxRowCount(workspaceId)).toBe(0);
  });

  it("is claimable once the enqueuing transaction commits", async () => {
    const workspaceId = randomUUID();
    const ids = await database.kysely.transaction().execute((trx) =>
      repository.enqueue(trx, [intent({ workspaceId })]),
    );

    expect(await outboxRowCount(workspaceId)).toBe(1);

    const claim = await repository.claim({ limit: 10, leaseSeconds: 60 });
    expect(claim.entries.some((entry) => entry.eventId === ids[0])).toBe(true);

    await repository.acknowledge({
      claimToken: claim.claimToken,
      eventIds: claim.entries.map((entry) => entry.eventId),
    });
  });

  it("never lets a second claimer take a row a concurrent claim is still holding", async () => {
    const workspaceId = randomUUID();
    const ids = await database.kysely.transaction().execute((trx) =>
      repository.enqueue(trx, [intent({ workspaceId }), intent({ workspaceId })]),
    );
    expect(ids).toHaveLength(2);

    // A second connection locks one row and holds the transaction open — a
    // stand-in for a concurrent claimer that got there first. SKIP LOCKED
    // means the real claim below does not wait for it; it has to skip it.
    const holder = new Database(integrationDatabaseUrl, { poolMax: 1 });
    try {
      await holder.query("BEGIN");
      const locked = await holder.query<{ id: string }>(
        `SELECT id FROM audit_outbox WHERE workspace_id = $1 ORDER BY created_at, id LIMIT 1 FOR UPDATE SKIP LOCKED`,
        [workspaceId],
      );
      expect(locked).toHaveLength(1);
      const lockedId = locked[0].id;

      const claim = await repository.claim({ limit: 10, leaseSeconds: 60 });
      const claimedIds = claim.entries.map((entry) => entry.eventId);

      expect(claimedIds).not.toContain(lockedId);
      expect(claimedIds).toContain(ids.find((id) => id !== lockedId));

      await repository.acknowledge({ claimToken: claim.claimToken, eventIds: claimedIds });
      await holder.query("COMMIT");
    } finally {
      await holder.close();
    }

    // The row the holder locked and never claimed is still there, unleased.
    expect(await outboxRowCount(workspaceId)).toBe(1);
  });

  it("reclaims a lapsed lease and grows its attempt count", async () => {
    const workspaceId = randomUUID();
    const ids = await database.kysely.transaction().execute((trx) =>
      repository.enqueue(trx, [intent({ workspaceId })]),
    );

    // A negative lease sets `claimed_until` in the past, so the row is lapsed
    // the instant this claim commits — no sleep needed to prove reclaim.
    const first = await repository.claim({ limit: 10, leaseSeconds: -1 });
    const claimed = first.entries.find((entry) => entry.eventId === ids[0]);
    expect(claimed?.attemptCount).toBe(1);

    const second = await repository.claim({ limit: 10, leaseSeconds: 60 });
    const reclaimed = second.entries.find((entry) => entry.eventId === ids[0]);
    expect(reclaimed).toBeDefined();
    expect(reclaimed?.attemptCount).toBe(2);

    await repository.acknowledge({ claimToken: second.claimToken, eventIds: [reclaimed!.eventId] });
  });

  it("refuses to acknowledge with the wrong token", async () => {
    const workspaceId = randomUUID();
    const ids = await database.kysely.transaction().execute((trx) =>
      repository.enqueue(trx, [intent({ workspaceId })]),
    );

    const claim = await repository.claim({ limit: 10, leaseSeconds: 60 });
    const entry = claim.entries.find((candidate) => candidate.eventId === ids[0]);
    expect(entry).toBeDefined();

    const removed = await repository.acknowledge({
      claimToken: randomUUID(),
      eventIds: [entry!.eventId],
    });

    expect(removed).toBe(0);
    expect(await outboxRowCount(workspaceId)).toBe(1);

    await repository.acknowledge({ claimToken: claim.claimToken, eventIds: [entry!.eventId] });
  });

  it("claims, publishes, and acknowledges a row whose workspace was deleted, with a null workspace and the former id in metadata", async () => {
    const doomed = randomUUID();
    await database.query(
      `INSERT INTO workspaces (id, account_id, name, public_route_key) VALUES ($1, $2, $3, $4)`,
      [doomed, accountId, "Doomed", `route-${doomed}`],
    );

    const installationId = randomUUID();
    await database.kysely.transaction().execute((trx) =>
      repository.enqueue(trx, [
        intent({
          workspaceId: doomed,
          eventType: "app.data.deletion.requested",
          metadata: { installationId },
        }),
      ]),
    );

    await database.query(`DELETE FROM workspaces WHERE id = $1`, [doomed]);

    // The data cascades away; the outbox entry — the evidence of what happened —
    // does not, because it carries no foreign key to workspaces.
    expect(await outboxRowCount(doomed)).toBe(1);

    const dispatcher = createAuditOutboxDispatcher({
      repository,
      auditPort: buildAuditService(database.kysely),
      logger: silentLogger,
    });

    const drained = await dispatcher.drain({ batchSize: 50 });
    expect(drained.failed).toBe(0);
    expect(drained.published).toBeGreaterThanOrEqual(1);

    const published = await database.query<{ workspace_id: string | null; metadata_json: Record<string, unknown> }>(
      `SELECT workspace_id, metadata_json FROM audit_events WHERE event_type = $1 AND metadata_json->>'installationId' = $2`,
      ["app.data.deletion.requested", installationId],
    );
    expect(published).toHaveLength(1);
    expect(published[0]?.workspace_id).toBeNull();
    expect(published[0]?.metadata_json).toMatchObject({ deletedWorkspaceId: doomed });

    // Acknowledged, so the entry is terminal.
    expect(await outboxRowCount(doomed)).toBe(0);
  });

  it("republishes the same eventId into audit_events at most once", async () => {
    const auditEventRepository = new AuditEventRepository(database.kysely);
    const eventId = randomUUID();

    await auditEventRepository.create({
      id: eventId,
      eventType: "app.data.export.completed",
      eventStatus: "success",
      metadata: { recordCount: 3 },
    });
    await auditEventRepository.create({
      id: eventId,
      eventType: "app.data.export.completed",
      eventStatus: "success",
      metadata: { recordCount: 3 },
    });

    const rows = await database.query<{ count: string }>(
      `SELECT count(*)::text AS count FROM audit_events WHERE id = $1`,
      [eventId],
    );
    expect(rows[0]?.count).toBe("1");
  });

  it("publishes outside its claim even against a single pooled connection", async () => {
    // A one-connection pool is the sharpest form of the failure a dispatcher
    // that published inside its claim's transaction would hit: the sink needs a
    // connection while the claim holds the only one.
    const single = new Database(integrationDatabaseUrl, { poolMax: 1 });
    try {
      const singleRepository = new AuditOutboxRepository(single.kysely);
      const workspaceId = randomUUID();
      await single.kysely.transaction().execute((trx) =>
        singleRepository.enqueue(trx, [intent({ workspaceId })]),
      );

      const dispatcher = createAuditOutboxDispatcher({
        repository: singleRepository,
        auditPort: buildAuditService(single.kysely),
        logger: silentLogger,
      });

      const drained = await Promise.race([
        dispatcher.drain({ batchSize: 10 }),
        new Promise<never>((_, reject) =>
          setTimeout(() => reject(new Error("drain did not complete — likely deadlocked on the pool")), 5_000),
        ),
      ]);

      expect(drained.failed).toBe(0);
      expect(drained.published).toBeGreaterThanOrEqual(1);
    } finally {
      await single.close();
    }
  });
});
