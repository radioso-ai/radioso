import { randomUUID } from "node:crypto";

import pg from "pg";
import { afterAll, beforeAll, expect, it } from "vitest";

import { EmailDomainRepository, EmailInboundRepository, EmailMailboxRepository, EventLogReader } from "../../src/modules/emailChannel/public.js";
import { Database } from "../../src/shared/infra/database.js";
import { runAllTestMigrations } from "../support/databaseMigrations.js";
import { resolveIntegrationDatabase } from "./support/integrationDatabase.js";

const { describeIntegration, integrationDatabaseUrl } = await resolveIntegrationDatabase();

const MINUTE_MS = 60 * 1000;
const NO_FILTER = { disposition: null, states: null } as const;

describeIntegration("email event log, workspace scope (Postgres)", () => {
  const testDatabaseName = `email_event_log_${randomUUID().replaceAll("-", "")}_test`;
  let database: Database;
  let inbound: EmailInboundRepository;
  let mailboxes: EmailMailboxRepository;
  let domains: EmailDomainRepository;

  beforeAll(async () => {
    const admin = new pg.Pool({ connectionString: integrationDatabaseUrl });
    try {
      await admin.query(`CREATE DATABASE "${testDatabaseName}" TEMPLATE template0`);
    } finally {
      await admin.end();
    }
    const url = new URL(integrationDatabaseUrl);
    url.pathname = `/${testDatabaseName}`;
    url.searchParams.delete("options");
    database = new Database(url.toString());
    await runAllTestMigrations(database);
    inbound = new EmailInboundRepository(database.kysely);
    mailboxes = new EmailMailboxRepository(database.kysely);
    domains = new EmailDomainRepository(database.kysely);
  }, 60_000);

  afterAll(async () => {
    await database?.close().catch(() => undefined);
    const admin = new pg.Pool({ connectionString: integrationDatabaseUrl });
    try {
      await admin.query(`DROP DATABASE IF EXISTS "${testDatabaseName}" WITH (FORCE)`);
    } finally {
      await admin.end().catch(() => undefined);
    }
  }, 30_000);

  const seedWorkspace = async () => {
    const accountId = randomUUID();
    const workspaceId = randomUUID();
    await database.execute("INSERT INTO accounts (id, name, email, password_hash) VALUES ($1, 'Acct', $2, 'hash')", [
      accountId,
      `email-event-log-${accountId}@example.test`,
    ]);
    await database.execute("INSERT INTO workspaces (id, account_id, name, public_route_key) VALUES ($1, $2, 'WS', $3)", [
      workspaceId,
      accountId,
      `rk-${workspaceId}`,
    ]);
    const domainName = `d${randomUUID().slice(0, 8)}.example.test`;
    const domain = await domains.insertActive({
      workspaceId,
      domain: domainName,
      provider: "local",
      providerDomainId: `local-${randomUUID()}`,
      providerRegion: null,
      dnsRecords: [],
      sendingStatus: "verified",
      receivingStatus: "verified",
      nextCheckAt: new Date(Date.now() + 60 * MINUTE_MS),
      createdByUserId: null,
    });
    if (!domain) throw new Error("domain fixture conflicted");
    const mailbox = await mailboxes.createWithPolicy({
      workspaceId,
      domainId: domain.id,
      agentId: null,
      address: `support@${domainName}`,
      displayName: "Support",
      relayToken: randomUUID().replaceAll("-", "").slice(0, 26).toUpperCase(),
      engagementMode: "operator_only",
      enabled: true,
      threadSendBudget: 3,
      hourlyGenerationBudget: 30,
      silenceThresholdHours: 72,
      createdByUserId: null,
    });
    if (!mailbox) throw new Error("mailbox fixture conflicted");
    return { workspaceId, mailbox };
  };

  /** A delivery created `minutesAgo`; a null mailbox is mail accepted for an address no mailbox has. */
  const delivery = async (input: { workspaceId: string | null; mailboxId: string | null; minutesAgo: number }) => {
    const { eventId } = await inbound.insertEvent({
      provider: "local",
      providerEventId: `evt_${randomUUID()}`,
      eventKind: "message_received",
      providerObjectId: `obj_${randomUUID()}`,
      envelope: {},
    });
    const { deliveryId } = await inbound.insertDelivery({
      inboundEventId: eventId,
      workspaceId: input.workspaceId,
      mailboxId: input.mailboxId,
      routeRule: input.mailboxId === null ? null : "direct",
      acceptedPolicyVersion: input.mailboxId === null ? null : 1,
      ...(input.mailboxId === null ? { settled: { disposition: "drop" as const, dispositionReason: "no_mailbox" as const } } : {}),
    });
    await database.execute("UPDATE email_inbound_deliveries SET created_at = $2 WHERE id = $1", [
      deliveryId,
      new Date(Date.now() - input.minutesAgo * MINUTE_MS),
    ]);
    return deliveryId;
  };

  it("lists every delivery attributed to the workspace, newest first, mail no mailbox matched and a removed mailbox's included", async () => {
    const { workspaceId, mailbox } = await seedWorkspace();
    const kept = await delivery({ workspaceId, mailboxId: mailbox.id, minutesAgo: 30 });
    const unmatched = await delivery({ workspaceId, mailboxId: null, minutesAgo: 10 });
    const unmatchedEarlier = await delivery({ workspaceId, mailboxId: null, minutesAgo: 50 });
    const other = await seedWorkspace();
    await delivery({ workspaceId: other.workspaceId, mailboxId: null, minutesAgo: 20 });
    await delivery({ workspaceId: null, mailboxId: null, minutesAgo: 20 });
    expect(await mailboxes.markRemoved(workspaceId, mailbox.id)).not.toBeNull();

    const page = await inbound.listWorkspaceLog(workspaceId, { mailboxId: null, cursor: null, limit: 10, ...NO_FILTER });
    expect(page.entries.map((entry) => [entry.id, entry.mailboxId])).toEqual([
      [unmatched, null],
      [kept, mailbox.id],
      [unmatchedEarlier, null],
    ]);
    expect(page.entries[0]).toMatchObject({ disposition: "drop", dispositionReason: "no_mailbox", state: "done" });

    const narrowed = await inbound.listWorkspaceLog(workspaceId, { mailboxId: mailbox.id, cursor: null, limit: 10, ...NO_FILTER });
    expect(narrowed.entries.map((entry) => entry.id)).toEqual([kept]);
    const mailboxLog = await inbound.listMailboxLog(mailbox.id, { cursor: null, limit: 10, ...NO_FILTER });
    expect(mailboxLog.entries.map((entry) => [entry.id, entry.mailboxId])).toEqual([[kept, mailbox.id]]);
    const drops = await inbound.listWorkspaceLog(workspaceId, { mailboxId: null, cursor: null, limit: 10, disposition: "drop", states: null });
    expect(drops.entries.map((entry) => entry.id)).toEqual([unmatched, unmatchedEarlier]);
  });

  it("summarizes a window of the workspace's log: each active mailbox, mail no mailbox matched, and a removed mailbox's retained events", async () => {
    const { workspaceId, mailbox } = await seedWorkspace();
    const removed = await mailboxes.createWithPolicy({
      workspaceId,
      domainId: mailbox.domainId,
      agentId: null,
      address: `old@${mailbox.address.split("@")[1]}`,
      displayName: "Old",
      relayToken: randomUUID().replaceAll("-", "").slice(0, 26).toUpperCase(),
      engagementMode: "operator_only",
      enabled: true,
      threadSendBudget: 3,
      hourlyGenerationBudget: 30,
      silenceThresholdHours: 72,
      createdByUserId: null,
    });
    if (!removed) throw new Error("mailbox fixture conflicted");
    const other = await seedWorkspace();
    await delivery({ workspaceId, mailboxId: mailbox.id, minutesAgo: 30 });
    await delivery({ workspaceId, mailboxId: null, minutesAgo: 10 });
    await delivery({ workspaceId, mailboxId: null, minutesAgo: 20 });
    await delivery({ workspaceId, mailboxId: removed.id, minutesAgo: 40 });
    await delivery({ workspaceId, mailboxId: null, minutesAgo: 3 * 60 });
    await delivery({ workspaceId: other.workspaceId, mailboxId: null, minutesAgo: 5 });
    expect(await mailboxes.markRemoved(workspaceId, removed.id)).not.toBeNull();
    const reader = new EventLogReader({ mailboxes, deliveries: inbound, clock: () => new Date() });

    const summary = await reader.summarizeWorkspace(workspaceId, 1);

    expect(summary).toEqual({
      window: "1h",
      mailboxes: [{ mailboxId: mailbox.id, window: "1h", byDisposition: { undecided: 1 }, failed: 0, lastReceivedAt: null }],
      noMailbox: { byDisposition: { drop: 2 }, failed: 0 },
      removedMailboxes: { byDisposition: { undecided: 1 }, failed: 0 },
    });
  });

  it("pages the workspace's log with a cursor scoped to it", async () => {
    const { workspaceId, mailbox } = await seedWorkspace();
    const newest = await delivery({ workspaceId, mailboxId: null, minutesAgo: 5 });
    const middle = await delivery({ workspaceId, mailboxId: mailbox.id, minutesAgo: 15 });
    const oldest = await delivery({ workspaceId, mailboxId: null, minutesAgo: 25 });
    const other = await seedWorkspace();
    const foreign = await delivery({ workspaceId: other.workspaceId, mailboxId: null, minutesAgo: 1 });

    const first = await inbound.listWorkspaceLog(workspaceId, { mailboxId: null, cursor: null, limit: 2, ...NO_FILTER });
    const second = await inbound.listWorkspaceLog(workspaceId, { mailboxId: null, cursor: first.nextCursor, limit: 2, ...NO_FILTER });

    expect(first).toMatchObject({ nextCursor: middle });
    expect(first.entries.map((entry) => entry.id)).toEqual([newest, middle]);
    expect(second).toMatchObject({ nextCursor: null });
    expect(second.entries.map((entry) => entry.id)).toEqual([oldest]);
    // Another workspace's delivery is no position in this one's log.
    expect((await inbound.listWorkspaceLog(workspaceId, { mailboxId: null, cursor: foreign, limit: 10, ...NO_FILTER })).entries).toEqual([]);
  });

  it("reads one delivery of the workspace, with or without a mailbox, and none of another's", async () => {
    const { workspaceId, mailbox } = await seedWorkspace();
    const unmatched = await delivery({ workspaceId, mailboxId: null, minutesAgo: 1 });
    const received = await delivery({ workspaceId, mailboxId: mailbox.id, minutesAgo: 1 });

    expect(await inbound.findLogEntry(workspaceId, unmatched)).toMatchObject({ id: unmatched, mailboxId: null, dispositionReason: "no_mailbox" });
    expect(await inbound.findLogEntry(workspaceId, received)).toMatchObject({ id: received, mailboxId: mailbox.id });
    expect(await inbound.findLogEntry(randomUUID(), unmatched)).toBeNull();
  });
});
