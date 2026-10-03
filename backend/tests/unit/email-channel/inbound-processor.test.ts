import { randomBytes, randomUUID } from "node:crypto";

import type { ConnectorIngestInput, ConnectorIngestResult } from "@radioso/connector-api";
import { describe, expect, it, vi } from "vitest";

import {
  EmailInboundProcessor,
  type EmailThreadProtocolScope,
} from "../../../src/modules/connectors/plugins/email/emailInboundProcessor.js";
import type { ConversationActivityEvent } from "../../../src/modules/conversationActivity/contracts/index.js";
import type { EmailMailboxRecord } from "../../../src/modules/emailChannel/persistence/emailMailboxRepository.js";
import { generateOpaqueToken, MailboxService, type EngagementMode } from "../../../src/modules/emailChannel/public.js";
import { InboundFetchError, type InboundEmailMessage } from "../../../src/modules/mail/public.js";
import {
  InMemoryEmailDomains,
  InMemoryEmailInbound,
  InMemoryEmailMailboxes,
  InMemoryEmailThreads,
  inMemoryPolicyChanges,
} from "../../support/inMemoryEmailChannel.js";

const INBOUND_DOMAIN = "in.radioso.test";
const workspaceId = "11111111-1111-4111-8111-111111111111";
const agentId = "44444444-4444-4444-8444-444444444444";
const CUSTOMER = "alice@example.test";
const MINUTE_MS = 60_000;

const token = () => generateOpaqueToken((size) => randomBytes(size));

const harness = (options: { supportedModes?: readonly EngagementMode[] } = {}) => {
  let now = new Date("2026-10-03T12:00:00.000Z");
  const clock = () => now;
  const log: string[] = [];
  const domains = new InMemoryEmailDomains(clock);
  const mailboxes = new InMemoryEmailMailboxes(clock);
  const inbound = new InMemoryEmailInbound(clock, log);
  const threads = new InMemoryEmailThreads(log);
  const conversations = new Map<string, { input: ConnectorIngestInput; ownership: "ai_owned" | "human_owned"; messageIds: string[] }>();
  const activity: ConversationActivityEvent[] = [];
  const messages = new Map<string, InboundEmailMessage>();
  const fetchFailures: InboundFetchError[] = [];

  const fetchMessage = vi.fn(async (providerObjectId: string) => {
    const failure = fetchFailures.shift();
    if (failure) throw failure;
    const message = messages.get(providerObjectId);
    if (!message) throw new InboundFetchError(false, "message_not_found");
    return message;
  });
  const ingestFailures: Error[] = [];
  const ingest = vi.fn(async (input: ConnectorIngestInput): Promise<ConnectorIngestResult> => {
    log.push("ingest");
    const failure = ingestFailures.shift();
    if (failure) throw failure;
    const conversationId = input.conversation.conversationId;
    const existing = conversations.get(conversationId);
    if (!existing && input.conversation.kind === "existing") throw new Error("Conversation not found");
    const conversation = existing ?? { input, ownership: "ai_owned" as const, messageIds: [] };
    conversations.set(conversationId, conversation);
    const messageCreated = !conversation.messageIds.includes(input.message.id);
    if (messageCreated) conversation.messageIds.push(input.message.id);
    if (input.humanOwnership) conversation.ownership = "human_owned";
    return {
      conversationId,
      messageId: input.message.id,
      conversationCreated: !existing,
      messageCreated,
      ownership: { state: conversation.ownership, version: conversation.ownership === "human_owned" ? 1 : 0 },
    };
  });
  const requestDrain = vi.fn(async () => undefined);
  const scope: EmailThreadProtocolScope = {
    lockThread: async () => {
      log.push("lockThread");
    },
    inbound,
    threads,
    conversations: { ownershipOf: async ({ conversationId }) => conversations.get(conversationId)?.ownership ?? null },
    activity: {
      record: async (event) => {
        activity.push(event);
      },
    },
  };
  const threadProtocol = { run: <T>(work: (unit: EmailThreadProtocolScope) => Promise<T>) => work(scope) };
  const receipts = new MailboxService({
    mailboxes,
    domainRecords: domains,
    sendingDomains: { ensureRegistered: vi.fn() },
    policyChanges: inMemoryPolicyChanges(mailboxes),
    agents: { findByIdAndWorkspaceId: vi.fn(async () => null) },
    audit: { record: vi.fn(async () => undefined) },
    logger: { warn: vi.fn() },
    randomBytes: (size) => randomBytes(size),
    clock,
    config: { inboundDomain: INBOUND_DOMAIN, supportedModes: ["operator_only"] },
  });
  const logger = { warn: vi.fn() };
  const deliveryEvents = {
    applyStatus: vi.fn(async (): Promise<"applied" | "ignored" | "foreign"> => "applied"),
    applyDsnBounce: vi.fn(async () => 0),
  };
  const processor = new EmailInboundProcessor({
    receiver: { provider: "local", fetchMessage },
    inbound,
    mailboxes,
    domains,
    threads,
    receipts,
    deliveryEvents,
    threadProtocol,
    chat: { ingest },
    drains: { requestDrain },
    metrics: null,
    logger,
    clock,
    createId: randomUUID,
    randomBytes: (size) => randomBytes(size),
    config: { inboundDomain: INBOUND_DOMAIN, rawMaxBytes: 64, supportedModes: options.supportedModes ?? ["operator_only"] },
  });

  const domain = domains.seed({ workspaceId, domain: "customer.test" });

  const seedMailbox = (overrides: Partial<EmailMailboxRecord> = {}): EmailMailboxRecord => {
    const mailbox = mailboxes.seed({
      workspaceId,
      domainId: domain.id,
      address: "support@customer.test",
      relayToken: token(),
      ...overrides,
    });
    mailboxes.history.push({
      mailboxId: mailbox.id,
      version: mailbox.policyVersion,
      engagementMode: mailbox.engagementMode,
      enabled: mailbox.enabled,
      agentId: mailbox.agentId,
      effectiveAt: clock(),
      changedByUserId: null,
    });
    return mailbox;
  };

  const relayAddressOf = (mailbox: EmailMailboxRecord) => `${mailbox.relayToken}@${INBOUND_DOMAIN}`;

  const message = (overrides: Partial<InboundEmailMessage> = {}): InboundEmailMessage => ({
    rfcMessageId: `<${randomUUID()}@example.test>`,
    inReplyTo: null,
    references: [],
    from: { address: CUSTOMER, displayName: "Alice" },
    to: ["support@customer.test"],
    cc: [],
    deliveredTo: [],
    subject: "Order 1234",
    text: "Where is my order?",
    html: null,
    automation: { autoSubmitted: null, precedence: null, autoResponseSuppress: null, listId: null },
    report: null,
    attachments: [],
    authentication: { spf: "pass", dkim: "pass", dmarc: "pass" },
    spamVerdict: "unknown",
    raw: Buffer.alloc(100, "a"),
    ...overrides,
  });

  const runEvent = async (eventId: string) => {
    const claimed = (await inbound.claimDueEvents({ limit: 50, leaseSeconds: 300 })).find((event) => event.id === eventId);
    if (!claimed) throw new Error("event is not due");
    return processor.process(claimed);
  };

  const receive = async (inboundMessage: InboundEmailMessage, envelope: Record<string, unknown> = {}) => {
    const providerObjectId = randomUUID();
    messages.set(providerObjectId, inboundMessage);
    const event = inbound.seedEvent({ providerObjectId, envelope });
    const outcome = await runEvent(event.id);
    return { outcome, event: inbound.events.get(event.id)!, deliveries: await inbound.listEventDeliveries(event.id) };
  };

  return {
    inbound,
    threads,
    mailboxes,
    domains,
    domain,
    conversations,
    activity,
    log,
    logger,
    ingest,
    deliveryEvents,
    fetchMessage,
    fetchFailures,
    ingestFailures,
    requestDrain,
    seedMailbox,
    relayAddressOf,
    message,
    receive,
    runEvent,
    messages,
    now: () => now,
    advance: (ms: number) => {
      now = new Date(now.getTime() + ms);
    },
    setNow: (at: Date) => {
      now = at;
    },
  };
};

describe("EmailInboundProcessor: routing", () => {
  it("routes a relay address and opens a human-owned conversation on an operator-only mailbox", async () => {
    const h = harness();
    const mailbox = h.seedMailbox();

    const { outcome, event, deliveries } = await h.receive(h.message({ deliveredTo: [h.relayAddressOf(mailbox)] }));

    expect(outcome).toBe("processed");
    expect(event.state).toBe("processed");
    expect(deliveries).toHaveLength(1);
    expect(deliveries[0]).toMatchObject({
      mailboxId: mailbox.id,
      workspaceId,
      routeRule: "relay",
      state: "done",
      classification: "person",
      disposition: "ingest_only",
      dispositionReason: "operator_only_mailbox",
      threadMatch: "new_thread",
    });
    expect(h.ingest).toHaveBeenCalledOnce();
    const [input] = h.ingest.mock.calls[0];
    expect(input).toMatchObject({
      workspaceId,
      agentId: null,
      conversation: {
        kind: "new",
        sourceChannel: "email",
        channelContext: {
          provider: "email",
          mailbox: { id: mailbox.id, address: "support@customer.test" },
          threadKey: expect.any(String),
          participant: { address: CUSTOMER },
        },
      },
      message: { text: "Where is my order?", receivedAt: event.receivedAt },
      humanOwnership: { reason: "operator_only_mailbox" },
    });
    expect(JSON.stringify(input.conversation)).not.toContain(h.threads.links.get(input.conversation.conversationId)?.threadToken);
  });

  it("caps the stored raw message at the configured size", async () => {
    const h = harness();
    const mailbox = h.seedMailbox();

    const { deliveries } = await h.receive(h.message({ deliveredTo: [h.relayAddressOf(mailbox)] }));

    expect(h.inbound.deliveries.get(deliveries[0].id)).toMatchObject({ rawSizeBytes: 100, rawTruncated: true });
    expect(h.inbound.deliveries.get(deliveries[0].id)?.rawMime).toHaveLength(64);
  });

  it("routes by the direct rule only on a receiving-verified domain", async () => {
    const h = harness();
    const mailbox = h.seedMailbox();

    const forwarded = await h.receive(h.message({ to: ["support@customer.test"], deliveredTo: ["support@customer.test"] }));
    expect(forwarded.outcome).toBe("ignored");
    expect(forwarded.deliveries).toEqual([]);

    h.domains.records.set(h.domain.id, { ...h.domain, receivingStatus: "verified" });
    const direct = await h.receive(h.message({ deliveredTo: ["Support@customer.test"] }));
    expect(direct.outcome).toBe("processed");
    expect(direct.deliveries).toEqual([expect.objectContaining({ mailboxId: mailbox.id, routeRule: "direct", state: "done" })]);
    expect(h.ingest).toHaveBeenCalledOnce();
  });

  it("records a never-issued relay token as a workspace-less no_mailbox delivery", async () => {
    const h = harness();
    h.seedMailbox();

    const { outcome, deliveries } = await h.receive(h.message({ deliveredTo: [`${token()}@${INBOUND_DOMAIN}`] }));

    expect(outcome).toBe("processed");
    expect(deliveries).toEqual([expect.objectContaining({
      workspaceId: null,
      mailboxId: null,
      state: "done",
      disposition: "drop",
      dispositionReason: "no_mailbox",
    })]);
    expect(h.ingest).not.toHaveBeenCalled();
  });

  it("attributes an unknown address on a direct-receiving domain to the domain's workspace", async () => {
    const h = harness();
    h.seedMailbox();
    h.domains.records.set(h.domain.id, { ...h.domain, receivingStatus: "verified" });

    const { deliveries } = await h.receive(h.message({ to: ["billing@customer.test"], deliveredTo: ["billing@customer.test"] }));

    expect(deliveries).toEqual([expect.objectContaining({ workspaceId, mailboxId: null, dispositionReason: "no_mailbox" })]);
  });

  it("fans out one delivery, and one conversation, per mailbox", async () => {
    const h = harness();
    const support = h.seedMailbox();
    const sales = h.seedMailbox({ address: "sales@customer.test" });

    const { deliveries } = await h.receive(h.message({ deliveredTo: [h.relayAddressOf(support), h.relayAddressOf(sales)] }));

    expect(deliveries.map((delivery) => delivery.mailboxId).sort()).toEqual([support.id, sales.id].sort());
    expect(deliveries.every((delivery) => delivery.state === "done")).toBe(true);
    expect(new Set(deliveries.map((delivery) => delivery.conversationId)).size).toBe(2);
    expect(h.ingest).toHaveBeenCalledTimes(2);
  });

  it("updates the mailbox's last received time for routed mail, dropped or not", async () => {
    const h = harness();
    const mailbox = h.seedMailbox();

    const { event } = await h.receive(h.message({
      from: { address: "support@customer.test", displayName: null },
      deliveredTo: [h.relayAddressOf(mailbox)],
    }));

    expect(h.mailboxes.records.get(mailbox.id)?.lastReceivedAt).toEqual(event.receivedAt);
  });
});

describe("EmailInboundProcessor: policy at acceptance", () => {
  it("takes the accepted policy version from the event's received_at", async () => {
    const h = harness();
    const mailbox = h.seedMailbox();
    const providerObjectId = randomUUID();
    h.messages.set(providerObjectId, h.message({ deliveredTo: [h.relayAddressOf(mailbox)] }));
    const event = h.inbound.seedEvent({ providerObjectId });

    h.advance(MINUTE_MS);
    await h.mailboxes.appendPolicyVersion({
      mailboxId: mailbox.id,
      expectedVersion: 1,
      engagementMode: "operator_only",
      enabled: true,
      agentId: null,
      changedByUserId: null,
    });
    h.advance(MINUTE_MS);
    await h.runEvent(event.id);

    const [delivery] = await h.inbound.listEventDeliveries(event.id);
    expect(delivery.acceptedPolicyVersion).toBe(1);
  });

  it("drops mail accepted while enabled when the mailbox has been disabled since", async () => {
    const h = harness();
    const mailbox = h.seedMailbox();
    const providerObjectId = randomUUID();
    h.messages.set(providerObjectId, h.message({ deliveredTo: [h.relayAddressOf(mailbox)] }));
    const event = h.inbound.seedEvent({ providerObjectId });
    h.advance(MINUTE_MS);
    await h.mailboxes.appendPolicyVersion({
      mailboxId: mailbox.id,
      expectedVersion: 1,
      engagementMode: "operator_only",
      enabled: false,
      agentId: null,
      changedByUserId: null,
    });

    await h.runEvent(event.id);

    const [delivery] = await h.inbound.listEventDeliveries(event.id);
    expect(delivery).toMatchObject({ acceptedPolicyVersion: 1, disposition: "drop", dispositionReason: "mailbox_disabled", state: "done" });
    expect(h.ingest).not.toHaveBeenCalled();
  });

  it.each(["operator_only", "draft", "auto"] as const)(
    "never reaches a review turn under the S1 supported modes (mailbox mode %s, with an agent)",
    async (engagementMode) => {
      const h = harness({ supportedModes: ["operator_only"] });
      const mailbox = h.seedMailbox({ engagementMode, agentId });

      const { deliveries } = await h.receive(h.message({ deliveredTo: [h.relayAddressOf(mailbox)] }));

      expect(deliveries[0]).toMatchObject({ disposition: "ingest_only", dispositionReason: "operator_only_mailbox" });
      expect(h.ingest.mock.calls[0][0]).toMatchObject({ agentId, humanOwnership: { reason: "operator_only_mailbox" } });
    },
  );
});

describe("EmailInboundProcessor: fetch retries", () => {
  it("schedules a drain at next_attempt_at when a fetch fails retryably", async () => {
    const h = harness();
    const mailbox = h.seedMailbox();
    h.fetchFailures.push(new InboundFetchError(true, "provider_unavailable"));

    const { outcome, event } = await h.receive(h.message({ deliveredTo: [h.relayAddressOf(mailbox)] }));

    expect(outcome).toBe("retrying");
    expect(event).toMatchObject({ state: "pending", lastErrorCode: "provider_unavailable" });
    expect(event.nextAttemptAt.getTime()).toBeGreaterThan(h.now().getTime());
    expect(h.requestDrain).toHaveBeenCalledWith(expect.objectContaining({ stage: "inbound", scheduleAt: event.nextAttemptAt }));
    expect(h.ingest).not.toHaveBeenCalled();
    expect(h.logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ eventId: event.id, code: "provider_unavailable", attempt: 1, retryable: true }),
      "email_inbound_fetch_failed",
    );
  });

  it("succeeds on a later attempt with nothing recorded twice", async () => {
    const h = harness();
    const mailbox = h.seedMailbox();
    h.fetchFailures.push(new InboundFetchError(true, "provider_timeout"));
    const first = await h.receive(h.message({ deliveredTo: [h.relayAddressOf(mailbox)] }));

    h.setNow(first.event.nextAttemptAt);
    expect(await h.runEvent(first.event.id)).toBe("processed");

    const deliveries = await h.inbound.listEventDeliveries(first.event.id);
    expect(deliveries).toEqual([expect.objectContaining({ state: "done", mailboxId: mailbox.id })]);
    expect(h.ingest).toHaveBeenCalledOnce();
  });

  it("fails terminally after the last attempt, leaving a failed delivery the operator can retry", async () => {
    const h = harness();
    const mailbox = h.seedMailbox();
    for (let attempt = 0; attempt < 20; attempt += 1) h.fetchFailures.push(new InboundFetchError(true, "provider_unavailable"));
    const first = await h.receive(
      h.message({ deliveredTo: [h.relayAddressOf(mailbox)] }),
      { from: CUSTOMER, to: ["support@customer.test"], cc: [], receivedFor: [h.relayAddressOf(mailbox)], subject: null, rfcMessageId: null },
    );

    let outcome = first.outcome;
    while (outcome === "retrying") {
      h.setNow(h.inbound.events.get(first.event.id)!.nextAttemptAt);
      outcome = await h.runEvent(first.event.id);
    }

    expect(outcome).toBe("failed");
    expect(h.inbound.events.get(first.event.id)).toMatchObject({ state: "failed", lastErrorCode: "provider_unavailable" });
    expect(h.fetchMessage.mock.calls.length).toBeGreaterThan(1);
    expect(await h.inbound.listEventDeliveries(first.event.id)).toEqual([
      expect.objectContaining({ mailboxId: mailbox.id, state: "failed", lastErrorCode: "provider_unavailable" }),
    ]);
    expect(h.logger.warn).toHaveBeenCalledWith(expect.objectContaining({ eventId: first.event.id }), "email_inbound_terminal_failure");
    expect(h.ingest).not.toHaveBeenCalled();
  });

  it("fails at once on a fetch error that is not retryable", async () => {
    const h = harness();
    h.seedMailbox();
    h.fetchFailures.push(new InboundFetchError(false, "message_not_found"));

    const { outcome, event } = await h.receive(h.message());

    expect(outcome).toBe("failed");
    expect(event).toMatchObject({ state: "failed", lastErrorCode: "message_not_found" });
    expect(h.requestDrain).not.toHaveBeenCalled();
  });

  it("ignores events that carry no message without fetching", async () => {
    const h = harness();
    const event = h.inbound.seedEvent({ eventKind: "delivery_status" });

    expect(await h.runEvent(event.id)).toBe("ignored");
    expect(h.inbound.events.get(event.id)?.state).toBe("ignored");
    expect(h.fetchMessage).not.toHaveBeenCalled();
  });
});

describe("EmailInboundProcessor: evidence about sent mail", () => {
  const bounced = { type: "bounced", bounce: { type: "Permanent", subType: "General", statusCode: "5.1.1" } } as const;

  it("routes a provider delivery event to the send it names, by the provider's email id", async () => {
    const h = harness();
    const event = h.inbound.seedEvent({ eventKind: "delivery_status", providerObjectId: "re_sent_1", envelope: { status: bounced } });

    expect(await h.runEvent(event.id)).toBe("processed");

    expect(h.deliveryEvents.applyStatus).toHaveBeenCalledWith({ provider: "local", providerMessageId: "re_sent_1", status: bounced });
    expect(h.inbound.events.get(event.id)?.state).toBe("processed");
    expect(h.fetchMessage).not.toHaveBeenCalled();
  });

  it("settles an event about mail it did not send as ignored", async () => {
    const h = harness();
    h.deliveryEvents.applyStatus.mockResolvedValueOnce("foreign");
    const event = h.inbound.seedEvent({ eventKind: "delivery_status", providerObjectId: "re_transactional", envelope: { status: { type: "delivered", bounce: null } } });

    expect(await h.runEvent(event.id)).toBe("ignored");
  });

  it("does not read bounce detail that is not the provider's sanitized tokens", async () => {
    const h = harness();
    const event = h.inbound.seedEvent({
      eventKind: "delivery_status",
      envelope: { status: { type: "bounced", bounce: { type: "Permanent", subType: null, statusCode: "550 alice@example.test unknown" } } },
    });

    expect(await h.runEvent(event.id)).toBe("ignored");
    expect(h.deliveryEvents.applyStatus).not.toHaveBeenCalled();
  });

  it("retries a delivery event whose send could not be updated", async () => {
    const h = harness();
    h.deliveryEvents.applyStatus.mockRejectedValueOnce(new Error("database unavailable"));
    const event = h.inbound.seedEvent({ eventKind: "delivery_status", envelope: { status: bounced } });

    expect(await h.runEvent(event.id)).toBe("retrying");
    expect(h.requestDrain).toHaveBeenCalledWith(expect.objectContaining({ stage: "inbound", scheduleAt: expect.any(Date) }));
  });

  it("bounces the sends an inbound delivery status report names, and drops the report", async () => {
    const h = harness();
    const mailbox = h.seedMailbox();
    h.threads.index.push({
      workspaceId,
      mailboxId: mailbox.id,
      conversationId: randomUUID(),
      messageId: randomUUID(),
      direction: "outbound",
      origin: "radioso_generated",
      rfcMessageId: "<sent-1@customer.test>",
      subject: "Re: Order 1234",
      ccAddresses: [],
      attachments: [],
      inboundDeliveryId: null,
      sendIntentId: randomUUID(),
    });

    const { deliveries } = await h.receive(h.message({
      from: { address: "mailer-daemon@example.test", displayName: null },
      deliveredTo: [h.relayAddressOf(mailbox)],
      report: { kind: "delivery_status", originalMessageIds: ["<sent-1@customer.test>", "<elsewhere@example.test>"] },
    }));

    expect(h.deliveryEvents.applyDsnBounce).toHaveBeenCalledWith({ mailboxId: mailbox.id, rfcMessageIds: ["<sent-1@customer.test>"] });
    expect(deliveries).toEqual([expect.objectContaining({ classification: "bounce", disposition: "drop" })]);
    expect(h.ingest).not.toHaveBeenCalled();
  });

  it("applies no bounce for a report that names none of the mailbox's sends", async () => {
    const h = harness();
    const mailbox = h.seedMailbox();

    await h.receive(h.message({
      from: { address: "mailer-daemon@example.test", displayName: null },
      deliveredTo: [h.relayAddressOf(mailbox)],
      report: { kind: "delivery_status", originalMessageIds: ["<elsewhere@example.test>"] },
    }));

    expect(h.deliveryEvents.applyDsnBounce).not.toHaveBeenCalled();
  });
});

describe("EmailInboundProcessor: thread protocol", () => {
  it("resolves and reserves, then ingests with the planned ids, then indexes", async () => {
    const h = harness();
    const mailbox = h.seedMailbox();
    h.ingest.mockImplementationOnce(async (input) => {
      const [reserved] = [...h.inbound.deliveries.values()];
      expect(reserved).toMatchObject({
        state: "resolved",
        plannedConversationId: input.conversation.conversationId,
        plannedMessageId: input.message.id,
      });
      h.log.push("ingest");
      return {
        conversationId: input.conversation.conversationId,
        messageId: input.message.id,
        conversationCreated: true,
        messageCreated: true,
        ownership: { state: "human_owned", version: 1 },
      };
    });

    await h.receive(h.message({ deliveredTo: [h.relayAddressOf(mailbox)] }));

    const order = ["lockThread", "reserveThread", "ingest", "recordIngested", "upsertLink", "insertIndexEntries", "settleDelivery:done"];
    expect(h.log.filter((entry) => order.includes(entry))).toEqual(order);
  });

  it("resumes at ingest with the persisted ids after a failure between reserve and ingest", async () => {
    const h = harness();
    const mailbox = h.seedMailbox();
    h.ingestFailures.push(new Error("connection reset"));

    const first = await h.receive(h.message({ deliveredTo: [h.relayAddressOf(mailbox)] }));
    expect(first.outcome).toBe("retrying");
    const [reserved] = await h.inbound.listEventDeliveries(first.event.id);
    expect(reserved.state).toBe("resolved");

    h.setNow(h.inbound.events.get(first.event.id)!.nextAttemptAt);
    expect(await h.runEvent(first.event.id)).toBe("processed");

    const [first_, second] = h.ingest.mock.calls.map(([input]) => input);
    expect(second.conversation.conversationId).toBe(first_.conversation.conversationId);
    expect(second.message.id).toBe(first_.message.id);
    expect(second.conversation.conversationId).toBe(reserved.plannedConversationId);
    expect(h.conversations.size).toBe(1);
    expect((await h.inbound.listEventDeliveries(first.event.id))[0].state).toBe("done");
  });

  it("continues the thread an In-Reply-To names, and indexes the new Message-Id", async () => {
    const h = harness();
    const mailbox = h.seedMailbox();
    const opening = h.message({ deliveredTo: [h.relayAddressOf(mailbox)] });
    const first = await h.receive(opening);

    const reply = h.message({
      deliveredTo: [h.relayAddressOf(mailbox)],
      inReplyTo: opening.rfcMessageId,
      references: [opening.rfcMessageId!],
    });
    const second = await h.receive(reply);

    expect(second.deliveries[0]).toMatchObject({ threadMatch: "in_reply_to", conversationId: first.deliveries[0].conversationId });
    expect(h.conversations.size).toBe(1);
    expect(h.threads.index.map((entry) => entry.rfcMessageId)).toEqual([opening.rfcMessageId, reply.rfcMessageId]);
  });

  it("joins a thread through the plus token when no header matches", async () => {
    const h = harness();
    const mailbox = h.seedMailbox();
    const first = await h.receive(h.message({ deliveredTo: [h.relayAddressOf(mailbox)] }));
    const link = h.threads.links.get(first.deliveries[0].conversationId!)!;

    const second = await h.receive(h.message({
      deliveredTo: [`${mailbox.relayToken}+${link.threadToken.toLowerCase()}@${INBOUND_DOMAIN}`],
    }));

    expect(second.deliveries[0]).toMatchObject({ threadMatch: "thread_token", conversationId: link.conversationId });
  });

  it("records a thread conflict as a channel exception and continues the best match", async () => {
    const h = harness();
    const mailbox = h.seedMailbox();
    const a = h.message({ deliveredTo: [h.relayAddressOf(mailbox)] });
    const b = h.message({ deliveredTo: [h.relayAddressOf(mailbox)] });
    const first = await h.receive(a);
    await h.receive(b);

    const both = await h.receive(h.message({
      deliveredTo: [h.relayAddressOf(mailbox)],
      inReplyTo: a.rfcMessageId,
      references: [b.rfcMessageId!, a.rfcMessageId!],
    }));

    expect(both.deliveries[0]).toMatchObject({ threadConflict: true, conversationId: first.deliveries[0].conversationId });
    expect(h.activity).toEqual([expect.objectContaining({
      conversationId: first.deliveries[0].conversationId,
      kind: "channel_exception",
      detail: { code: "thread_conflict", deliveryId: both.deliveries[0].id },
    })]);
  });

  it("drops automated mail on an existing thread and records a channel exception there", async () => {
    const h = harness();
    const mailbox = h.seedMailbox();
    const opening = h.message({ deliveredTo: [h.relayAddressOf(mailbox)] });
    const first = await h.receive(opening);

    const autoReply = await h.receive(h.message({
      deliveredTo: [h.relayAddressOf(mailbox)],
      inReplyTo: opening.rfcMessageId,
      automation: { autoSubmitted: "auto-replied", precedence: null, autoResponseSuppress: null, listId: null },
    }));

    expect(autoReply.deliveries[0]).toMatchObject({
      state: "done",
      classification: "automated_sender",
      disposition: "drop",
      dispositionReason: "automated_sender",
      conversationId: null,
    });
    expect(h.ingest).toHaveBeenCalledOnce();
    expect(h.activity).toEqual([{
      conversationId: first.deliveries[0].conversationId,
      workspaceId,
      kind: "channel_exception",
      actorUserId: null,
      detail: { code: "automated_sender", deliveryId: autoReply.deliveries[0].id },
    }]);
  });

  it("drops automated first contact without noting any thread", async () => {
    const h = harness();
    const mailbox = h.seedMailbox();

    const { deliveries } = await h.receive(h.message({
      deliveredTo: [h.relayAddressOf(mailbox)],
      automation: { autoSubmitted: null, precedence: "bulk", autoResponseSuppress: null, listId: null },
    }));

    expect(deliveries[0]).toMatchObject({ disposition: "drop", dispositionReason: "automated_sender", threadMatch: null });
    expect(h.activity).toEqual([]);
    expect(h.ingest).not.toHaveBeenCalled();
  });

  it("treats a participant mismatch as an exception and runs no turn", async () => {
    const h = harness();
    const mailbox = h.seedMailbox();
    const opening = h.message({ deliveredTo: [h.relayAddressOf(mailbox)] });
    const first = await h.receive(opening);

    const stranger = await h.receive(h.message({
      from: { address: "mallory@example.test", displayName: null },
      deliveredTo: [h.relayAddressOf(mailbox)],
      inReplyTo: opening.rfcMessageId,
    }));

    expect(stranger.deliveries[0]).toMatchObject({ state: "done", disposition: "drop", dispositionReason: "participant_mismatch" });
    expect(h.ingest).toHaveBeenCalledOnce();
    expect(h.activity).toEqual([expect.objectContaining({
      conversationId: first.deliveries[0].conversationId,
      kind: "channel_exception",
      detail: { code: "participant_mismatch", deliveryId: stranger.deliveries[0].id },
    })]);
  });
});
