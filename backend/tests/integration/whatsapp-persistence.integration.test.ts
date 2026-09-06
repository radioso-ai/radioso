import { randomUUID } from "node:crypto";

import { afterAll, beforeAll, expect, it } from "vitest";

import { PostgresWhatsAppPersistence } from "../../src/modules/connectors/plugins/whatsapp/whatsappPersistence.js";
import { Database } from "../../src/shared/infra/database.js";
import { resolveIntegrationDatabase } from "./support/integrationDatabase.js";

// Real-Postgres characterization of PostgresWhatsAppPersistence after the Kysely
// migration. Exercises the contact upsert (ON CONFLICT (workspace_id, wa_id)), the
// message-log inserts (jsonb payload via toJsonb, ON CONFLICT (wamid) DO NOTHING for
// inbound dedup), the jsonb `->` inbound-wamids correlation lookups, and the CTE-driven
// markOutboundReplyDelivered. Behaviour here is the spec the rewrite must preserve.

const { describeIntegration, integrationDatabaseUrl } = await resolveIntegrationDatabase();

describeIntegration("PostgresWhatsAppPersistence (Postgres)", () => {
  const database = new Database(integrationDatabaseUrl);
  const persistence = new PostgresWhatsAppPersistence(database.kysely);

  const accountId = randomUUID();
  const workspaceId = randomUUID();
  const conversationId = randomUUID();
  const waId = `1${Math.floor(Math.random() * 1e9)}`;

  beforeAll(async () => {
    await database.query(
      `INSERT INTO accounts (id, name, email, password_hash) VALUES ($1, $2, $3, $4)`,
      [accountId, "WA Persistence Co", `acct-${accountId}@example.com`, "hash"],
    );
    await database.query(
      `INSERT INTO workspaces (id, account_id, name, public_route_key) VALUES ($1, $2, $3, $4)`,
      [workspaceId, accountId, "WA WS", `route-${workspaceId.slice(0, 8)}`],
    );
    await database.query(
      `INSERT INTO conversations (id, workspace_id) VALUES ($1, $2)`,
      [conversationId, workspaceId],
    );
  });

  afterAll(async () => {
    await database.query(`DELETE FROM connector_whatsapp_message_log WHERE workspace_id = $1`, [workspaceId]).catch(
      () => undefined,
    );
    await database.query(`DELETE FROM accounts WHERE id = $1`, [accountId]).catch(() => undefined);
    await database.close().catch(() => undefined);
  });

  it("returns null for a missing contact", async () => {
    expect(await persistence.findContact(workspaceId, `nope-${randomUUID()}`)).toBeNull();
  });

  it("upserts a contact, preserving first_seen_at while updating mutable fields", async () => {
    const lastMessageAt = new Date("2026-01-01T00:00:00.000Z");
    const created = await persistence.upsertContact({
      workspaceId,
      waId,
      profileName: "Alice",
      conversationId,
      lastMessageAt,
    });
    expect(created.waId).toBe(waId);
    expect(created.profileName).toBe("Alice");
    expect(created.firstSeenAt).toBeInstanceOf(Date);

    const newerLastMessageAt = new Date("2026-02-01T00:00:00.000Z");
    const updated = await persistence.upsertContact({
      workspaceId,
      waId,
      profileName: "Alice Updated",
      conversationId,
      lastMessageAt: newerLastMessageAt,
    });
    expect(updated.id).toBe(created.id);
    expect(updated.profileName).toBe("Alice Updated");
    expect(updated.firstSeenAt.getTime()).toBe(created.firstSeenAt.getTime());
    expect(updated.lastMessageAt.getTime()).toBe(newerLastMessageAt.getTime());

    const found = await persistence.findContact(workspaceId, waId);
    expect(found?.id).toBe(created.id);
  });

  it("creates a message log with a jsonb payload round-tripped intact", async () => {
    const wamid = `wamid-${randomUUID()}`;
    const payload = { text: "hello", nested: { a: 1 }, list: [1, 2, 3] };
    const created = await persistence.createMessageLog({
      wamid,
      direction: "outbound",
      workspaceId,
      waId,
      messageType: "text",
      payload,
      status: "processing",
    });
    expect(created.payload).toEqual(payload);
    expect(created.status).toBe("processing");
    expect(created.createdAt).toBeInstanceOf(Date);

    const found = await persistence.findMessageLogByWamid(wamid);
    expect(found?.payload).toEqual(payload);
  });

  it("dedups inbound message logs on the wamid conflict (returns null on duplicate)", async () => {
    const wamid = `wamid-${randomUUID()}`;
    const first = await persistence.createInboundMessageLog({
      wamid,
      workspaceId,
      waId,
      messageType: "text",
      payload: { body: "hi" },
    });
    const second = await persistence.createInboundMessageLog({
      wamid,
      workspaceId,
      waId,
      messageType: "text",
      payload: { body: "hi again" },
    });
    expect(first).not.toBeNull();
    expect(first?.status).toBe("received");
    expect(second).toBeNull();
  });

  it("finds pending and delivered outbound replies by the inbound-wamids jsonb match", async () => {
    const inboundWamids = [`in-${randomUUID()}`, `in-${randomUUID()}`];
    const pendingWamid = `out-${randomUUID()}`;
    await persistence.createMessageLog({
      wamid: pendingWamid,
      direction: "outbound",
      workspaceId,
      waId,
      messageType: "text",
      payload: { inbound_wamids: inboundWamids },
      status: "processing",
    });

    const pending = await persistence.findPendingOutboundReply({ workspaceId, waId, inboundWamids });
    expect(pending?.wamid).toBe(pendingWamid);
    expect(await persistence.findDeliveredOutboundReply({ workspaceId, waId, inboundWamids })).toBeNull();

    // A different inbound set must not match.
    expect(
      await persistence.findPendingOutboundReply({ workspaceId, waId, inboundWamids: [`other-${randomUUID()}`] }),
    ).toBeNull();
  });

  it("marks an outbound reply delivered and propagates to the correlated inbound rows", async () => {
    const inboundWamids = [`in-${randomUUID()}`, `in-${randomUUID()}`];
    // Seed two inbound rows that the outbound reply correlates to.
    for (const wamid of inboundWamids) {
      await persistence.createInboundMessageLog({ wamid, workspaceId, waId, messageType: "text", payload: {} });
    }
    const outboundWamid = `out-${randomUUID()}`;
    await persistence.createMessageLog({
      wamid: outboundWamid,
      direction: "outbound",
      workspaceId,
      waId,
      messageType: "text",
      payload: { inbound_wamids: inboundWamids },
      status: "processing",
    });

    await persistence.markOutboundReplyDelivered({ outboundWamid, inboundWamids });

    const outbound = await persistence.findMessageLogByWamid(outboundWamid);
    expect(outbound?.status).toBe("replied");
    for (const wamid of inboundWamids) {
      const inbound = await persistence.findMessageLogByWamid(wamid);
      expect(inbound?.status).toBe("replied");
    }

    const delivered = await persistence.findDeliveredOutboundReply({ workspaceId, waId, inboundWamids });
    expect(delivered?.wamid).toBe(outboundWamid);
  });

  it("updates a message log status and lists recoverable inbound logs", async () => {
    const wamid = `wamid-${randomUUID()}`;
    await persistence.createInboundMessageLog({ wamid, workspaceId, waId, messageType: "text", payload: {} });

    await persistence.updateMessageLogStatus(wamid, "processing");
    expect((await persistence.findMessageLogByWamid(wamid))?.status).toBe("processing");

    const recoverable = await persistence.listRecoverableInboundLogs();
    expect(recoverable.some((log) => log.wamid === wamid)).toBe(true);

    await persistence.updateMessageLogStatus(wamid, "replied");
    const afterReply = await persistence.listRecoverableInboundLogs();
    expect(afterReply.some((log) => log.wamid === wamid)).toBe(false);
  });

  it("issues a local outbound wamid", () => {
    expect(persistence.nextLocalOutboundWamid()).toMatch(/^local-[0-9a-f-]{36}$/);
  });
});
