import { randomBytes, randomUUID } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import type { ConnectorIngestInput, ConnectorIngestResult, ConnectorRespondInput, ConnectorTurnResult } from "@radioso/connector-api";
import { describe, expect, it, vi } from "vitest";

import { EmailInboundProcessor } from "../../../src/modules/connectors/plugins/email/emailInboundProcessor.js";
import { EmailReviewRunner } from "../../../src/modules/connectors/plugins/email/emailReviewRunner.js";
import type { ConversationActivityEvent } from "../../../src/modules/conversationActivity/contracts/index.js";
import { EventLogReader, type EngagementMode } from "../../../src/modules/emailChannel/public.js";
import { normalizeInboundMime, type InboundEmailMessage } from "../../../src/modules/mail/public.js";
import { InMemoryEmailDomains, InMemoryEmailInbound, InMemoryEmailMailboxes, InMemoryEmailThreads } from "../../support/inMemoryEmailChannel.js";
import { passingReviewChecks } from "../../support/inMemoryEmailReview.js";

// SC-003, the CI gate: every committed `protocol/` fixture, under every verdict a provider adapter
// can attach to it, goes through the inbound processor and then the review runner over in-memory
// tables, on a `draft` mailbox with an agent, where only classification stands between the mail
// and a review turn. None runs a turn, and every one is in the mailbox's event log with the
// verdicts it carried. `auto-submitted-no.eml` is the corpus's control: `Auto-Submitted: no` is a
// person (RFC 3834 §5), so it does reach a review unless its verdict marks it spam, which shows
// the gate can see a turn.

const PROTOCOL_DIR = fileURLToPath(new URL("../../fixtures/email-channel/protocol/", import.meta.url));
/** The workspace, mailbox and relay token the committed fixtures are addressed with. */
const WORKSPACE_ID = "11111111-1111-4111-8111-111111111111";
const AGENT_ID = "44444444-4444-4444-8444-444444444444";
const MAILBOX_ADDRESS = "support@customer.test";
const RELAY_TOKEN = "QZ2K7XN4VTM3RLHJWPC6YGBSFD";
const INBOUND_DOMAIN = "in.relay.test";
/** The Radioso outbound Message-ID `dsn-radioso-id.eml` reports a bounce for. */
const OUTBOUND_ID = "<out-0001@in.relay.test>";
const DRAFTING: readonly EngagementMode[] = ["operator_only", "draft"];
const CONTROL = "auto-submitted-no.eml";

/** Each fixture's classification from its headers alone (research A12). */
const HEADER_CLASSIFICATION: Readonly<Record<string, string>> = {
  "auto-submitted-auto-replied.eml": "automated_sender",
  "auto-submitted-no.eml": "person",
  "dsn-foreign-id.eml": "automated_sender",
  "dsn-radioso-id.eml": "bounce",
  "list-id.eml": "automated_sender",
  "precedence-bulk.eml": "automated_sender",
  "precedence-junk.eml": "automated_sender",
  "precedence-list.eml": "automated_sender",
  "self-sender.eml": "self_sender",
  "x-auto-response-suppress.eml": "automated_sender",
};

type AdapterVerdict = Pick<InboundEmailMessage, "authentication" | "spamVerdict">;

/** What a receiving adapter attaches: a spam verdict, `unknown` included, and authentication results, failures included. */
const ADAPTER_VERDICTS: Readonly<Record<string, AdapterVerdict>> = {
  "no verdict": { spamVerdict: "unknown", authentication: { spf: "unknown", dkim: "unknown", dmarc: "unknown" } },
  "not spam, authenticated": { spamVerdict: "not_spam", authentication: { spf: "pass", dkim: "pass", dmarc: "pass" } },
  "spam": { spamVerdict: "spam", authentication: { spf: "pass", dkim: "pass", dmarc: "pass" } },
  "authentication failed": { spamVerdict: "unknown", authentication: { spf: "fail", dkim: "fail", dmarc: "fail" } },
  "spam, authentication failed": { spamVerdict: "spam", authentication: { spf: "fail", dkim: "fail", dmarc: "fail" } },
};

const FIXTURES = readdirSync(PROTOCOL_DIR).filter((name) => name.endsWith(".eml")).sort();

/** One fixture, under one verdict, through stage 1 and stage 2 on a fresh `draft` mailbox. */
const runThroughChannel = async (fixture: string, verdict: AdapterVerdict) => {
  let now = new Date("2026-10-04T09:00:00.000Z");
  const clock = () => now;
  const domains = new InMemoryEmailDomains(clock);
  const mailboxes = new InMemoryEmailMailboxes(clock);
  const inbound = new InMemoryEmailInbound(clock);
  const threads = new InMemoryEmailThreads([], clock);
  const conversations = new Map<string, { ownership: "ai_owned" | "human_owned"; messageIds: string[] }>();
  const activity: ConversationActivityEvent[] = [];

  const domain = domains.seed({ workspaceId: WORKSPACE_ID, domain: "customer.test" });
  const mailbox = mailboxes.seed({
    workspaceId: WORKSPACE_ID,
    domainId: domain.id,
    address: MAILBOX_ADDRESS,
    relayToken: RELAY_TOKEN,
    engagementMode: "draft",
    agentId: AGENT_ID,
  });
  mailboxes.history.push({
    mailboxId: mailbox.id,
    version: 1,
    engagementMode: "draft",
    enabled: true,
    agentId: AGENT_ID,
    effectiveAt: clock(),
    changedByUserId: null,
  });
  // A thread the mailbox already replied on, so a report naming that reply is a Radioso bounce.
  const existingConversationId = randomUUID();
  conversations.set(existingConversationId, { ownership: "ai_owned", messageIds: [randomUUID()] });
  await threads.upsertLink({
    conversationId: existingConversationId,
    workspaceId: WORKSPACE_ID,
    mailboxId: mailbox.id,
    threadKey: randomUUID(),
    threadToken: "TOKENEXISTINGTHREAD",
    participantAddress: "alice@example.test",
  });
  await threads.insertIndexEntries([{
    workspaceId: WORKSPACE_ID,
    mailboxId: mailbox.id,
    conversationId: existingConversationId,
    messageId: null,
    direction: "outbound",
    origin: "radioso_generated",
    rfcMessageId: OUTBOUND_ID,
    subject: null,
    ccAddresses: [],
    attachments: [],
    inboundDeliveryId: null,
  }]);

  const ingest = vi.fn(async (input: ConnectorIngestInput): Promise<ConnectorIngestResult> => {
    const conversationId = input.conversation.conversationId;
    const existing = conversations.get(conversationId);
    const conversation = existing ?? { ownership: "ai_owned" as const, messageIds: [] };
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
  const respond = vi.fn(async (input: ConnectorRespondInput): Promise<ConnectorTurnResult> => ({
    kind: "draft",
    conversationId: input.conversationId,
    ownershipVersion: 0,
    facts: { outcome: "answered", grounding: "grounded", coverage: "answered", handoff: { requested: false }, suppressedEffects: [], citationCount: 1 },
    draft: { text: "Thanks for writing.", presentation: {} },
  }));
  const drains = { requestDrain: vi.fn(async () => undefined) };
  const logger = { info: vi.fn(), warn: vi.fn() };
  const raw = readFileSync(`${PROTOCOL_DIR}${fixture}`);

  const processor = new EmailInboundProcessor({
    receiver: {
      provider: "local",
      fetchMessage: async () => normalizeInboundMime(raw, { receivedFor: [], ...verdict }),
    },
    inbound,
    mailboxes,
    domains,
    threads,
    receipts: { recordInboundReceipt: async () => undefined },
    deliveryEvents: { applyStatus: vi.fn(async () => "applied" as const), applyDsnBounce: vi.fn(async () => 1) },
    threadProtocol: {
      run: (work) => work({
        lockThread: async () => undefined,
        inbound,
        threads,
        conversations: { ownershipOf: async ({ conversationId }) => conversations.get(conversationId)?.ownership ?? null },
        activity: {
          record: async (event) => {
            activity.push(event);
          },
        },
      }),
    },
    chat: { ingest },
    drains,
    metrics: null,
    logger,
    clock,
    createId: randomUUID,
    randomBytes: (size) => randomBytes(size),
    config: { inboundDomain: INBOUND_DOMAIN, rawMaxBytes: 64 * 1024, supportedModes: DRAFTING, coalesceSeconds: 60 },
  });
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
    handoffs: { requestHumanOwnership: async () => "requested" as const },
    checks: passingReviewChecks(),
    revisions: { run: (work) => work({ threads, inbound, activity: { record: async (event) => void activity.push(event) } }) },
    drains,
    metrics: null,
    logger,
    clock,
    config: { supportedModes: DRAFTING, maxAttempts: 4 },
  });

  const event = inbound.seedEvent({ envelope: { receivedFor: [`${RELAY_TOKEN}@${INBOUND_DOMAIN}`] } });
  const [claimed] = await inbound.claimDueEvents({ limit: 1, leaseSeconds: 300 });
  const outcome = await processor.process(claimed);
  // Past any coalescing window: every review the mail scheduled is due and runs.
  now = new Date(now.getTime() + 60 * 60 * 1000);
  const reviewed = await reviews.runDue({ maxJobs: 10 });
  const [delivery] = await inbound.listEventDeliveries(event.id);
  const eventLog = new EventLogReader({ mailboxes, deliveries: inbound, clock });
  const logged = (await eventLog.list(WORKSPACE_ID, mailbox.id, { limit: 100 })).items;
  return { outcome, delivery, reviewed, respond, logged };
};

const CASES = FIXTURES.flatMap((fixture) => Object.entries(ADAPTER_VERDICTS).map(([verdictName, verdict]) => ({ fixture, verdictName, verdict })));

describe("SC-003: the protocol corpus never runs a turn", () => {
  it("names every fixture in protocol/ with its header classification", () => {
    expect(Object.keys(HEADER_CLASSIFICATION).sort()).toEqual(FIXTURES);
  });

  describe("on a draft mailbox", () => {
    it.each(CASES.filter((entry) => entry.fixture !== CONTROL))(
      "$fixture under $verdictName: no turn, and in the event log with its verdicts",
      async ({ fixture, verdict }) => {
        const run = await runThroughChannel(fixture, verdict);

        expect(run.outcome).toBe("processed");
        expect(run.delivery).toMatchObject({ state: "done", classification: HEADER_CLASSIFICATION[fixture], disposition: "drop" });
        expect(run.reviewed.claimed).toBe(0);
        expect(run.respond).not.toHaveBeenCalled();
        expect(run.logged).toEqual([expect.objectContaining({
          id: run.delivery.id,
          classification: HEADER_CLASSIFICATION[fixture],
          disposition: "drop",
          reason: HEADER_CLASSIFICATION[fixture],
          spamVerdict: verdict.spamVerdict,
          auth: verdict.authentication,
        })]);
      },
    );

    it.each(CASES.filter((entry) => entry.fixture === CONTROL))(
      "control $fixture under $verdictName: a person, reviewed unless the adapter marks it spam",
      async ({ fixture, verdict }) => {
        const run = await runThroughChannel(fixture, verdict);
        const spam = verdict.spamVerdict === "spam";

        expect(run.delivery).toMatchObject({ state: "done", classification: spam ? "spam" : "person" });
        if (!spam) {
          // Authentication results are recorded and never stop a person's mail on their own (FR-015).
          expect(run.delivery).toMatchObject({ disposition: "run_review_turn", dispositionReason: "accepted" });
          expect(run.respond).toHaveBeenCalledOnce();
        } else {
          expect([run.delivery.disposition, run.delivery.dispositionReason]).toEqual(["drop", "spam"]);
          expect(run.respond).not.toHaveBeenCalled();
        }
        expect(run.logged).toEqual([expect.objectContaining({ id: run.delivery.id, spamVerdict: verdict.spamVerdict, auth: verdict.authentication })]);
      },
    );
  });
});
