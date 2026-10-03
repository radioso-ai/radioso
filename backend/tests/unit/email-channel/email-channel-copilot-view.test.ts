import { describe, expect, it, vi } from "vitest";

import { EmailChannelCopilotView, type ConversationEmailFacts } from "../../../src/modules/emailChannel/public.js";
import { InMemoryEmailDomains, InMemoryEmailMailboxes } from "../../support/inMemoryEmailChannel.js";

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
  const events = {
    summarize: vi.fn(async (_ws: string, mailboxId: string, windowHours: number) => ({
      mailboxId,
      window: `${windowHours}h`,
      byDisposition: { drop: 1 },
      failed: 0,
      lastReceivedAt: now.toISOString(),
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

  it("summarizes the event log of one mailbox or of all of them", async () => {
    const { view, mailbox, events } = setup();
    expect(await view.eventSummaries(workspaceId, { mailboxId: null, windowHours: 24 })).toEqual({
      summaries: [{ mailboxId: mailbox.id, window: "24h", byDisposition: { drop: 1 }, failed: 0, lastReceivedAt: now.toISOString() }],
    });
    await view.eventSummaries(workspaceId, { mailboxId: mailbox.id, windowHours: 1 });
    expect(events.summarize).toHaveBeenLastCalledWith(workspaceId, mailbox.id, 1);
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
