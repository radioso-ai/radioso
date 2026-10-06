import { randomBytes, randomUUID } from "node:crypto";

import type { ConnectorIngestInput, ConnectorIngestResult, ConnectorRespondInput, ConnectorTurnResult } from "@radioso/connector-api";
import { describe, expect, it, vi } from "vitest";

import {
  EmailInboundProcessor,
  type EmailThreadProtocolScope,
} from "../../../src/modules/connectors/plugins/email/emailInboundProcessor.js";
import { EmailReviewRunner } from "../../../src/modules/connectors/plugins/email/emailReviewRunner.js";
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
import { passingReviewChecks } from "../../support/inMemoryEmailReview.js";

const INBOUND_DOMAIN = "in.radioso.test";
const workspaceId = "11111111-1111-4111-8111-111111111111";
const agentId = "44444444-4444-4444-8444-444444444444";
const CUSTOMER = "alice@example.test";
const MINUTE_MS = 60_000;
const COALESCE_SECONDS = 60;
const LEASE_SECONDS = 300;

const token = () => generateOpaqueToken((size) => randomBytes(size));

const harness = (options: { supportedModes?: readonly EngagementMode[] } = {}) => {
  let now = new Date("2026-10-03T12:00:00.000Z");
  const clock = () => now;
  const log: string[] = [];
  const domains = new InMemoryEmailDomains(clock);
  const mailboxes = new InMemoryEmailMailboxes(clock);
  const inbound = new InMemoryEmailInbound(clock, log);
  const threads = new InMemoryEmailThreads(log, clock);
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
  const logger = { info: vi.fn(), warn: vi.fn() };
  const metrics = { incrementCounter: vi.fn(), observeHistogram: vi.fn() };
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
    metrics,
    logger,
    clock,
    createId: randomUUID,
    randomBytes: (size) => randomBytes(size),
    config: {
      inboundDomain: INBOUND_DOMAIN,
      rawMaxBytes: 64,
      supportedModes: options.supportedModes ?? ["operator_only"],
      coalesceSeconds: COALESCE_SECONDS,
    },
  });

  // Stage 2 over the same tables, so a test can follow scheduled mail into its review turn.
  const respond = vi.fn(async (input: ConnectorRespondInput): Promise<ConnectorTurnResult> => ({
    kind: "draft",
    conversationId: input.conversationId,
    ownershipVersion: 0,
    facts: { outcome: "answered", grounding: "grounded", coverage: "answered", handoff: { requested: false }, suppressedEffects: [], citationCount: 1 },
    draft: { text: "Your order ships on Monday.", presentation: {} },
  }));
  const reviews = new EmailReviewRunner({
    links: threads,
    mailboxes,
    domains,
    conversations: {
      latestCustomerMessageId: async (conversationId) => conversations.get(conversationId)?.messageIds.at(-1) ?? null,
      ownershipVersionOf: async (conversationId) => (conversations.get(conversationId)?.ownership === "human_owned" ? 1 : 0),
      humanOwned: async (conversationId) => conversations.get(conversationId)?.ownership === "human_owned",
    },
    chat: { respond },
    heldReplies: {
      hold: async () => ({ heldReplyId: randomUUID(), state: "pending", duplicate: false }),
      queueAuto: async () => ({ ok: true, heldReplyId: randomUUID(), duplicate: false }),
      findByReviewRef: async () => null,
    },
    handoffs: { requestHumanOwnership: vi.fn(async () => undefined) },
    checks: passingReviewChecks(),
    revisions: threadProtocol,
    drains: { requestDrain },
    metrics,
    logger,
    clock,
    config: { supportedModes: options.supportedModes ?? ["operator_only"], maxAttempts: 4 },
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
    const claimed = (await inbound.claimDueEvents({ limit: 50, leaseSeconds: LEASE_SECONDS })).find((event) => event.id === eventId);
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

  /**
   * Another worker reclaims the event once its lease runs out, as after this worker stalled, and
   * runs it to the end; returns that worker's outcome.
   */
  const reclaimAndFinish = async (eventId: string) => {
    now = new Date(now.getTime() + (LEASE_SECONDS + 1) * 1000);
    const reclaimed = (await inbound.claimDueEvents({ limit: 50, leaseSeconds: LEASE_SECONDS })).find((event) => event.id === eventId);
    if (!reclaimed) throw new Error("event was not reclaimable");
    return processor.process(reclaimed);
  };

  return {
    processor,
    reclaimAndFinish,
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
    metrics,
    respond,
    reviews,
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

  it("keeps the dropped mail's sender, subject, authentication and bounded raw message on its no_mailbox delivery (FR-015, FR-016)", async () => {
    const h = harness();
    h.seedMailbox();
    const relayAddress = `${token()}@${INBOUND_DOMAIN}`;
    const dropped = h.message({
      from: { address: "Mallory@Example.TEST", displayName: "Mallory" },
      subject: "Invoice question",
      deliveredTo: [relayAddress],
      authentication: { spf: "pass", dkim: "fail", dmarc: "fail" },
      raw: Buffer.alloc(100, "r"),
    });

    const { deliveries } = await h.receive(dropped);

    expect(deliveries).toEqual([expect.objectContaining({
      state: "done",
      dispositionReason: "no_mailbox",
      classification: "person",
      senderAddress: "mallory@example.test",
      senderDisplayName: "Mallory",
      subject: "Invoice question",
      rfcMessageId: dropped.rfcMessageId,
      receivedFor: [relayAddress],
      authResults: { spf: "pass", dkim: "fail", dmarc: "fail" },
      rawSizeBytes: 100,
      rawTruncated: true,
    })]);
    // Bounded by the configured raw size, as a routed delivery's is.
    expect((deliveries[0] as { rawMime: Buffer | null }).rawMime).toHaveLength(64);
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

    const order = ["lockThread", "reserveThread", "ingest", "recordIngested", "markIndexed", "upsertLink", "insertIndexEntries"];
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

describe("EmailInboundProcessor: review scheduling (stage 2)", () => {
  const DRAFTING: readonly EngagementMode[] = ["operator_only", "draft"];

  it("schedules a coalesced review for run_review_turn, bound to the accepted policy, and asks for a drain at its due time", async () => {
    const h = harness({ supportedModes: DRAFTING });
    const mailbox = h.seedMailbox({ engagementMode: "draft", agentId });

    const { deliveries } = await h.receive(h.message({ deliveredTo: [h.relayAddressOf(mailbox)] }));

    expect(deliveries[0]).toMatchObject({ disposition: "run_review_turn", dispositionReason: "accepted", state: "done" });
    expect(h.ingest.mock.calls[0][0]).toMatchObject({ agentId, humanOwnership: null });
    const dueAt = new Date(h.now().getTime() + COALESCE_SECONDS * 1000);
    expect(h.threads.links.get(deliveries[0].conversationId!)).toMatchObject({
      reviewRevision: 1,
      reviewDueAt: dueAt,
      reviewPolicyVersion: deliveries[0].acceptedPolicyVersion,
    });
    expect(h.requestDrain).toHaveBeenCalledWith({ maxJobs: expect.any(Number), stage: "review", scheduleAt: dueAt });
    // Scheduled with the thread's link and index, in the protocol step the delivery's settle acquires first.
    const order = ["markIndexed", "upsertLink", "insertIndexEntries", "scheduleReview"];
    expect(h.log.filter((entry) => order.includes(entry))).toEqual(order);
  });

  it("keeps the earlier due time when more mail arrives inside the window, and bumps the revision", async () => {
    const h = harness({ supportedModes: DRAFTING });
    const mailbox = h.seedMailbox({ engagementMode: "draft", agentId });
    const opening = h.message({ deliveredTo: [h.relayAddressOf(mailbox)] });
    const first = await h.receive(opening);
    const conversationId = first.deliveries[0].conversationId!;
    const firstDue = h.threads.links.get(conversationId)?.reviewDueAt;

    h.advance(20_000);
    await h.receive(h.message({ deliveredTo: [h.relayAddressOf(mailbox)], inReplyTo: opening.rfcMessageId, references: [opening.rfcMessageId!] }));

    expect(h.threads.links.get(conversationId)).toMatchObject({ reviewRevision: 2, reviewDueAt: firstDue });
    expect(h.requestDrain).toHaveBeenLastCalledWith({ maxJobs: expect.any(Number), stage: "review", scheduleAt: firstDue });
  });

  it("runs one review turn over three messages that arrive inside the coalescing window (AS5.6)", async () => {
    const h = harness({ supportedModes: DRAFTING });
    const mailbox = h.seedMailbox({ engagementMode: "draft", agentId });
    const opening = h.message({ deliveredTo: [h.relayAddressOf(mailbox)] });
    const first = await h.receive(opening);
    const conversationId = first.deliveries[0].conversationId!;
    const dueAt = h.threads.links.get(conversationId)!.reviewDueAt!;
    const followUp = () => h.message({ deliveredTo: [h.relayAddressOf(mailbox)], inReplyTo: opening.rfcMessageId, references: [opening.rfcMessageId!] });
    h.advance(20_000);
    const second = await h.receive(followUp());
    h.advance(20_000);
    const third = await h.receive(followUp());

    // One due time: the first message's, which the later two joined.
    expect(h.threads.links.get(conversationId)).toMatchObject({ reviewRevision: 3, reviewDueAt: dueAt });
    expect(h.requestDrain.mock.calls).toEqual(Array.from({ length: 3 }, () => [{ maxJobs: expect.any(Number), stage: "review", scheduleAt: dueAt }]));
    expect(await h.reviews.runDue({ maxJobs: 10 })).toMatchObject({ claimed: 0 });

    h.setNow(dueAt);
    expect(await h.reviews.runDue({ maxJobs: 10 })).toMatchObject({ claimed: 1, held: 1 });

    // One turn, answering the newest message with all three in the conversation it reads.
    expect(h.respond).toHaveBeenCalledOnce();
    expect(h.respond).toHaveBeenCalledWith(expect.objectContaining({
      conversationId,
      respondToMessageId: third.deliveries[0].messageId,
      executionMode: "review",
      historyWindow: { maxMessages: 9 },
    }));
    expect(h.conversations.get(conversationId)?.messageIds).toEqual(
      [first, second, third].map((received) => received.deliveries[0].messageId),
    );
    expect(h.threads.links.get(conversationId)).toMatchObject({ reviewDueAt: null, reviewCompletedRevision: 3 });
    expect(await h.reviews.runDue({ maxJobs: 10 })).toMatchObject({ claimed: 0 });
  });

  it("binds the newest delivery's accepted policy version, not the one in force when it is processed", async () => {
    const h = harness({ supportedModes: DRAFTING });
    const mailbox = h.seedMailbox({ engagementMode: "draft", agentId });
    const providerObjectId = randomUUID();
    h.messages.set(providerObjectId, h.message({ deliveredTo: [h.relayAddressOf(mailbox)] }));
    const event = h.inbound.seedEvent({ providerObjectId });
    h.advance(MINUTE_MS);
    await h.mailboxes.appendPolicyVersion({
      mailboxId: mailbox.id,
      expectedVersion: 1,
      engagementMode: "draft",
      enabled: true,
      agentId,
      changedByUserId: null,
    });

    await h.runEvent(event.id);

    const [delivery] = await h.inbound.listEventDeliveries(event.id);
    expect(h.threads.links.get(delivery.conversationId!)?.reviewPolicyVersion).toBe(1);
  });

  it("schedules nothing for an ingest-only delivery", async () => {
    const h = harness({ supportedModes: DRAFTING });
    const mailbox = h.seedMailbox({ engagementMode: "operator_only", agentId });

    const { deliveries } = await h.receive(h.message({ deliveredTo: [h.relayAddressOf(mailbox)] }));

    expect(h.threads.links.get(deliveries[0].conversationId!)).toMatchObject({ reviewRevision: 0, reviewDueAt: null });
    expect(h.requestDrain).not.toHaveBeenCalledWith(expect.objectContaining({ stage: "review" }));
  });

  it("ingests newer mail on a thread as a new message of its conversation, which supersedes the pending draft (newer_inbound)", async () => {
    const h = harness({ supportedModes: DRAFTING });
    const mailbox = h.seedMailbox({ engagementMode: "draft", agentId });
    const opening = h.message({ deliveredTo: [h.relayAddressOf(mailbox)] });
    const first = await h.receive(opening);

    h.conversations.get(first.deliveries[0].conversationId!)!.ownership = "human_owned";
    await h.receive(h.message({ deliveredTo: [h.relayAddressOf(mailbox)], inReplyTo: opening.rfcMessageId }));

    // The host's ingest supersedes the conversation's pending draft in its own transaction when it
    // records a new message on an existing conversation (ConversationIngestService), whatever the
    // disposition: here a person owns the thread, so no review is scheduled.
    expect(h.ingest.mock.calls[1][0].conversation.conversationId).toBe(first.deliveries[0].conversationId);
    expect(await h.ingest.mock.results[1].value).toMatchObject({ conversationCreated: false, messageCreated: true });
    expect(h.threads.links.get(first.deliveries[0].conversationId!)?.reviewRevision).toBe(1);
  });
});

describe("EmailInboundProcessor: the mailbox generation budget (FR-023)", () => {
  const DRAFTING: readonly EngagementMode[] = ["operator_only", "draft"];
  const budgetHits = (h: ReturnType<typeof harness>) =>
    h.metrics.incrementCounter.mock.calls.filter(([name]) => name === "email_budget_hits_total").map(([, options]) => options.labels);

  it("ingests accepted mail as human-owned generation_budget while the mailbox's window is full, until the window rolls", async () => {
    const h = harness({ supportedModes: DRAFTING });
    const windowStartedAt = new Date(h.now().getTime() - 10 * MINUTE_MS);
    const mailbox = h.seedMailbox({
      engagementMode: "draft",
      agentId,
      hourlyGenerationBudget: 2,
      generationWindowStartedAt: windowStartedAt,
      generationWindowCount: 2,
    });

    const held = await h.receive(h.message({ deliveredTo: [h.relayAddressOf(mailbox)] }));

    expect(held.deliveries[0]).toMatchObject({ state: "done", disposition: "ingest_only", dispositionReason: "generation_budget" });
    expect(h.ingest.mock.calls[0][0]).toMatchObject({ agentId, humanOwnership: { reason: "generation_budget" } });
    expect(h.threads.links.get(held.deliveries[0].conversationId!)).toMatchObject({ reviewRevision: 0, reviewDueAt: null });
    expect(budgetHits(h)).toEqual([{ budget: "mailbox_generation" }]);

    // The window is an hour from its first generation, whatever came after it.
    h.setNow(new Date(windowStartedAt.getTime() + 60 * MINUTE_MS));
    const accepted = await h.receive(h.message({ from: { address: "bob@example.test", displayName: "Bob" }, deliveredTo: [h.relayAddressOf(mailbox)] }));

    expect(accepted.deliveries[0]).toMatchObject({ disposition: "run_review_turn", dispositionReason: "accepted" });
    expect(budgetHits(h)).toHaveLength(1);
  });

  it("accepts mail for a review while the window has room", async () => {
    const h = harness({ supportedModes: DRAFTING });
    const mailbox = h.seedMailbox({
      engagementMode: "draft",
      agentId,
      hourlyGenerationBudget: 2,
      generationWindowStartedAt: new Date(h.now().getTime() - MINUTE_MS),
      generationWindowCount: 1,
    });

    const { deliveries } = await h.receive(h.message({ deliveredTo: [h.relayAddressOf(mailbox)] }));

    expect(deliveries[0]).toMatchObject({ disposition: "run_review_turn", dispositionReason: "accepted" });
    expect(budgetHits(h)).toEqual([]);
  });
});

describe("EmailInboundProcessor: retries resume from the delivery's binding", () => {
  it("resumes a delivery on the mailbox it was bound to after the relay token rotated past its grace", async () => {
    const h = harness();
    const mailbox = h.seedMailbox();
    h.ingestFailures.push(new Error("connection reset"));
    const first = await h.receive(h.message({ deliveredTo: [h.relayAddressOf(mailbox)] }));
    expect(first.outcome).toBe("retrying");
    // The token the mail was addressed to no longer routes anywhere.
    h.mailboxes.records.set(mailbox.id, { ...h.mailboxes.records.get(mailbox.id)!, relayToken: token(), previousRelayToken: null });

    h.setNow(h.inbound.events.get(first.event.id)!.nextAttemptAt);
    expect(await h.runEvent(first.event.id)).toBe("processed");

    expect(await h.inbound.listEventDeliveries(first.event.id)).toEqual([
      expect.objectContaining({ mailboxId: mailbox.id, state: "done", conversationId: first.deliveries[0].plannedConversationId }),
    ]);
    expect(h.conversations.size).toBe(1);
  });

  it("fails a delivery whose mailbox was removed before its retry, visibly, rather than settling the event over it", async () => {
    const h = harness();
    const mailbox = h.seedMailbox();
    h.ingestFailures.push(new Error("connection reset"));
    const first = await h.receive(h.message({ deliveredTo: [h.relayAddressOf(mailbox)] }));
    await h.mailboxes.markRemoved(mailbox.workspaceId, mailbox.id);

    h.setNow(h.inbound.events.get(first.event.id)!.nextAttemptAt);
    expect(await h.runEvent(first.event.id)).toBe("processed");

    expect(await h.inbound.listEventDeliveries(first.event.id)).toEqual([
      expect.objectContaining({ mailboxId: mailbox.id, state: "failed", lastErrorCode: "mailbox_removed" }),
    ]);
    expect(h.ingest).toHaveBeenCalledOnce();
    expect(h.logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ eventId: first.event.id, code: "mailbox_removed" }),
      "email_inbound_delivery_unresumable",
    );
  });
});

describe("EmailInboundProcessor: overlapping workers (research B15)", () => {
  /** Runs `after` once, right after the first call of the inbound repository's `method` returns. */
  const afterFirst = <K extends "recordFetched" | "recordIngested">(
    h: ReturnType<typeof harness>,
    method: K,
    after: () => Promise<unknown>,
  ) => {
    const original = h.inbound[method].bind(h.inbound) as (...args: unknown[]) => Promise<boolean>;
    let fired = false;
    vi.spyOn(h.inbound, method).mockImplementation((async (...args: unknown[]) => {
      const won = await original(...args);
      if (!fired) {
        fired = true;
        await after();
      }
      return won;
    }) as never);
  };

  it("stops a worker whose claim was reclaimed while it held a fetched snapshot: one conversation, one message", async () => {
    const h = harness();
    const mailbox = h.seedMailbox();
    const providerObjectId = randomUUID();
    h.messages.set(providerObjectId, h.message({ deliveredTo: [h.relayAddressOf(mailbox)] }));
    const event = h.inbound.seedEvent({ providerObjectId });
    let reclaimed: string | undefined;
    afterFirst(h, "recordFetched", async () => {
      reclaimed = await h.reclaimAndFinish(event.id);
    });

    const stale = await h.runEvent(event.id);

    expect(reclaimed).toBe("processed");
    expect(stale).toBe("superseded");
    expect(h.ingest).toHaveBeenCalledOnce();
    expect(h.conversations.size).toBe(1);
    expect(await h.inbound.listEventDeliveries(event.id)).toEqual([expect.objectContaining({ state: "done" })]);
    expect(h.inbound.events.get(event.id)).toMatchObject({ state: "processed", attempts: 2 });
    expect(h.logger.warn).toHaveBeenCalledWith({ eventId: event.id, attempt: 1, step: "reserve_thread" }, "email_inbound_claim_lost");
  });

  /** Runs `before` once, right before the processor writes its first delivery of the event. */
  const beforeFirstInsert = (h: ReturnType<typeof harness>, before: () => Promise<unknown>) => {
    const original = h.inbound.insertClaimedDelivery.bind(h.inbound);
    let fired = false;
    vi.spyOn(h.inbound, "insertClaimedDelivery").mockImplementation(async (claim, input) => {
      if (!fired) {
        fired = true;
        await before();
      }
      return original(claim, input);
    });
  };

  it("writes no delivery for a worker whose claim was taken over before its first insert", async () => {
    const h = harness();
    const mailbox = h.seedMailbox();
    const providerObjectId = randomUUID();
    h.messages.set(providerObjectId, h.message({ deliveredTo: [h.relayAddressOf(mailbox)] }));
    const event = h.inbound.seedEvent({ providerObjectId });
    let reclaimed: string | undefined;
    beforeFirstInsert(h, async () => {
      reclaimed = await h.reclaimAndFinish(event.id);
    });

    expect(await h.runEvent(event.id)).toBe("superseded");

    expect(reclaimed).toBe("processed");
    expect(await h.inbound.listEventDeliveries(event.id)).toEqual([expect.objectContaining({ mailboxId: mailbox.id, state: "done" })]);
    expect(h.conversations.size).toBe(1);
    expect(h.inbound.events.get(event.id)).toMatchObject({ state: "processed", attempts: 2 });
    expect(h.logger.warn).toHaveBeenCalledWith({ eventId: event.id, attempt: 1, step: "insert_delivery" }, "email_inbound_claim_lost");
  });

  it("leaves no pending delivery under the settled event when the relay token rotated before its first insert", async () => {
    const h = harness();
    const mailbox = h.seedMailbox();
    const providerObjectId = randomUUID();
    h.messages.set(providerObjectId, h.message({ deliveredTo: [h.relayAddressOf(mailbox)] }));
    const event = h.inbound.seedEvent({ providerObjectId });
    let reclaimed: string | undefined;
    beforeFirstInsert(h, async () => {
      // This worker routed by the old token, then stalled; the token rotates past its grace, and the
      // claim that takes over finds the address routes nowhere and settles the event.
      h.mailboxes.records.set(mailbox.id, { ...h.mailboxes.records.get(mailbox.id)!, relayToken: token(), previousRelayToken: null });
      reclaimed = await h.reclaimAndFinish(event.id);
    });

    expect(await h.runEvent(event.id)).toBe("superseded");

    expect(reclaimed).toBe("processed");
    expect(await h.inbound.listEventDeliveries(event.id)).toEqual([
      expect.objectContaining({ mailboxId: null, state: "done", dispositionReason: "no_mailbox" }),
    ]);
    expect(h.conversations.size).toBe(0);
    expect(h.inbound.events.get(event.id)).toMatchObject({ state: "processed", attempts: 2 });
  });

  it("writes no failed delivery for a worker giving up after its claim was taken over", async () => {
    const h = harness();
    const mailbox = h.seedMailbox();
    const providerObjectId = randomUUID();
    const event = h.inbound.seedEvent({ providerObjectId, envelope: { to: [h.relayAddressOf(mailbox)] } });
    h.fetchFailures.push(new InboundFetchError(false, "message_not_found"));
    let reclaimed: string | undefined;
    beforeFirstInsert(h, async () => {
      h.messages.set(providerObjectId, h.message({ deliveredTo: [h.relayAddressOf(mailbox)] }));
      reclaimed = await h.reclaimAndFinish(event.id);
    });

    expect(await h.runEvent(event.id)).toBe("superseded");

    expect(reclaimed).toBe("processed");
    expect(await h.inbound.listEventDeliveries(event.id)).toEqual([expect.objectContaining({ mailboxId: mailbox.id, state: "done" })]);
    expect(h.inbound.events.get(event.id)).toMatchObject({ state: "processed", attempts: 2 });
    expect(h.logger.warn).toHaveBeenCalledWith({ eventId: event.id, attempt: 1, step: "insert_delivery" }, "email_inbound_claim_lost");
  });

  it("indexes once when two workers hold the same ingested snapshot: the review revision moves once", async () => {
    const h = harness({ supportedModes: ["operator_only", "draft"] });
    const mailbox = h.seedMailbox({ engagementMode: "draft", agentId });
    const providerObjectId = randomUUID();
    h.messages.set(providerObjectId, h.message({ deliveredTo: [h.relayAddressOf(mailbox)] }));
    const event = h.inbound.seedEvent({ providerObjectId });
    afterFirst(h, "recordIngested", () => h.reclaimAndFinish(event.id));

    expect(await h.runEvent(event.id)).toBe("superseded");

    const [delivery] = await h.inbound.listEventDeliveries(event.id);
    expect(delivery.state).toBe("done");
    expect(h.threads.links.get(delivery.conversationId!)).toMatchObject({ reviewRevision: 1 });
    expect(h.log.filter((entry) => entry === "scheduleReview")).toHaveLength(1);
    expect(h.inbound.events.get(event.id)).toMatchObject({ state: "processed", attempts: 2 });
  });
});

describe("EmailInboundProcessor: provider domain events (FR-003)", () => {
  const domainEvent = (h: ReturnType<typeof harness>, providerDomainId: string) =>
    h.inbound.seedEvent({ eventKind: "domain_status", providerObjectId: providerDomainId, envelope: {} });

  it("makes the domain the event names due for its readiness refresh now", async () => {
    const h = harness();
    h.domains.records.set(h.domain.id, { ...h.domain, nextCheckAt: new Date(h.now().getTime() + 24 * 60 * MINUTE_MS) });
    const event = domainEvent(h, h.domain.providerDomainId!);

    expect(await h.runEvent(event.id)).toBe("processed");

    expect(h.domains.records.get(h.domain.id)?.nextCheckAt).toEqual(h.now());
    expect(h.fetchMessage).not.toHaveBeenCalled();
  });

  it("ignores an event about a domain no workspace holds", async () => {
    const h = harness();
    const event = domainEvent(h, "provider-unknown.test");

    expect(await h.runEvent(event.id)).toBe("ignored");
  });

  it("retries an event whose refresh could not be requested", async () => {
    const h = harness();
    vi.spyOn(h.domains, "expediteRefresh").mockRejectedValueOnce(new Error("connection reset"));
    const event = domainEvent(h, h.domain.providerDomainId!);

    expect(await h.runEvent(event.id)).toBe("retrying");
    expect(h.logger.warn).toHaveBeenCalledWith(expect.objectContaining({ eventId: event.id }), "email_domain_status_failed");
  });
});
