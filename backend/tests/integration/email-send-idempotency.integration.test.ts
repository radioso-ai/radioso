import { afterAll, afterEach, beforeAll, expect, it, vi } from "vitest";

import { ActionRequestRepository } from "../../src/db/repositories/actionRequestRepository.js";
import { EMAIL_SEND_ACTION_TYPE, emailSendKey } from "../../src/modules/emailChannel/public.js";
import { ResendEmailDriver } from "../../src/modules/mail/public.js";
import type { Database } from "../../src/shared/infra/database.js";
import {
  activityOf,
  changeMailboxPolicy,
  createEmailChannelDatabase,
  createSpool,
  createWorkerNode,
  deliveryOfEmail,
  ownershipOf,
  postDeliveryEvent,
  postReceived,
  readFixture,
  relayAddressOf,
} from "./support/emailChannelHarness.js";
import {
  createApiNode,
  deliveryFailuresOf,
  messagesOf,
  openEmailConversation,
  outboxActionsOf,
  ownershipVersionOf,
  providerAcceptsUnder,
  replyFromInbox,
  sendIntentOf,
  sendIntentsOf,
} from "./support/emailSendHarness.js";
import { resolveIntegrationDatabase } from "./support/integrationDatabase.js";

// A teammate's reply on an email conversation, end to end against Postgres (User Story 3): the
// reply route commits the message with its `email.send` action, a worker delivers the action
// through the local provider, which honours idempotency keys as the real one does, and provider
// events and decisions settle what happened to it. Covers the reply's atomicity and its refusal
// while the mailbox cannot send, one provider accept however often the action is redelivered,
// authority revoked before the first attempt and the audited resend, a bounce, the absence of
// `Auto-Submitted` on operator mail, and a human-owned thread after the customer replies (AS3.6).

const { describeIntegration, integrationDatabaseUrl } = await resolveIntegrationDatabase();

const REPLY = "Hi Alice, you can update it under Settings > Billing.";
const ALL_MODES = ["operator_only", "draft", "auto"] as const;

type WorkerNode = ReturnType<typeof createWorkerNode>;

describeIntegration("email send idempotency (Postgres, User Story 3)", () => {
  let suite: Awaited<ReturnType<typeof createEmailChannelDatabase>>;
  let database: Database;
  let spool: Awaited<ReturnType<typeof createSpool>>;
  let api: ReturnType<typeof createApiNode>;
  const nodes: WorkerNode[] = [];

  beforeAll(async () => {
    suite = await createEmailChannelDatabase(integrationDatabaseUrl, "send_idempotency");
    database = suite.database;
    spool = await createSpool();
    api = createApiNode(database, { spoolDir: spool.dir });
  }, 60_000);

  afterEach(async () => {
    vi.restoreAllMocks();
    await Promise.all(nodes.splice(0).map((node) => node.close().catch(() => undefined)));
    // Every action a test queued was delivered, so no later test's dispatch picks one up.
    expect(await database.query("SELECT id FROM routine_action_requests WHERE status IN ('pending', 'in_progress')")).toEqual([]);
  });

  afterAll(async () => {
    await spool?.remove();
    await suite?.close();
  }, 30_000);

  const workerNode = (options: { supportedModes?: readonly (typeof ALL_MODES)[number][] } = {}): WorkerNode => {
    const node = createWorkerNode(suite.url, { spoolDir: spool.dir, ...options });
    nodes.push(node);
    return node;
  };

  const openConversation = (options: Parameters<typeof openEmailConversation>[2] = {}) =>
    openEmailConversation(database, { node: workerNode(), spool }, options);

  const setSendingStatus = async (domainId: string, status: "pending" | "verified" | "failed") => {
    await database.execute("UPDATE email_domains SET sending_status = $2 WHERE id = $1", [domainId, status]);
  };

  /** A reply the provider accepted: the conversation, the message and its send. */
  const acceptedReply = async (options: Parameters<typeof openEmailConversation>[2] = {}) => {
    const conversation = await openConversation(options);
    const messageId = await replyFromInbox(database, api, conversation, REPLY);
    expect(await workerNode().dispatch()).toMatchObject({ dispatched: 1, failed: 0 });
    const intent = await sendIntentOf(database, messageId);
    expect(intent.state).toBe("accepted");
    return { ...conversation, messageId, intent };
  };

  it("commits the reply with its email.send action, then sends it once as the mailbox, threaded under the customer's mail", async () => {
    const conversation = await openConversation();
    const { conversationId, mailbox, domain, teammate } = conversation;
    const ownershipVersion = await ownershipVersionOf(database, conversationId);
    const pushesBefore = api.actionDrain.pushes;

    const response = await api.reply(teammate, conversationId, { message: REPLY, expectedVersion: ownershipVersion });

    expect(response.status).toBe(201);
    const messageId = (response.body as { message: { id: string } }).message.id;
    expect((await messagesOf(database, conversationId)).map((message) => [message.role, message.source])).toEqual([
      ["user", "customer"],
      ["assistant", "human_agent"],
    ]);
    const [action, ...otherActions] = await outboxActionsOf(database, conversationId);
    expect(otherActions).toEqual([]);
    expect(action).toMatchObject({
      type: EMAIL_SEND_ACTION_TYPE,
      status: "pending",
      idempotency_key: emailSendKey.message(messageId),
      payload: {
        version: 1,
        trigger: "operator_reply",
        mailboxId: mailbox.id,
        conversationId,
        messageId,
        heldReplyId: null,
        authority: { policyVersion: 1, ownershipVersion, mode: "operator_only", domainId: domain.id },
      },
    });
    // Ids and authority only: no text, address or subject rides the outbox.
    expect(JSON.stringify(action?.payload)).not.toMatch(/Billing|@|Question/u);
    expect(api.actionDrain.pushes).toBe(pushesBefore + 1);

    const sender = workerNode();
    expect(await sender.dispatch()).toMatchObject({ dispatched: 1, failed: 0 });

    const intent = await sendIntentOf(database, messageId);
    const [accepted, ...otherAccepts] = await providerAcceptsUnder(spool.dir, emailSendKey.message(messageId));
    expect(otherAccepts).toEqual([]);
    expect(sender.provider.sendKeys).toEqual([emailSendKey.message(messageId)]);
    expect(intent).toMatchObject({
      state: "accepted",
      trigger: "operator_reply",
      authorKind: "operator",
      idempotencyKey: emailSendKey.message(messageId),
      provider: "local",
      providerMessageId: accepted?.providerMessageId,
      suppliedRfcMessageId: `<${intent.id}@${domain.domain}>`,
      deliveredRfcMessageId: `<${intent.id}@${domain.domain}>`,
    });
    expect(accepted?.message).toMatchObject({
      from: { email: mailbox.address, name: "Support" },
      to: "alice@example.test",
      replyTo: mailbox.address,
      subject: "Re: Question about my account",
      text: REPLY,
      threading: {
        messageId: intent.suppliedRfcMessageId,
        inReplyTo: "<msg-0001@example.test>",
        references: ["<msg-0001@example.test>"],
      },
    });
    expect(await database.query(
      "SELECT rfc_message_id, direction, origin FROM email_thread_messages WHERE message_id = $1",
      [messageId],
    )).toEqual([{ rfc_message_id: intent.suppliedRfcMessageId, direction: "outbound", origin: "radioso_generated" }]);
  });

  it("rolls the reply back when its email.send action cannot be queued", async () => {
    const { conversationId, teammate } = await openConversation();
    const ownershipBefore = await ownershipOf(database, conversationId);
    const pushesBefore = api.actionDrain.pushes;
    vi.spyOn(ActionRequestRepository.prototype, "enqueue").mockRejectedValueOnce(new Error("outbox unavailable"));

    const response = await api.reply(teammate, conversationId, {
      message: REPLY,
      expectedVersion: await ownershipVersionOf(database, conversationId),
    });

    expect(response.status).toBe(500);
    expect((await messagesOf(database, conversationId)).map((message) => message.source)).toEqual(["customer"]);
    expect(await outboxActionsOf(database, conversationId)).toEqual([]);
    expect(await ownershipOf(database, conversationId)).toEqual(ownershipBefore);
    expect(api.actionDrain.pushes).toBe(pushesBefore);
  });

  it("refuses the reply before any write while the sending domain is unverified, and takes it once verified", async () => {
    const { conversationId, teammate, domain } = await openConversation();
    await setSendingStatus(domain.id, "pending");
    const ownershipBefore = await ownershipOf(database, conversationId);
    const activityBefore = await activityOf(database, conversationId);
    const pushesBefore = api.actionDrain.pushes;
    const expectedVersion = await ownershipVersionOf(database, conversationId);

    const refused = await api.reply(teammate, conversationId, { message: REPLY, expectedVersion });

    expect(refused.status).toBe(409);
    expect(refused.body).toMatchObject({
      error: { code: "email_sending_not_verified", details: { step: "verify_sending_domain", domain: domain.domain } },
    });
    expect((await messagesOf(database, conversationId)).map((message) => message.source)).toEqual(["customer"]);
    expect(await outboxActionsOf(database, conversationId)).toEqual([]);
    expect(await ownershipOf(database, conversationId)).toEqual(ownershipBefore);
    expect(await activityOf(database, conversationId)).toEqual(activityBefore);
    expect(api.actionDrain.pushes).toBe(pushesBefore);

    // Sending again after setup is safe: nothing of the refused reply was written.
    await setSendingStatus(domain.id, "verified");
    expect((await api.reply(teammate, conversationId, { message: REPLY, expectedVersion })).status).toBe(201);
    expect(await workerNode().dispatch()).toMatchObject({ dispatched: 1 });
    expect((await outboxActionsOf(database, conversationId)).map((action) => action.status)).toEqual(["dispatched"]);
  });

  it("gives one provider accept when the action is redelivered after the provider accepted it", async () => {
    const { conversationId, messageId, intent } = await acceptedReply();
    const key = emailSendKey.message(messageId);
    // At-least-once delivery: the same action reaches a worker again.
    await database.execute(
      "UPDATE routine_action_requests SET status = 'pending', next_attempt_at = NULL WHERE conversation_id = $1",
      [conversationId],
    );

    const redelivered = workerNode();
    expect(await redelivered.dispatch()).toMatchObject({ dispatched: 1, failed: 0 });

    expect(redelivered.provider.sendKeys).toEqual([]);
    expect(await providerAcceptsUnder(spool.dir, key)).toHaveLength(1);
    expect(await sendIntentsOf(database, messageId)).toEqual([intent]);
  });

  it("halts a reply whose sending authority was revoked before the first attempt, flags it, and sends it once on an audited resend", async () => {
    const conversation = await openConversation();
    const { conversationId, domain, teammate, workspaceId } = conversation;
    const messageId = await replyFromInbox(database, api, conversation, REPLY);
    await setSendingStatus(domain.id, "failed");

    const first = workerNode();
    expect(await first.dispatch()).toMatchObject({ dispatched: 1, failed: 0 });

    expect(first.provider.sendKeys).toEqual([]);
    const halted = await sendIntentOf(database, messageId);
    expect(halted).toMatchObject({ state: "halted", haltReason: "sending_not_verified", request: null, firstAttemptAt: null });
    const [failure, ...otherFailures] = await deliveryFailuresOf(database, conversationId);
    expect(otherFailures).toEqual([]);
    expect(failure).toMatchObject({ message_id: messageId, failure_kind: "halted", detail_code: "sending_not_verified", clear_reason: null });
    expect(await activityOf(database, conversationId)).toContainEqual({
      kind: "delivery_failed",
      detail: { failureId: failure?.id, messageId, failureKind: "halted" },
    });
    const facts = await api.channel.conversationFacts.read(workspaceId, conversationId);
    // The message shows it was not sent; why is the failure's detail and the mailbox's sending state.
    expect(facts?.messages.find((message) => message.messageId === messageId)?.delivery).toMatchObject({ state: "halted" });
    expect(facts?.sending).toEqual({ state: "not_verified" });

    // A resend is refused before any write while the domain still cannot send.
    const failureId = failure?.id ?? "";
    await expect(api.decisions.resolve(teammate, failureId, "resend")).rejects.toMatchObject({ code: "email_sending_not_verified" });
    expect(await outboxActionsOf(database, conversationId)).toHaveLength(1);

    await setSendingStatus(domain.id, "verified");
    const pushesBefore = api.actionDrain.pushes;
    const resolved = await api.decisions.resolve(teammate, failureId, "resend");

    expect(resolved).toMatchObject({ clearReason: "operator_resolved", clearedByUserId: teammate.userId });
    expect(api.audit.events).toContainEqual(expect.objectContaining({
      eventType: "hitl.delivery_failure",
      workspaceId,
      metadata: expect.objectContaining({ action: "resolved", decision: "resend", failureId, sendIntentId: halted.id, actorUserId: teammate.userId }),
    }));
    const resendKey = emailSendKey.resend(messageId, 1);
    expect((await outboxActionsOf(database, conversationId)).map((action) => [action.idempotency_key, action.status])).toEqual([
      [emailSendKey.message(messageId), "dispatched"],
      [resendKey, "pending"],
    ]);
    expect(api.actionDrain.pushes).toBe(pushesBefore + 1);

    const second = workerNode();
    expect(await second.dispatch()).toMatchObject({ dispatched: 1, failed: 0 });

    expect(second.provider.sendKeys).toEqual([resendKey]);
    expect(await providerAcceptsUnder(spool.dir, resendKey)).toHaveLength(1);
    expect(await providerAcceptsUnder(spool.dir, emailSendKey.message(messageId))).toEqual([]);
    expect(await sendIntentsOf(database, messageId)).toEqual([
      expect.objectContaining({ id: halted.id, state: "halted", uncertainResolution: "resend_authorized", uncertainResolvedByUserId: teammate.userId }),
      expect.objectContaining({ trigger: "audited_resend", idempotencyKey: resendKey, state: "accepted" }),
    ]);
    // One decision per failure: deciding again neither queues nor sends a second resend.
    await expect(api.decisions.resolve(teammate, failureId, "resend")).rejects.toMatchObject({ statusCode: 409 });
    expect(await outboxActionsOf(database, conversationId)).toHaveLength(2);
  });

  it("marks a bounced send bounced, flags the conversation, and keeps only the sanitized detail", async () => {
    const { conversationId, messageId, intent, workspaceId } = await acceptedReply();
    const providerMessageId = intent.providerMessageId ?? "";
    const prose = "550 5.1.1 <alice@example.test>: The email account that you tried to reach does not exist";
    const events = workerNode();
    const app = await events.webhook();

    expect(await postDeliveryEvent(app, {
      type: "email.bounced",
      providerMessageId,
      bounce: { type: "Permanent", subType: "General", message: prose },
    })).toBe(200);
    expect(await events.worker.drain({ maxJobs: 5, stage: "inbound" })).toMatchObject({ claimed: 1, processed: 1 });

    const bounced = await sendIntentOf(database, messageId);
    expect(bounced).toMatchObject({ state: "bounced", failureCode: "Permanent:General:5.1.1", nextReconcileAt: null });
    expect(bounced.settledAt).not.toBeNull();
    expect(bounced.request?.body).toBeNull();
    const [failure, ...otherFailures] = await deliveryFailuresOf(database, conversationId);
    expect(otherFailures).toEqual([]);
    expect(failure).toMatchObject({ message_id: messageId, failure_kind: "bounced", detail_code: "Permanent:General:5.1.1" });
    expect(await activityOf(database, conversationId)).toContainEqual({
      kind: "delivery_failed",
      detail: { failureId: failure?.id, messageId, failureKind: "bounced" },
    });
    // The attention the inbox shows: an open failure, and the detail on the message.
    const open = await api.decisions.list(workspaceId, { state: "open", limit: 10 });
    expect(open.items).toEqual([expect.objectContaining({ id: failure?.id, kind: "bounced", detailCode: "Permanent:General:5.1.1" })]);
    const facts = await api.channel.conversationFacts.read(workspaceId, conversationId);
    expect(facts?.messages.find((message) => message.messageId === messageId)?.delivery).toEqual({
      state: "bounced",
      failureCode: "Permanent:General:5.1.1",
    });
    // The bounce message quotes the recipient; none of it is kept anywhere.
    const kept = await database.query<{ text: string }>(
      `SELECT row_to_json(e)::text AS text FROM email_inbound_events e WHERE provider_object_id = $1
       UNION ALL SELECT row_to_json(i)::text FROM email_send_intents i WHERE id = $2
       UNION ALL SELECT row_to_json(f)::text FROM conversation_delivery_failures f WHERE conversation_id = $3
       UNION ALL SELECT row_to_json(a)::text FROM conversation_activity a WHERE conversation_id = $3`,
      [providerMessageId, intent.id, conversationId],
    );
    expect(kept.map((row) => row.text).join("\n")).not.toMatch(/does not exist|alice@example\.test>:/u);

    // A late delivery event never regresses a settled send.
    expect(await postDeliveryEvent(app, { type: "email.delivered", providerMessageId })).toBe(200);
    expect(await events.worker.drain({ maxJobs: 5, stage: "inbound" })).toMatchObject({ claimed: 1 });
    expect(await sendIntentOf(database, messageId)).toMatchObject({ state: "bounced", version: bounced.version });
  });

  it("sends operator mail without Auto-Submitted, as the provider receives it", async () => {
    const { messageId, intent } = await acceptedReply();
    const [accepted] = await providerAcceptsUnder(spool.dir, emailSendKey.message(messageId));
    expect(intent.request?.threading.autoSubmitted).toBeNull();
    expect(accepted?.message.threading?.autoSubmitted).toBeNull();

    // The headers the real provider client puts on the wire for the message the worker sent.
    const posted: { body: { headers?: Record<string, string> }; idempotencyKey?: string | null }[] = [];
    const resend = new ResendEmailDriver({
      api: {
        request: async (_method: string, _path: string, options: (typeof posted)[number]) => {
          posted.push(options);
          return { id: "re_1" };
        },
      } as unknown as ConstructorParameters<typeof ResendEmailDriver>[0]["api"],
    });
    await resend.send(accepted?.message ?? { to: "", from: { email: "" }, subject: "", text: "" });

    expect(posted).toHaveLength(1);
    expect(posted[0]?.idempotencyKey).toBe(emailSendKey.message(messageId));
    expect(posted[0]?.body.headers).toEqual({
      "Message-ID": intent.suppliedRfcMessageId,
      "In-Reply-To": "<msg-0001@example.test>",
      References: "<msg-0001@example.test>",
    });
  });

  it("keeps the agent out when the customer replies after a teammate did, even on an autonomous mailbox (AS3.6)", async () => {
    const { conversationId, mailbox, domain, agentId, teammate, intent, messageId } = await acceptedReply();
    // The mailbox now asks for full autonomy; only the teammate's ownership stands in the way.
    await changeMailboxPolicy(database, mailbox, { engagementMode: "auto", enabled: true, agentId });
    const intake = workerNode({ supportedModes: ALL_MODES });
    const raw = (await readFixture("mime/header-threaded-reply.eml", { relayToken: mailbox.relayToken, domain: domain.domain }))
      .toString("latin1")
      .replaceAll("<out-0001@in.relay.test>", intent.suppliedRfcMessageId);
    const emailId = await spool.put(Buffer.from(raw, "latin1"));

    expect(await postReceived(await intake.webhook(), { emailId, receivedFor: [relayAddressOf(mailbox)] })).toBe(200);
    expect(await intake.worker.drain({ maxJobs: 5, stage: "inbound" })).toMatchObject({ processed: 1 });

    expect(await deliveryOfEmail(database, emailId)).toMatchObject({
      conversation_id: conversationId,
      accepted_policy_version: 2,
      disposition: "ingest_only",
      disposition_reason: "human_owned",
    });
    expect(await ownershipOf(database, conversationId)).toMatchObject({ state: "human_owned" });
    expect(await database.queryOne<{ owner_user_id: string }>(
      "SELECT owner_user_id FROM conversation_ownership WHERE conversation_id = $1",
      [conversationId],
    )).toEqual({ owner_user_id: teammate.userId });
    expect((await messagesOf(database, conversationId)).map((message) => [message.role, message.source])).toEqual([
      ["user", "customer"],
      ["assistant", "human_agent"],
      ["user", "customer"],
    ]);
    expect(await database.queryOne<{ review_revision: number; review_due_at: Date | null }>(
      "SELECT review_revision, review_due_at FROM email_thread_links WHERE conversation_id = $1",
      [conversationId],
    )).toEqual({ review_revision: 0, review_due_at: null });
    // Nothing more is queued to go out: the teammate's reply is the only send on the thread.
    expect((await outboxActionsOf(database, conversationId)).map((action) => action.idempotency_key)).toEqual([
      emailSendKey.message(messageId),
    ]);
  });
});
