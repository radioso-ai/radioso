import { randomUUID } from "node:crypto";

import { afterAll, beforeAll, expect, it } from "vitest";

import { PostgresWhatsAppPersistence, photoReceiptOf } from "../../src/modules/connectors/plugins/whatsapp/whatsappPersistence.js";
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

  it("keeps a photo receipt with its inbound message, beside the webhook body, and reads it back after recovery", async () => {
    const wamid = `wamid-${randomUUID()}`;
    const body = { object: "whatsapp_business_account", entry: [{ id: "waba-1" }] };
    await persistence.createInboundMessageLog({ wamid, workspaceId, waId, messageType: "image", payload: body });
    expect(photoReceiptOf(await persistence.findMessageLogByWamid(wamid))).toBeNull();

    await persistence.savePhotoReceipt(wamid, "receipt-1");
    await persistence.savePhotoReceipt(wamid, "receipt-2");

    const log = await persistence.findMessageLogByWamid(wamid);
    expect(photoReceiptOf(log)).toBe("receipt-2");
    expect(log?.payload).toMatchObject(body);
    const recovered = (await persistence.listRecoverableInboundLogs()).find((candidate) => candidate.wamid === wamid);
    expect(photoReceiptOf(recovered ?? null)).toBe("receipt-2");
  });

  it("keeps a receipt only for an inbound message the log holds", async () => {
    const outboundWamid = `local-${randomUUID()}`;
    await persistence.createMessageLog({
      wamid: outboundWamid,
      direction: "outbound",
      workspaceId,
      waId,
      messageType: "text",
      payload: { text: "Hello" },
      status: "processing",
    });

    await persistence.savePhotoReceipt(outboundWamid, "receipt-x");
    await persistence.savePhotoReceipt(`wamid-${randomUUID()}`, "receipt-y");

    expect(photoReceiptOf(await persistence.findMessageLogByWamid(outboundWamid))).toBeNull();
  });

  it("claims a cards reply's numbered list once, keeps the rest of its payload, and lets a released claim be taken again", async () => {
    const replyWamid = `local-${randomUUID()}`;
    await persistence.createMessageLog({
      wamid: replyWamid,
      direction: "outbound",
      workspaceId,
      waId,
      messageType: "interactive",
      payload: { text: "Two homes fit.", inbound_wamids: [`wamid-${randomUUID()}`], reply_cards: { messageId: randomUUID(), blocks: [] } },
      status: "replied",
    });

    await expect(persistence.claimCardsFallback(replyWamid)).resolves.toBe(true);
    await expect(persistence.claimCardsFallback(replyWamid)).resolves.toBe(false);
    await persistence.releaseCardsFallback(replyWamid);
    await expect(persistence.claimCardsFallback(replyWamid)).resolves.toBe(true);
    await expect(persistence.claimCardsFallback(`local-${randomUUID()}`)).resolves.toBe(false);
    expect((await persistence.findMessageLogByWamid(replyWamid))?.payload).toMatchObject({ text: "Two homes fit.", radioso: { cardsFallback: true } });
  });

  it("finds the newest reply to a number, never a sent cards message's own row", async () => {
    const number = `1${Math.floor(Math.random() * 1e9)}`;
    const older = `local-${randomUUID()}`;
    const newer = `local-${randomUUID()}`;
    await persistence.createMessageLog({ wamid: older, direction: "outbound", workspaceId, waId: number, messageType: "text", payload: { text: "a", inbound_wamids: ["w-1"] }, status: "replied" });
    await database.query(`UPDATE connector_whatsapp_message_log SET created_at = now() - interval '2 minutes' WHERE wamid = $1`, [older]);
    await persistence.createMessageLog({ wamid: newer, direction: "outbound", workspaceId, waId: number, messageType: "text", payload: { text: "b", inbound_wamids: ["w-2"] }, status: "processing" });
    await database.query(`UPDATE connector_whatsapp_message_log SET created_at = now() - interval '1 minute' WHERE wamid = $1`, [newer]);
    await persistence.createMessageLog({ wamid: `wamid.${randomUUID()}`, direction: "outbound", workspaceId, waId: number, messageType: "carousel", payload: { cards_of: older }, status: "replied" });

    expect((await persistence.findLatestOutboundReply({ workspaceId, waId: number }))?.wamid).toBe(newer);
    await expect(persistence.findLatestOutboundReply({ workspaceId, waId: `1${Math.floor(Math.random() * 1e9)}` })).resolves.toBeNull();
  });

  it("issues a local outbound wamid", () => {
    expect(persistence.nextLocalOutboundWamid()).toMatch(/^local-[0-9a-f-]{36}$/);
  });
});
