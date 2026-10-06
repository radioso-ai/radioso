import { describe, expect, it, vi } from "vitest";

import { EmailChannelCopilotView, EventLogReader, type ConversationEmailFacts } from "../../../src/modules/emailChannel/public.js";
import { InMemoryEmailDomains, InMemoryEmailInbound, InMemoryEmailMailboxes } from "../../support/inMemoryEmailChannel.js";

const workspaceId = "11111111-1111-4111-8111-111111111111";
const now = new Date("2026-10-03T12:00:00.000Z");
const relayToken = "RELAYSECRETRELAYSECRETRELA";
const previousToken = "PREVIOUSSECRETPREVIOUSSECR";

const facts: ConversationEmailFacts = {
  mailbox: { id: "m", address: "support@customer.test", displayName: "Support", engagementMode: "operator_only" },
  participant: { address: "person@example.org", displayName: "Pat" },
  latest: { subject: "Order 42", cc: ["cc@example.org"], inboundAt: now.toISOString() },
  sending: { state: "ok" },
  sendBudget: { used: 0, limit: 3, renewedAt: null },
  messages: [{
    messageId: "msg",
    direction: "inbound",
    subject: "Order 42",
    cc: ["cc@example.org"],
    attachments: [{ name: "receipt.pdf", contentType: "application/pdf", sizeBytes: 10 }],
    delivery: null,
    rawDeliveryId: "raw-delivery",
  }],
};

const setup = () => {
  const domains = new InMemoryEmailDomains(() => now);
  const mailboxes = new InMemoryEmailMailboxes(() => now);
  const domain = domains.seed({
    workspaceId,
    domain: "customer.test",
    sendingStatus: "verified",
    dnsRecords: [{ purpose: "dkim", type: "TXT", name: "resend._domainkey.customer.test", value: "p=key", status: "verified" }],
  });
  const mailbox = mailboxes.seed({
    workspaceId,
    domainId: domain.id,
    address: "support@customer.test",
    relayToken,
    previousRelayToken: previousToken,
    previousRelayTokenExpiresAt: now,
    setupCheckStep: "plus_address",
    setupCheckStartedAt: now,
    lastReceivedAt: now,
  });
  const summaryOf = (mailboxId: string, windowHours: number) => ({
    mailboxId,
    window: `${windowHours}h`,
    byDisposition: { drop: 1 },
    failed: 0,
    lastReceivedAt: now.toISOString(),
  });
  const events = {
    summarize: vi.fn(async (_ws: string, mailboxId: string, windowHours: number) => summaryOf(mailboxId, windowHours)),
    summarizeWorkspace: vi.fn(async (_ws: string, windowHours: number) => ({
      window: `${windowHours}h`,
      mailboxes: [summaryOf(mailbox.id, windowHours)],
      noMailbox: { byDisposition: { drop: 2 }, failed: 0 },
      removedMailboxes: { byDisposition: { ingest_only: 1 }, failed: 1 },
    })),
  };
  const view = new EmailChannelCopilotView({
    mailboxes,
    domains,
    events,
    facts: { read: vi.fn(async () => facts) },
    supportedModes: ["operator_only"],
    clock: () => now,
  });
  return { view, mailbox, domain, events };
};

const leaksNoSecret = (value: unknown) => {
  const serialized = JSON.stringify(value).toLowerCase();
  for (const forbidden of [relayToken, previousToken, "relayaddress", "sendto", "threadtoken", "+check", "person@example.org", "cc@example.org", "raw-delivery", "rawdeliveryid"]) {
    expect(serialized).not.toContain(forbidden.toLowerCase());
  }
};

describe("EmailChannelCopilotView", () => {
  it("projects the configuration with explicitly selected fields and no relay address or setup-check recipient", async () => {
    const { view, mailbox, domain } = setup();
    const configuration = await view.configuration(workspaceId);
    expect(configuration).toEqual({
      supportedModes: ["operator_only"],
      defaultMode: "operator_only",
      domains: [{
        id: domain.id,
        domain: "customer.test",
        registrationStatus: "registered",
        sendingStatus: "verified",
        receivingStatus: "not_requested",
        records: [{ purpose: "dkim", type: "TXT", name: "resend._domainkey.customer.test", status: "verified" }],
      }],
      mailboxes: [{
        id: mailbox.id,
        address: "support@customer.test",
        agentId: null,
        engagementMode: "operator_only",
        enabled: true,
        receivingState: "ok",
        lastReceivedAt: now.toISOString(),
        sendingState: "ok",
        threadSendBudget: 3,
        hourlyGenerationBudget: 30,
      }],
    });
    leaksNoSecret(configuration);
  });

  it("summarizes the event log of one mailbox, or of the whole workspace with the mail no active mailbox received", async () => {
    const { view, mailbox, events } = setup();
    expect(await view.eventSummaries(workspaceId, { mailboxId: null, windowHours: 24 })).toEqual({
      summaries: [{ mailboxId: mailbox.id, window: "24h", byDisposition: { drop: 1 }, failed: 0, lastReceivedAt: now.toISOString() }],
      noMailbox: { window: "24h", byDisposition: { drop: 2 }, failed: 0 },
      removedMailboxes: { window: "24h", byDisposition: { ingest_only: 1 }, failed: 1 },
    });
    expect(events.summarizeWorkspace).toHaveBeenCalledExactlyOnceWith(workspaceId, 24);
    expect(events.summarize).not.toHaveBeenCalled();

    expect(await view.eventSummaries(workspaceId, { mailboxId: mailbox.id, windowHours: 1 })).toEqual({
      summaries: [{ mailboxId: mailbox.id, window: "1h", byDisposition: { drop: 1 }, failed: 0, lastReceivedAt: now.toISOString() }],
      noMailbox: null,
      removedMailboxes: null,
    });
    expect(events.summarize).toHaveBeenLastCalledWith(workspaceId, mailbox.id, 1);
  });

  describe("over the workspace's event log", () => {
    const deliveredTo = async (inbound: InMemoryEmailInbound, mailboxId: string | null, settled: boolean) => {
      const event = inbound.seedEvent({ state: "processed" });
      await inbound.insertDelivery({
        inboundEventId: event.id,
        workspaceId,
        mailboxId,
        routeRule: mailboxId === null ? null : "relay",
        acceptedPolicyVersion: mailboxId === null ? null : 1,
        ...(settled ? { settled: { disposition: "drop" as const, dispositionReason: "no_mailbox" } } : {}),
      });
    };

    const workspaceView = () => {
      const mailboxes = new InMemoryEmailMailboxes(() => now);
      const active = mailboxes.seed({ workspaceId, domainId: "d", address: "support@customer.test", lastReceivedAt: now });
      const removed = mailboxes.seed({ workspaceId, domainId: "d", address: "old@customer.test" });
      const inbound = new InMemoryEmailInbound(() => now);
      const view = new EmailChannelCopilotView({
        mailboxes,
        domains: new InMemoryEmailDomains(() => now),
        events: new EventLogReader({ mailboxes, deliveries: inbound, clock: () => now }),
        facts: { read: vi.fn(async () => null) },
        supportedModes: ["operator_only"],
        clock: () => now,
      });
      return { view, mailboxes, inbound, active, removed };
    };

    it("counts mail accepted for an address no mailbox has, which no mailbox summary carries", async () => {
      const { view, inbound, active } = workspaceView();
      await deliveredTo(inbound, active.id, false);
      await deliveredTo(inbound, null, true);
      await deliveredTo(inbound, null, true);

      const { summaries, noMailbox, removedMailboxes } = await view.eventSummaries(workspaceId, { mailboxId: null, windowHours: 24 });

      expect(summaries.find((summary) => summary.mailboxId === active.id)).toMatchObject({ byDisposition: { undecided: 1 }, failed: 0 });
      expect(noMailbox).toEqual({ window: "24h", byDisposition: { drop: 2 }, failed: 0 });
      expect(removedMailboxes).toEqual({ window: "24h", byDisposition: {}, failed: 0 });
    });

    it("keeps counting a removed mailbox's retained events once it no longer has a summary of its own", async () => {
      const { view, mailboxes, inbound, active, removed } = workspaceView();
      await deliveredTo(inbound, removed.id, false);
      await deliveredTo(inbound, removed.id, false);
      await mailboxes.markRemoved(workspaceId, removed.id);

      const { summaries, noMailbox, removedMailboxes } = await view.eventSummaries(workspaceId, { mailboxId: null, windowHours: 24 });

      expect(summaries.map((summary) => summary.mailboxId)).toEqual([active.id]);
      expect(removedMailboxes).toEqual({ window: "24h", byDisposition: { undecided: 2 }, failed: 0 });
      expect(noMailbox).toEqual({ window: "24h", byDisposition: {}, failed: 0 });
    });
  });

  it("projects conversation facts without participant or CC addresses, raw content handles or thread tokens", async () => {
    const { view } = setup();
    const result = await view.conversationFacts(workspaceId, "conversation");
    expect(result).toEqual({
      facts: {
        mailbox: { id: "m", address: "support@customer.test", displayName: "Support", engagementMode: "operator_only" },
        participant: { displayName: "Pat" },
        latest: { subject: "Order 42", ccCount: 1, inboundAt: now.toISOString() },
        sending: { state: "ok" },
        sendBudget: { used: 0, limit: 3, renewedAt: null },
        messages: [{
          messageId: "msg",
          direction: "inbound",
          subject: "Order 42",
          ccCount: 1,
          attachments: [{ name: "receipt.pdf", contentType: "application/pdf", sizeBytes: 10 }],
          hasRaw: true,
        }],
      },
    });
    leaksNoSecret(result);
  });
});
