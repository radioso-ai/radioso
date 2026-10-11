import { randomUUID } from "node:crypto";

import type express from "express";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";

import { createEmailChannelComposition } from "../../src/app/composition/emailChannel/index.js";
import { parseEmailChannelConfig } from "../../src/app/config/env.js";
import { ConversationActivityRepository } from "../../src/db/repositories/conversationActivityRepository.js";
import {
  EmailInboundRepository,
  EmailMailboxRepository,
  EventLogReader,
  NoopEmailChannelDrainDispatcher,
} from "../../src/modules/emailChannel/public.js";
import type { Database } from "../../src/shared/infra/database.js";
import { LocalEmailDomainProvisioner } from "../../src/modules/mail/adapters/localDomainProvisioner.js";
import { createLogger } from "../../src/shared/observability/logger.js";
import {
  INBOUND_DOMAIN,
  WEBHOOK_SECRET,
  activityOf,
  changeMailboxPolicy,
  conversationsOfMailbox,
  createEmailChannelDatabase,
  createHostIngest,
  createSpool,
  createWorkerNode,
  customerMessagesOf,
  deliveriesOfEmail,
  deliveryOfEmail,
  eventOfEmail,
  mountWebhook,
  opaqueToken,
  ownershipOf,
  postDomainEvent,
  postReceived,
  readFixture,
  relayAddressOf,
  seedDomain,
  seedMailbox,
  seedOutboundMessageId,
  seedSupportMailbox,
  seedWorkspace,
  threadLinksOf,
  uniqueCustomerDomain,
  type SeededMailbox,
} from "./support/emailChannelHarness.js";
import { resolveIntegrationDatabase } from "./support/integrationDatabase.js";

// The inbound channel end to end against Postgres, as the email channel composition assembles it
// for the `local` provider: a fixture is spooled, its signed `email.received` webhook persisted,
// and the worker's drain fetches it through the local receiver, routes, threads, decides and
// ingests it. Covers the SC-002 threading corpus, routing without a mailbox, the SC-003 protocol
// corpus and the policy effective at acceptance (research B16).

const { describeIntegration, integrationDatabaseUrl } = await resolveIntegrationDatabase();

const FIRST = "mime/first-contact.eml";
const OUTBOUND_ID = "<out-0001@in.relay.test>";
const ALL_MODES = ["operator_only", "draft", "auto"] as const;

interface Target {
  mailbox: SeededMailbox;
  domain: string;
}

describeIntegration("email inbound end to end (Postgres, local receiver)", () => {
  let suite: Awaited<ReturnType<typeof createEmailChannelDatabase>>;
  let database: Database;
  let spool: Awaited<ReturnType<typeof createSpool>>;
  let channel: NonNullable<ReturnType<typeof createEmailChannelComposition>>;
  let webhook: express.Express;
  let eventLog: EventLogReader;

  beforeAll(async () => {
    suite = await createEmailChannelDatabase(integrationDatabaseUrl, "inbound");
    database = suite.database;
    spool = await createSpool();
    const host = createHostIngest(database);
    const unused = (): never => {
      throw new Error("This suite runs no review turn");
    };
    const composed = createEmailChannelComposition({
      config: parseEmailChannelConfig({
        EMAIL_CHANNEL_PROVIDER: "local",
        EMAIL_CHANNEL_INBOUND_DOMAIN: INBOUND_DOMAIN,
        EMAIL_CHANNEL_WEBHOOK_SECRET: WEBHOOK_SECRET,
        EMAIL_CHANNEL_WORKERS_ENABLED: true,
      }),
      options: { localSpoolDir: spool.dir },
      db: database.kysely,
      drains: new NoopEmailChannelDrainDispatcher(),
      activity: new ConversationActivityRepository(database.kysely),
      // This suite drains stage 1 only; no review turn runs here.
      chat: { ingest: (input) => host.ingest(input), respond: unused },
      heldReplies: { hold: unused, queueAuto: unused, findByReviewRef: unused, materializeAuto: unused, returnAbandonedAuto: unused },
      ownership: { requestHumanOwnership: unused },
      reviewInference: { create: unused },
      agents: { findByIdAndWorkspaceId: async (agentId) => ({ id: agentId }) },
      audit: { record: async () => undefined },
      actionDrain: { requestDrain: async () => undefined },
      metrics: null,
      logger: createLogger("silent"),
    });
    if (!composed) throw new Error("the local provider composes the email channel");
    channel = composed;
    webhook = await mountWebhook(channel.plugin);
    eventLog = new EventLogReader({
      mailboxes: new EmailMailboxRepository(database.kysely),
      deliveries: new EmailInboundRepository(database.kysely),
      clock: () => new Date(),
    });
  }, 60_000);

  afterAll(async () => {
    await spool?.remove();
    await suite?.close();
  }, 30_000);

  const spoolFixture = async (fixture: string, target: Target, threadToken?: string): Promise<string> =>
    spool.put(await readFixture(fixture, { relayToken: target.mailbox.relayToken, domain: target.domain, threadToken }));

  /** Spools a fixture for `target` and posts its webhook; returns the provider's email id. */
  const receive = async (
    fixture: string,
    target: Target,
    options: { receivedFor?: readonly string[]; threadToken?: string; app?: express.Express } = {},
  ): Promise<string> => {
    const emailId = await spoolFixture(fixture, target, options.threadToken);
    const receivedFor = options.receivedFor ?? [relayAddressOf(target.mailbox)];
    expect(await postReceived(options.app ?? webhook, { emailId, receivedFor })).toBe(200);
    return emailId;
  };

  const drain = () => channel.worker.drain({ maxJobs: 20, stage: "inbound" });

  const receiveAndDrain = async (fixture: string, target: Target, options: Parameters<typeof receive>[2] = {}) => {
    const emailId = await receive(fixture, target, options);
    expect(await drain()).toMatchObject({ errored: 0, failed: 0, retrying: 0 });
    return emailId;
  };

  const supportTarget = async (options: Parameters<typeof seedSupportMailbox>[1] = {}) => {
    const seeded = await seedSupportMailbox(database, options);
    return { ...seeded, target: { mailbox: seeded.mailbox, domain: seeded.domain.domain } };
  };

  /** First contact from Alice, the conversation it opened, and its thread link. */
  const firstContact = async (target: Target) => {
    const emailId = await receiveAndDrain(FIRST, target);
    const delivery = await deliveryOfEmail(database, emailId);
    const [link] = await threadLinksOf(database, target.mailbox);
    return { emailId, conversationId: delivery.conversation_id ?? "", link };
  };

  describe("the SC-002 threading corpus", () => {
    it("opens a human-owned conversation for first contact on an operator-only mailbox", async () => {
      const { target, mailbox } = await supportTarget();

      const { emailId, conversationId, link } = await firstContact(target);

      expect(await deliveryOfEmail(database, emailId)).toMatchObject({
        mailbox_id: mailbox.id,
        workspace_id: mailbox.workspaceId,
        route_rule: "relay",
        accepted_policy_version: 1,
        state: "done",
        classification: "person",
        disposition: "ingest_only",
        disposition_reason: "operator_only_mailbox",
        thread_match: "new_thread",
        rfc_message_id: "<msg-0001@example.test>",
      });
      expect(await eventOfEmail(database, emailId)).toMatchObject({ state: "processed", attempts: 1 });
      expect(await conversationsOfMailbox(database, mailbox)).toEqual([conversationId]);
      expect(await customerMessagesOf(database, conversationId)).toEqual([
        expect.objectContaining({ role: "user", source: "customer", content: expect.stringContaining("update my billing address") }),
      ]);
      expect(link).toMatchObject({ conversation_id: conversationId, participant_address: "alice@example.test" });
      expect(await ownershipOf(database, conversationId)).toMatchObject({ state: "human_owned", reason: "operator_only_mailbox" });
      expect((await new EmailMailboxRepository(database.kysely).findActiveById(mailbox.id))?.lastReceivedAt).toBeInstanceOf(Date);
    });

    it("continues the thread for a follow-up sent before any reply", async () => {
      const { target, mailbox } = await supportTarget();
      const { conversationId } = await firstContact(target);

      const followUp = await receiveAndDrain("mime/pre-reply-follow-up.eml", target);

      expect(await deliveryOfEmail(database, followUp)).toMatchObject({ thread_match: "in_reply_to", conversation_id: conversationId });
      expect(await conversationsOfMailbox(database, mailbox)).toEqual([conversationId]);
      expect(await customerMessagesOf(database, conversationId)).toHaveLength(2);
    });

    it("continues the thread for a reply to a message the mailbox sent", async () => {
      const { target, mailbox } = await supportTarget();
      const { conversationId } = await firstContact(target);
      await seedOutboundMessageId(database, mailbox, conversationId, OUTBOUND_ID);

      const reply = await receiveAndDrain("mime/header-threaded-reply.eml", target);

      expect(await deliveryOfEmail(database, reply)).toMatchObject({
        thread_match: "in_reply_to",
        thread_conflict: false,
        conversation_id: conversationId,
      });
      expect(await conversationsOfMailbox(database, mailbox)).toEqual([conversationId]);
    });

    it("continues the thread by the plus token alone, whatever case the mail system folded it to", async () => {
      const { target, mailbox } = await supportTarget();
      const { conversationId, link } = await firstContact(target);

      const reply = await receiveAndDrain("mime/token-only-reply.eml", target, { threadToken: link.thread_token.toLowerCase() });

      expect(await deliveryOfEmail(database, reply)).toMatchObject({ thread_match: "thread_token", conversation_id: conversationId });
      expect(await conversationsOfMailbox(database, mailbox)).toEqual([conversationId]);
    });

    it("opens one conversation in each of two mailboxes one message reached", async () => {
      const { target, mailbox: support, workspaceId, domain } = await supportTarget();
      const sales = await seedMailbox(database, { workspaceId, domain, local: "sales" });

      const emailId = await receiveAndDrain("mime/two-mailbox.eml", target, {
        receivedFor: [relayAddressOf(support), relayAddressOf(sales)],
      });

      const deliveries = await deliveriesOfEmail(database, emailId);
      expect(deliveries.map((delivery) => delivery.mailbox_id).sort()).toEqual([support.id, sales.id].sort());
      expect(new Set(deliveries.map((delivery) => delivery.inbound_event_id)).size).toBe(1);
      const [supportConversations, salesConversations] = await Promise.all([
        conversationsOfMailbox(database, support),
        conversationsOfMailbox(database, sales),
      ]);
      expect(supportConversations).toHaveLength(1);
      expect(salesConversations).toHaveLength(1);
      expect(supportConversations[0]).not.toBe(salesConversations[0]);
    });

    it("drops another sender's reply on the thread as a participant mismatch, noted on the thread", async () => {
      const { target, mailbox } = await supportTarget();
      const { conversationId } = await firstContact(target);
      await seedOutboundMessageId(database, mailbox, conversationId, OUTBOUND_ID);

      const stranger = await receiveAndDrain("mime/participant-mismatch.eml", target);

      expect(await deliveryOfEmail(database, stranger)).toMatchObject({
        state: "done",
        classification: "person",
        disposition: "drop",
        disposition_reason: "participant_mismatch",
        conversation_id: null,
        message_id: null,
      });
      expect(await conversationsOfMailbox(database, mailbox)).toEqual([conversationId]);
      expect(await customerMessagesOf(database, conversationId)).toHaveLength(1);
      expect(await activityOf(database, conversationId)).toEqual(expect.arrayContaining([
        expect.objectContaining({ kind: "channel_exception", detail: expect.objectContaining({ code: "participant_mismatch" }) }),
      ]));
    });

    it("records a redelivered or replayed provider event once", async () => {
      const { target, mailbox } = await supportTarget();
      const emailId = await spoolFixture(FIRST, target);
      const receivedFor = [relayAddressOf(mailbox)];
      const svixId = `msg_${randomUUID()}`;

      expect(await postReceived(webhook, { emailId, receivedFor, svixId })).toBe(200);
      expect(await postReceived(webhook, { emailId, receivedFor, svixId })).toBe(200);
      expect(await postReceived(webhook, { emailId, receivedFor })).toBe(200);
      expect(await database.query("SELECT id FROM email_inbound_events WHERE provider_object_id = $1", [emailId])).toHaveLength(1);
      await drain();
      expect(await drain()).toMatchObject({ claimed: 0 });

      const [conversationId, ...others] = await conversationsOfMailbox(database, mailbox);
      expect(others).toEqual([]);
      expect(await deliveriesOfEmail(database, emailId)).toHaveLength(1);
      expect(await customerMessagesOf(database, conversationId)).toHaveLength(1);
    });
  });

  describe("mail that reaches no mailbox, or a disabled one", () => {
    it("records a never-issued relay token as a workspace-less no_mailbox delivery", async () => {
      const relayToken = opaqueToken();
      const emailId = await spool.put(await readFixture(FIRST, { relayToken, domain: uniqueCustomerDomain() }));

      expect(await postReceived(webhook, { emailId, receivedFor: [`${relayToken}@${INBOUND_DOMAIN}`] })).toBe(200);
      await drain();

      expect(await deliveriesOfEmail(database, emailId)).toEqual([expect.objectContaining({
        workspace_id: null,
        mailbox_id: null,
        state: "done",
        disposition: "drop",
        disposition_reason: "no_mailbox",
        conversation_id: null,
      })]);
      expect(await eventOfEmail(database, emailId)).toMatchObject({ state: "processed" });
    });

    it("attributes an unknown address on a direct-receiving domain to that domain's workspace", async () => {
      const { workspaceId } = await seedWorkspace(database);
      const customer = uniqueCustomerDomain();
      const receiving = await seedDomain(database, workspaceId, `receiving.${customer}`, { receivingVerified: true });
      const care = `care@${receiving.domain}`;
      const unknownEmail = await spool.put(await readFixture("mime/direct-receiving.eml", { relayToken: opaqueToken(), domain: customer }));

      expect(await postReceived(webhook, { emailId: unknownEmail, receivedFor: [care] })).toBe(200);
      await drain();
      const [dropped, ...others] = await deliveriesOfEmail(database, unknownEmail);
      expect(others).toEqual([]);
      expect(dropped).toMatchObject({ workspace_id: workspaceId, mailbox_id: null, state: "done", disposition: "drop", disposition_reason: "no_mailbox" });
      // What the operator needs to identify the dropped mail (FR-015, FR-016) is kept with it.
      expect(await database.queryOne(
        `SELECT classification, sender_address, subject, auth_results, received_for, raw_mime IS NOT NULL AS has_raw
           FROM email_inbound_deliveries WHERE id = $1`,
        [dropped.id],
      )).toEqual({
        classification: "person",
        sender_address: "frank@example.test",
        subject: "Return authorization",
        auth_results: expect.objectContaining({ spf: expect.any(String), dkim: expect.any(String), dmarc: expect.any(String) }),
        received_for: expect.any(Array),
        has_raw: true,
      });

      // Once the address is a mailbox, the same mail routes to it by the direct rule.
      const mailbox = await seedMailbox(database, { workspaceId, domain: receiving, local: "care" });
      const routedEmail = await spool.put(await readFixture("mime/direct-receiving.eml", { relayToken: opaqueToken(), domain: customer }));
      expect(await postReceived(webhook, { emailId: routedEmail, receivedFor: [care] })).toBe(200);
      await drain();
      expect(await deliveryOfEmail(database, routedEmail)).toMatchObject({
        mailbox_id: mailbox.id,
        route_rule: "direct",
        disposition: "ingest_only",
      });
      expect(await conversationsOfMailbox(database, mailbox)).toHaveLength(1);
    });

    it.each([
      ["verified", "pending", "a revoked domain loses"],
      ["pending", "verified", "a newly verified domain gains"],
    ] as const)("refreshes the domain a provider event names (%s to %s): %s its sending readiness at once (FR-003)", async (before, after, _change) => {
      const { workspaceId } = await seedWorkspace(database);
      const domain = await seedDomain(database, workspaceId, uniqueCustomerDomain());
      await database.execute("UPDATE email_domains SET sending_status = $2 WHERE id = $1", [domain.id, before]);
      // The provider's side of the change: the local provider reports a domain verified once marked so.
      if (after === "verified") await new LocalEmailDomainProvisioner({ spoolDir: spool.dir }).markVerified(domain.domain);

      expect(await postDomainEvent(webhook, { providerDomainId: domain.providerDomainId ?? "" })).toBe(200);
      expect(await drain()).toMatchObject({ processed: 1, errored: 0 });
      const due = await database.queryOne<{ next_check_at: Date }>("SELECT next_check_at FROM email_domains WHERE id = $1", [domain.id]);
      expect(due.next_check_at.getTime()).toBeLessThanOrEqual(Date.now());

      await channel.worker.sweep({ maxJobs: 50 });
      expect(await database.queryOne("SELECT sending_status FROM email_domains WHERE id = $1", [domain.id])).toEqual({ sending_status: after });
    });

    it("ignores a provider event about a domain no workspace holds", async () => {
      expect(await postDomainEvent(webhook, { providerDomainId: `local:${uniqueCustomerDomain()}` })).toBe(200);
      expect(await drain()).toMatchObject({ ignored: 1, errored: 0 });
    });

    it("drops mail for a disabled mailbox as mailbox_disabled and logs it", async () => {
      const { target, mailbox } = await supportTarget({ enabled: false });

      const emailId = await receiveAndDrain(FIRST, target);

      expect(await deliveryOfEmail(database, emailId)).toMatchObject({
        mailbox_id: mailbox.id,
        state: "done",
        disposition: "drop",
        disposition_reason: "mailbox_disabled",
        conversation_id: null,
      });
      expect(await conversationsOfMailbox(database, mailbox)).toEqual([]);
      const logged = await eventLog.list(mailbox.workspaceId, mailbox.id, {});
      expect(logged.items).toEqual([expect.objectContaining({ disposition: "drop", reason: "mailbox_disabled" })]);
    });
  });

  it("SC-003: runs no turn for any automated protocol fixture and logs every one of them", async () => {
    // The mailbox asks for full autonomy with an agent, which the deployment caps at draft: only
    // classification stands between this mail and a review turn. Mail from a person is accepted.
    const { target, mailbox } = await supportTarget({ engagementMode: "auto", withAgent: true });
    const { conversationId } = await firstContact(target);
    await seedOutboundMessageId(database, mailbox, conversationId, OUTBOUND_ID);
    const expected: Record<string, { classification: string; disposition: string; reason: string }> = {
      "auto-submitted-auto-replied.eml": { classification: "automated_sender", disposition: "drop", reason: "automated_sender" },
      "auto-submitted-no.eml": { classification: "person", disposition: "run_review_turn", reason: "accepted" },
      "dsn-foreign-id.eml": { classification: "automated_sender", disposition: "drop", reason: "automated_sender" },
      "dsn-radioso-id.eml": { classification: "bounce", disposition: "drop", reason: "bounce" },
      "list-id.eml": { classification: "automated_sender", disposition: "drop", reason: "automated_sender" },
      "precedence-bulk.eml": { classification: "automated_sender", disposition: "drop", reason: "automated_sender" },
      "precedence-junk.eml": { classification: "automated_sender", disposition: "drop", reason: "automated_sender" },
      "precedence-list.eml": { classification: "automated_sender", disposition: "drop", reason: "automated_sender" },
      "self-sender.eml": { classification: "self_sender", disposition: "drop", reason: "self_sender" },
      "x-auto-response-suppress.eml": { classification: "automated_sender", disposition: "drop", reason: "automated_sender" },
    };

    const deliveryIds: string[] = [];
    for (const [fixture, outcome] of Object.entries(expected)) {
      const emailId = await receiveAndDrain(`protocol/${fixture}`, target);
      const delivery = await deliveryOfEmail(database, emailId);
      expect({ fixture, ...delivery }).toMatchObject({
        fixture,
        state: "done",
        classification: outcome.classification,
        disposition: outcome.disposition,
        disposition_reason: outcome.reason,
      });
      deliveryIds.push(delivery.id);
    }

    const turns = await database.query(
      `SELECT d.id FROM email_inbound_deliveries d
        WHERE d.mailbox_id = $1 AND d.disposition = 'run_review_turn' AND d.classification <> 'person'
       UNION ALL
       SELECT m.id FROM messages m WHERE m.workspace_id = $2 AND m.role <> 'user'`,
      [mailbox.id, mailbox.workspaceId],
    );
    expect(turns).toEqual([]);
    const logged = await eventLog.list(mailbox.workspaceId, mailbox.id, { limit: 100 });
    expect(logged.items.map((item) => item.id)).toEqual(expect.arrayContaining(deliveryIds));
  });

  describe("the policy in force when the webhook accepted the mail (research B16)", () => {
    afterEach(async () => {
      expect(await drain()).toMatchObject({ claimed: 0 });
    });

    it("drops mail accepted while the mailbox was disabled even though it is enabled now", async () => {
      const { target, mailbox } = await supportTarget({ enabled: false });
      const emailId = await receive(FIRST, target);
      await changeMailboxPolicy(database, mailbox, { engagementMode: "operator_only", enabled: true, agentId: null });

      await drain();

      expect(await deliveryOfEmail(database, emailId)).toMatchObject({
        accepted_policy_version: 1,
        disposition: "drop",
        disposition_reason: "mailbox_disabled",
      });
    });

    // The S1 composition caps every mailbox at `operator_only`; a worker that runs every mode
    // shows the rule itself: the lower-autonomy mode of the accepted and the current policy wins.
    it.each([
      { accepted: "operator_only", current: "auto" },
      { accepted: "auto", current: "operator_only" },
    ] as const)("processes mail accepted under $accepted and processed under $current as operator_only", async (policies) => {
      const node = createWorkerNode(suite.url, { spoolDir: spool.dir, supportedModes: ALL_MODES });
      try {
        const { target, mailbox, agentId } = await supportTarget({ engagementMode: policies.accepted, withAgent: true });
        const app = await node.webhook();
        const acceptedEarlier = await receive(FIRST, target, { app });
        await changeMailboxPolicy(database, mailbox, { engagementMode: policies.current, enabled: true, agentId });
        const acceptedLater = await receive("mime/out-of-order-parent.eml", target, { app });

        expect(await node.worker.drain({ maxJobs: 5, stage: "inbound" })).toMatchObject({ processed: 2 });

        expect(await deliveryOfEmail(database, acceptedEarlier)).toMatchObject({
          accepted_policy_version: 1,
          disposition: "ingest_only",
          disposition_reason: "operator_only_mailbox",
        });
        const later = await deliveryOfEmail(database, acceptedLater);
        expect(later.accepted_policy_version).toBe(2);
        // Mail accepted after the change is governed by both versions being the new one.
        expect([later.disposition, later.disposition_reason]).toEqual(
          policies.current === "auto" ? ["run_review_turn", "accepted"] : ["ingest_only", "operator_only_mailbox"],
        );
      } finally {
        await node.close();
      }
    });
  });
});
