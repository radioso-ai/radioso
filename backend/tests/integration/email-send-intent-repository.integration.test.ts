import { randomUUID } from "node:crypto";

import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  EmailDomainRepository,
  EmailMailboxRepository,
  EmailSendIntentRepository,
} from "../../src/modules/emailChannel/public.js";
import { buildOutboundHeaders } from "../../src/modules/emailChannel/outbound/outboundHeaders.js";
import { rfcMessageId } from "../../src/modules/mail/public.js";
import { Database } from "../../src/shared/infra/database.js";
import { runAllTestMigrations } from "../support/databaseMigrations.js";
import { resolveIntegrationDatabase } from "./support/integrationDatabase.js";

const { describeIntegration, integrationDatabaseUrl } = await resolveIntegrationDatabase();

const HOUR_MS = 60 * 60 * 1000;
const DAY_SECONDS = 24 * 60 * 60;
const relayToken = () => randomUUID().replaceAll("-", "").slice(0, 26).toUpperCase();

describeIntegration("email send intent repository (Postgres)", () => {
  const testDatabaseName = `email_send_intents_${randomUUID().replaceAll("-", "")}_test`;
  let database: Database;
  let intents: EmailSendIntentRepository;
  let fixture: { workspaceId: string; mailboxId: string; domainId: string; domain: string; conversationId: string };

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
    intents = new EmailSendIntentRepository(database.kysely);
    fixture = await seedMailbox();
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

  const seedMailbox = async () => {
    const accountId = randomUUID();
    const workspaceId = randomUUID();
    await database.execute("INSERT INTO accounts (id, name, email, password_hash) VALUES ($1, 'Acct', $2, 'hash')", [
      accountId,
      `send-intents-${accountId}@example.test`,
    ]);
    await database.execute("INSERT INTO workspaces (id, account_id, name, public_route_key) VALUES ($1, $2, 'WS', $3)", [
      workspaceId,
      accountId,
      `rk-${workspaceId}`,
    ]);
    const domain = `d${randomUUID().slice(0, 8)}.example.test`;
    const domainRecord = await new EmailDomainRepository(database.kysely).insertActive({
      workspaceId,
      domain,
      provider: "local",
      providerDomainId: `local-${randomUUID()}`,
      providerRegion: null,
      dnsRecords: [],
      sendingStatus: "verified",
      receivingStatus: "not_requested",
      nextCheckAt: new Date(Date.now() + HOUR_MS),
      createdByUserId: null,
    });
    if (!domainRecord) throw new Error("domain fixture conflicted");
    const mailbox = await new EmailMailboxRepository(database.kysely).createWithPolicy({
      workspaceId,
      domainId: domainRecord.id,
      agentId: null,
      address: `support@${domain}`,
      displayName: "Support",
      relayToken: relayToken(),
      engagementMode: "operator_only",
      enabled: true,
      threadSendBudget: 3,
      hourlyGenerationBudget: 30,
      threadContextMessages: 10,
      spamOptIn: false,
      silenceThresholdHours: 72,
      createdByUserId: null,
    });
    if (!mailbox) throw new Error("mailbox fixture conflicted");
    const conversationId = randomUUID();
    await database.execute("INSERT INTO conversations (id, workspace_id, source_channel) VALUES ($1, $2, 'email')", [
      conversationId,
      workspaceId,
    ]);
    return { workspaceId, mailboxId: mailbox.id, domainId: domainRecord.id, domain, conversationId };
  };

  const insertMessage = async (): Promise<string> => {
    const messageId = randomUUID();
    await database.execute(
      "INSERT INTO messages (id, conversation_id, workspace_id, role, content) VALUES ($1, $2, $3, 'assistant', 'Your order shipped.')",
      [messageId, fixture.conversationId, fixture.workspaceId],
    );
    return messageId;
  };

  const materialize = async (overrides: { messageId?: string; idempotencyKey?: string; id?: string } = {}) => {
    const messageId = overrides.messageId ?? await insertMessage();
    const id = overrides.id ?? randomUUID();
    return intents.materialize({
      id,
      workspaceId: fixture.workspaceId,
      mailboxId: fixture.mailboxId,
      conversationId: fixture.conversationId,
      messageId,
      heldReplyId: null,
      idempotencyKey: overrides.idempotencyKey ?? `email:send:msg:${messageId}`,
      authorKind: "operator",
      trigger: "operator_reply",
      authority: { policyVersion: 1, ownershipVersion: 2, mode: "operator_only", domainId: fixture.domainId },
      provider: "local",
      suppliedRfcMessageId: rfcMessageId(`<${id}@${fixture.domain}>`),
    });
  };

  const requestFor = (intentId: string) => ({
    from: { email: `support@${fixture.domain}`, name: "Support" },
    to: "ada@customer.test",
    replyTo: `support@${fixture.domain}`,
    subject: "Re: Order 42",
    threading: buildOutboundHeaders({
      sendingDomain: fixture.domain,
      latestInbound: { rfcMessageId: rfcMessageId("<parent@mail.customer.test>"), references: [] },
      authorKind: "operator",
      newMessageUuid: intentId,
    }),
    body: { text: "Your order shipped.", html: null },
  });

  const makeDue = async (id: string, options: { leaseExpired?: boolean } = {}) => {
    await database.execute(
      `UPDATE email_send_intents
          SET next_reconcile_at = now() - interval '1 minute',
              reconcile_lease_until = CASE WHEN $2::boolean THEN now() - interval '1 second' ELSE reconcile_lease_until END
        WHERE id = $1`,
      [id, options.leaseExpired === true],
    );
  };

  const accept = async (id: string, version: number, providerMessageId = `re_${randomUUID()}`) => {
    const result = await intents.transition(id, version, { kind: "provider_accepted", providerMessageId, deliveredMessageId: null });
    if (result.outcome !== "applied") throw new Error(`accept did not apply: ${result.outcome}`);
    return result.intent;
  };

  describe("materialize", () => {
    it("writes a queued intent at version 0 with its authority", async () => {
      const { intent, created } = await materialize();

      expect(created).toBe(true);
      expect(intent).toMatchObject({
        state: "queued",
        version: 0,
        trigger: "operator_reply",
        authorKind: "operator",
        authority: { policyVersion: 1, ownershipVersion: 2, mode: "operator_only", domainId: fixture.domainId },
        request: null,
        outcomeUnknown: false,
        firstAttemptAt: null,
      });
    });

    it("returns the first intent for a key materialized again, writing nothing", async () => {
      const messageId = await insertMessage();
      const first = await materialize({ messageId });
      const again = await materialize({ messageId });

      expect(again).toEqual({ intent: first.intent, created: false });
      const rows = await database.query<{ count: string }>(
        "SELECT count(*) FROM email_send_intents WHERE idempotency_key = $1",
        [first.intent.idempotencyKey],
      );
      expect(Number(rows[0]?.count)).toBe(1);
    });

    it("materializes one intent when two workers race on the same key", async () => {
      const messageId = await insertMessage();
      const results = await Promise.all([materialize({ messageId }), materialize({ messageId })]);

      expect(results.filter((result) => result.created)).toHaveLength(1);
      expect(new Set(results.map((result) => result.intent.id)).size).toBe(1);
    });
  });

  describe("transition", () => {
    it("applies an event at the expected version and bumps it", async () => {
      const { intent } = await materialize();
      const result = await intents.transition(intent.id, 0, {
        kind: "provider_accepted",
        providerMessageId: "re_accept",
        deliveredMessageId: "<ses-accept@eu-west-1.amazonses.com>",
      });

      expect(result.outcome).toBe("applied");
      if (result.outcome !== "applied") return;
      expect(result.intent).toMatchObject({
        state: "accepted",
        version: 1,
        providerMessageId: "re_accept",
        deliveredRfcMessageId: "<ses-accept@eu-west-1.amazonses.com>",
      });
      expect(result.intent.acceptedAt).toBeInstanceOf(Date);
      const lookupInSeconds = (result.intent.nextReconcileAt!.getTime() - result.intent.acceptedAt!.getTime()) / 1000;
      expect(lookupInSeconds).toBeCloseTo(DAY_SECONDS, 0);
      expect(result.effects).toEqual([{ kind: "schedule_reconcile", purpose: "lookup", afterSeconds: DAY_SECONDS }]);
    });

    it("returns conflict with the current row for a stale version, and never overwrites", async () => {
      const { intent } = await materialize();
      await accept(intent.id, 0);

      const stale = await intents.transition(intent.id, 0, { kind: "provider_rejected", code: "validation_error" });

      expect(stale.outcome).toBe("conflict");
      if (stale.outcome !== "conflict") return;
      expect(stale.current).toMatchObject({ state: "accepted", version: 1, failureCode: null });
      expect(await intents.findById(intent.id)).toMatchObject({ state: "accepted", version: 1 });
    });

    it("settles concurrent webhook and reconciler writers on one intent to a single final state", async () => {
      const { intent } = await materialize();
      const acceptedIntent = await accept(intent.id, 0);

      const [webhook, reconciler] = await Promise.all([
        intents.transition(intent.id, acceptedIntent.version, { kind: "provider_status", status: "delivered", source: "webhook" }),
        intents.transition(intent.id, acceptedIntent.version, { kind: "reconcile_unsettled" }),
      ]);
      const outcomes = [webhook.outcome, reconciler.outcome].sort();
      expect(outcomes).toEqual(["applied", "conflict"]);

      // The loser re-reads and re-applies: late delivery evidence still settles an uncertain intent,
      // and a delivered one ignores the reconciler.
      if (webhook.outcome === "conflict") {
        const retried = await intents.transition(intent.id, webhook.current.version, {
          kind: "provider_status",
          status: "delivered",
          source: "webhook",
        });
        expect(retried.outcome).toBe("applied");
      } else if (reconciler.outcome === "conflict") {
        const retried = await intents.transition(intent.id, reconciler.current.version, { kind: "reconcile_unsettled" });
        expect(retried).toMatchObject({ outcome: "ignored", reason: "terminal" });
      }
      const final = await intents.findById(intent.id);
      expect(final?.state).toBe("delivered");
      expect(final?.settledAt).toBeInstanceOf(Date);
    });

    it("writes nothing for an ignored event", async () => {
      const { intent } = await materialize();
      const acceptedIntent = await accept(intent.id, 0);
      const delivered = await intents.transition(intent.id, acceptedIntent.version, {
        kind: "provider_status",
        status: "delivered",
        source: "lookup",
      });
      if (delivered.outcome !== "applied") throw new Error("expected delivered");

      const late = await intents.transition(intent.id, delivered.intent.version, {
        kind: "provider_status",
        status: "bounced",
        source: "dsn",
        detailCode: "5.1.1",
      });

      expect(late).toMatchObject({ outcome: "ignored", reason: "terminal" });
      expect(await intents.findById(intent.id)).toEqual(delivered.intent);
    });

    it("stamps the first unknown outcome once and schedules a re-POST", async () => {
      const { intent } = await materialize();
      const first = await intents.transition(intent.id, 0, { kind: "outcome_unknown", authorityValid: true, withinWindow: true });
      if (first.outcome !== "applied") throw new Error("expected the unknown outcome to apply");
      const second = await intents.transition(intent.id, 1, { kind: "outcome_unknown", authorityValid: true, withinWindow: true });
      if (second.outcome !== "applied") throw new Error("expected the second unknown outcome to apply");

      expect(second.intent).toMatchObject({ state: "queued", version: 2, outcomeUnknown: true });
      expect(second.intent.outcomeUnknownSince).toEqual(first.intent.outcomeUnknownSince);
      expect(second.intent.nextReconcileAt!.getTime()).toBeGreaterThan(Date.now());
    });

    it("moves an unknown outcome with revoked authority to uncertain with no re-POST scheduled", async () => {
      const { intent } = await materialize();
      const result = await intents.transition(intent.id, 0, { kind: "outcome_unknown", authorityValid: false, withinWindow: true });

      expect(result).toMatchObject({
        outcome: "applied",
        intent: { state: "uncertain", outcomeUnknown: true, nextReconcileAt: null },
        effects: [{ kind: "open_delivery_failure", failureKind: "uncertain", detailCode: null }],
      });
    });

    it("halts with a reason, and records one audited resend decision", async () => {
      const { intent } = await materialize();
      const userId = randomUUID();
      const halted = await intents.transition(intent.id, 0, { kind: "revalidation_failed", haltReason: "sending_not_verified" });
      expect(halted).toMatchObject({ outcome: "applied", intent: { state: "halted", haltReason: "sending_not_verified" } });

      const resend = await intents.transition(intent.id, 1, { kind: "operator_resolution", decision: "resend", userId });
      expect(resend).toMatchObject({
        outcome: "applied",
        intent: { state: "halted", uncertainResolution: "resend_authorized", uncertainResolvedByUserId: userId, version: 2 },
        effects: [{ kind: "create_resend_intent" }],
      });

      const again = await intents.transition(intent.id, 2, { kind: "operator_resolution", decision: "resend", userId });
      expect(again).toMatchObject({ outcome: "ignored", reason: "not_applicable" });
    });

    it("settles an uncertain intent on late provider evidence", async () => {
      const { intent } = await materialize();
      const acceptedIntent = await accept(intent.id, 0);
      const unsettled = await intents.transition(intent.id, acceptedIntent.version, { kind: "reconcile_unsettled" });
      if (unsettled.outcome !== "applied") throw new Error("expected uncertain");

      const late = await intents.transition(intent.id, unsettled.intent.version, {
        kind: "provider_status",
        status: "bounced",
        source: "webhook",
        detailCode: "5.1.1",
      });

      expect(late).toMatchObject({
        outcome: "applied",
        intent: { state: "bounced", failureCode: "5.1.1", uncertainResolution: "provider_evidence" },
        effects: [{ kind: "retarget_delivery_failure", failureKind: "bounced", detailCode: "5.1.1" }],
      });
    });

    it("reports not_found for an unknown intent", async () => {
      expect(await intents.transition(randomUUID(), 0, { kind: "reconcile_unsettled" })).toEqual({ outcome: "not_found" });
    });
  });

  describe("request snapshot and delivered id", () => {
    it("freezes the request once, starts the re-POST window, and clears the body when the intent settles", async () => {
      const { intent } = await materialize();
      const request = requestFor(intent.id);

      const frozen = await intents.freezeRequest(intent.id, 0, request);
      expect(frozen.outcome).toBe("applied");
      if (frozen.outcome !== "applied") return;
      expect(frozen.intent.request).toEqual(request);
      expect(frozen.intent.request?.threading.messageId).toBe(intent.suppliedRfcMessageId);
      expect(frozen.intent.firstAttemptAt).toBeInstanceOf(Date);
      expect(frozen.intent.version).toBe(1);

      const refrozen = await intents.freezeRequest(intent.id, 1, { ...request, subject: "Something else" });
      expect(refrozen).toMatchObject({ outcome: "conflict", current: { request: { subject: "Re: Order 42" }, version: 1 } });

      const rejected = await intents.transition(intent.id, 1, { kind: "provider_rejected", code: "validation_error" });
      expect(rejected).toMatchObject({ outcome: "applied", intent: { state: "failed" } });
      if (rejected.outcome !== "applied") return;
      expect(rejected.intent.request).toEqual({ ...request, body: null });
      expect(rejected.intent.settledAt).toBeInstanceOf(Date);
    });

    it("records the delivered Message-ID once, for the provider id it was fetched for", async () => {
      const { intent } = await materialize();
      const acceptedIntent = await accept(intent.id, 0, "re_delivered");
      const delivered = rfcMessageId("<ses-delivered@eu-west-1.amazonses.com>");

      expect(await intents.recordDeliveredMessageId(intent.id, { providerMessageId: "re_other", deliveredRfcMessageId: delivered }))
        .toBe(false);
      expect(await intents.recordDeliveredMessageId(intent.id, { providerMessageId: "re_delivered", deliveredRfcMessageId: delivered }))
        .toBe(true);
      expect(await intents.recordDeliveredMessageId(intent.id, {
        providerMessageId: "re_delivered",
        deliveredRfcMessageId: rfcMessageId("<later@eu-west-1.amazonses.com>"),
      })).toBe(false);

      expect(await intents.findById(intent.id)).toMatchObject({
        deliveredRfcMessageId: "<ses-delivered@eu-west-1.amazonses.com>",
        version: acceptedIntent.version + 1,
      });
    });
  });

  describe("claimDueForReconcile", () => {
    it("claims due unsettled intents only, and two sweeps never claim the same one", async () => {
      const due = await Promise.all(Array.from({ length: 12 }, async () => {
        const { intent } = await materialize();
        const acceptedIntent = await accept(intent.id, 0);
        await makeDue(acceptedIntent.id);
        return acceptedIntent.id;
      }));
      const notDue = await accept((await materialize()).intent.id, 0);
      const settled = await materialize();
      const settledAccepted = await accept(settled.intent.id, 0);
      await intents.transition(settled.intent.id, settledAccepted.version, { kind: "provider_status", status: "delivered", source: "webhook" });
      await makeDue(settled.intent.id);

      const [first, second] = await Promise.all([
        intents.claimDueForReconcile({ limit: 50, leaseSeconds: 300 }),
        intents.claimDueForReconcile({ limit: 50, leaseSeconds: 300 }),
      ]);
      const firstIds = first.map((claimed) => claimed.id);
      const secondIds = second.map((claimed) => claimed.id);

      expect(firstIds.filter((id) => secondIds.includes(id))).toEqual([]);
      const claimed = new Set([...firstIds, ...secondIds]);
      for (const id of due) expect(claimed.has(id)).toBe(true);
      expect(claimed.has(notDue.id)).toBe(false);
      expect(claimed.has(settled.intent.id)).toBe(false);
      for (const record of [...first, ...second]) expect(record.reconcileLeaseUntil!.getTime()).toBeGreaterThan(Date.now());

      expect(await intents.claimDueForReconcile({ limit: 50, leaseSeconds: 300 })).toEqual([]);
    });

    it("reclaims an intent whose lease ran out, and a transition consumes the claim", async () => {
      const { intent } = await materialize();
      const acceptedIntent = await accept(intent.id, 0);
      await makeDue(intent.id);
      const [claimed] = await intents.claimDueForReconcile({ limit: 50, leaseSeconds: 300 });
      expect(claimed?.id).toBe(intent.id);
      expect(claimed?.version).toBe(acceptedIntent.version);

      await makeDue(intent.id, { leaseExpired: true });
      const reclaimed = await intents.claimDueForReconcile({ limit: 50, leaseSeconds: 300 });
      expect(reclaimed.map((record) => record.id)).toEqual([intent.id]);

      const unsettled = await intents.transition(intent.id, acceptedIntent.version, { kind: "reconcile_unsettled" });
      expect(unsettled).toMatchObject({
        outcome: "applied",
        intent: { state: "uncertain", reconcileLeaseUntil: null, nextReconcileAt: null },
      });
    });
  });
});
