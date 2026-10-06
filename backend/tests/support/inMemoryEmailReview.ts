import { randomUUID } from "node:crypto";

import type { ConnectorRespondInput, ConnectorTurnFacts, ConnectorTurnResult } from "@radioso/connector-api";
import { vi } from "vitest";

import type { ConversationRecord } from "../../src/db/repositories/conversationRepository.js";
import type { ReplyCompletenessResult } from "../../src/modules/connectors/plugins/email/emailReplyCompleteness.js";
import type { ReplyTriageVerdict } from "../../src/modules/connectors/plugins/email/emailReplyTriage.js";
import type { EmailReviewSubject } from "../../src/modules/connectors/plugins/email/emailReviewChecks.js";
import {
  EmailReviewRunner,
  type EmailReviewChecks,
  type EmailReviewRevisionScope,
} from "../../src/modules/connectors/plugins/email/emailReviewRunner.js";
import { EMAIL_MAILBOX_POLICY_REF_PREFIX, EmailHeldReplyChannelScope, type EngagementMode } from "../../src/modules/emailChannel/public.js";
import type { EmailMailboxRecord } from "../../src/modules/emailChannel/persistence/emailMailboxRepository.js";
import { HeldReplyService } from "../../src/modules/handoff/public.js";
import { InMemoryConversationOwnershipRepository } from "./fakes.js";
import { InMemoryEmailDomains, InMemoryEmailMailboxes, InMemoryEmailThreads } from "./inMemoryEmailChannel.js";
import { InMemoryHeldReplyRows } from "./inMemoryHeldReplies.js";

const notOnTheReviewPath = (): never => {
  throw new Error("Not on the review path");
};

const WORKSPACE_ID = "11111111-1111-4111-8111-111111111111";
const AGENT_ID = "44444444-4444-4444-8444-444444444444";

export const REVIEW_PUBLISHABLE_FACTS: ConnectorTurnFacts = {
  outcome: "answered",
  grounding: "grounded",
  coverage: "answered",
  handoff: { requested: false },
  suppressedEffects: [],
  citationCount: 1,
};

/** The review's model checks with no model: every mail needs a reply, and every reply is complete. */
export const passingReviewChecks = (): EmailReviewChecks => ({
  replyTriage: { assess: async () => "yes" },
  replyCompleteness: { assess: async () => ({ completeness: "complete", unansweredAsks: 0 }) },
});

/**
 * Stage 2 of the email channel over in-memory tables: the real review runner and the real held-reply
 * service's producer path, with a stub `respond` the test sets per turn. The conversation's customer
 * messages and its visible history are kept apart, so a test can show a draft never joins history.
 */
export const createEmailReviewHarness = (options: {
  supportedModes?: readonly EngagementMode[];
  maxAttempts?: number;
  sendingStatus?: "pending" | "verified";
} = {}) => {
  let now = new Date("2026-10-04T09:00:00.000Z");
  const clock = () => now;
  const domains = new InMemoryEmailDomains(clock);
  const mailboxes = new InMemoryEmailMailboxes(clock);
  const threads = new InMemoryEmailThreads([], clock);
  const ownership = new InMemoryConversationOwnershipRepository();
  /** Customer message ids per conversation, oldest first. */
  const customerMessages = new Map<string, string[]>();
  /** Every message row, as customer-visible history reads it. */
  const history: { conversationId: string; id: string; role: "user" | "assistant"; content: string }[] = [];
  const heldRows = new InMemoryHeldReplyRows({ clock, customerMessages });
  /** Outbox rows any write on the review path enqueued; a draft must never add one. */
  const outbox: { type: string; idempotencyKey: string | null }[] = [];
  const conversations = new Map<string, ConversationRecord>();
  const handoffs: { conversationId: string; reason: string }[] = [];

  // The outbox every held-reply write would enqueue on. The review path writes no message and
  // queues no send, so it stays empty; anything enqueued on it shows up in a test's assertion.
  const outboxPort = {
    enqueue: async (request: { type: string; idempotencyKey?: string | null }) => {
      outbox.push({ type: request.type, idempotencyKey: request.idempotencyKey ?? null });
      return { id: randomUUID(), duplicate: false };
    },
  };
  // Email's real scope over the in-memory tables, granted automatic sending where the harness runs
  // `auto`, as composition grants it. Dispatch runs in the send handler, never on the review path.
  const supportedModes = options.supportedModes ?? ["operator_only", "draft"];
  const channelScope = new EmailHeldReplyChannelScope({
    mailboxes,
    domains,
    autoSend: supportedModes.includes("auto")
      ? { threads, ownership, intents: { materialize: notOnTheReviewPath }, provider: "resend", createId: randomUUID }
      : undefined,
  });
  const heldReplies = new HeldReplyService({
    conversations: { findByIdAndWorkspaceId: async (id, workspaceId) => (conversations.get(id)?.workspaceId === workspaceId ? conversations.get(id)! : null) },
    writes: {
      run: (work) => work({
        conversations: { lockForUpdate: async (id, workspaceId) => conversations.get(id)?.workspaceId === workspaceId },
        ownership,
        channelFor: (policyRef) => (policyRef.startsWith(EMAIL_MAILBOX_POLICY_REF_PREFIX) ? channelScope : null),
        heldReplies: heldRows,
        reply: { messages: { create: notOnTheReviewPath }, conversations: { touch: notOnTheReviewPath }, outbox: outboxPort },
        drafts: { writeAgentMessage: notOnTheReviewPath },
        activity: { record: async () => undefined },
      }),
    },
    reads: heldRows,
    operatorIdentities: { resolve: notOnTheReviewPath },
    customerReplyDelivery: { route: notOnTheReviewPath },
    replies: { write: notOnTheReviewPath, announce: notOnTheReviewPath },
    audit: { record: vi.fn(async () => undefined) },
  });
  const hold = vi.spyOn(heldReplies, "hold");
  const queueAuto = vi.spyOn(heldReplies, "queueAuto");

  const respond = vi.fn<(input: ConnectorRespondInput) => Promise<ConnectorTurnResult>>();
  // The model checks, stubbed: every mail needs a reply and every reply is complete unless a test says otherwise.
  const replyTriage = vi.fn<(subject: EmailReviewSubject) => Promise<ReplyTriageVerdict>>(async () => "yes");
  const replyCompleteness = vi.fn<(input: EmailReviewSubject & { draft: { text: string } }) => Promise<ReplyCompletenessResult>>(
    async () => ({ completeness: "complete", unansweredAsks: 0 }),
  );
  /** Thread notes a review left: mail it set aside without a turn, named by its message's delivery. */
  const notes: { conversationId: string; deliveryId: string; code: string }[] = [];
  /** The delivery each customer message was ingested from, as the inbound log records it. */
  const deliveryIdOf = (messageId: string): string => `delivery-of-${messageId}`;
  /**
   * The revision's unit of work, as composition binds it to one transaction: a write that throws
   * rolls back the unit's other writes, so a test can stop it between the note and the completion.
   */
  const revisionUnits = { committed: 0, rolledBack: 0 };
  const revisions = {
    run: async <T>(work: (scope: EmailReviewRevisionScope) => Promise<T>): Promise<T> => {
      const linksBefore = new Map([...threads.links].map(([id, link]) => [id, { ...link }]));
      const leasesBefore = new Map(threads.reviewLeases);
      const notesBefore = notes.length;
      try {
        const result = await work({
          threads,
          inbound: { findDeliveryIdForMessage: async (_conversationId, messageId) => deliveryIdOf(messageId) },
          activity: {
            record: async (event) => {
              if (event.kind !== "channel_exception") throw new Error("A review records only its set-aside note");
              notes.push({ conversationId: event.conversationId, deliveryId: event.detail.deliveryId, code: event.detail.code });
            },
          },
        });
        revisionUnits.committed += 1;
        return result;
      } catch (error) {
        threads.links.clear();
        for (const [id, link] of linksBefore) threads.links.set(id, link);
        threads.reviewLeases.clear();
        for (const [id, lease] of leasesBefore) threads.reviewLeases.set(id, lease);
        notes.splice(notesBefore);
        revisionUnits.rolledBack += 1;
        throw error;
      }
    },
  };
  const requestDrain = vi.fn(async () => undefined);
  const logger = { info: vi.fn(), warn: vi.fn() };
  const metrics = { incrementCounter: vi.fn(), observeHistogram: vi.fn() };
  const requestHumanOwnership = vi.fn(async (input: { workspaceId: string; conversationId: string; reason: string }) => {
    handoffs.push({ conversationId: input.conversationId, reason: input.reason });
    await ownership.requestHandoff({ ...input, reason: input.reason });
  });

  const runner = new EmailReviewRunner({
    links: threads,
    mailboxes,
    domains,
    conversations: {
      latestCustomerMessageId: (conversationId) => heldRows.latestCustomerMessageId(conversationId),
      ownershipVersionOf: async (conversationId) => (await ownership.load(conversationId))?.version ?? 0,
      humanOwned: async (conversationId) => (await ownership.load(conversationId))?.state === "human_owned",
    },
    chat: { respond },
    heldReplies: {
      hold: (input) => heldReplies.hold(input),
      queueAuto: (input) => heldReplies.queueAuto(input),
      findByReviewRef: (conversationId, reviewRef) => heldReplies.findByReviewRef(conversationId, reviewRef),
    },
    handoffs: { requestHumanOwnership },
    checks: { replyTriage: { assess: replyTriage }, replyCompleteness: { assess: replyCompleteness } },
    revisions,
    drains: { requestDrain },
    metrics,
    logger,
    clock,
    config: { supportedModes, maxAttempts: options.maxAttempts ?? 4 },
  });

  const domain = domains.seed({ workspaceId: WORKSPACE_ID, domain: "customer.test", sendingStatus: options.sendingStatus ?? "verified" });

  const seedMailbox = (overrides: Partial<EmailMailboxRecord> = {}): EmailMailboxRecord => {
    const mailbox = mailboxes.seed({
      workspaceId: WORKSPACE_ID,
      domainId: domain.id,
      address: "support@customer.test",
      engagementMode: "draft",
      agentId: AGENT_ID,
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

  /**
   * A customer message lands on the thread as the host's ingest and the inbound processor record it:
   * the message row, which supersedes the thread's live draft (`newer_inbound`), and a review scheduled.
   */
  const receive = async (conversationId: string, text = "Where is my order?"): Promise<string> => {
    const messageId = randomUUID();
    if (customerMessages.has(conversationId)) await heldRows.supersedePendingForConversation(conversationId, "newer_inbound");
    customerMessages.set(conversationId, [...(customerMessages.get(conversationId) ?? []), messageId]);
    history.push({ conversationId, id: messageId, role: "user", content: text });
    const mailbox = mailboxOf(conversationId);
    await threads.scheduleReview(conversationId, { dueAt: new Date(now.getTime() + 60_000), policyVersion: mailbox.policyVersion });
    return messageId;
  };

  const mailboxOf = (conversationId: string): EmailMailboxRecord => {
    const link = threads.links.get(conversationId);
    const mailbox = link ? mailboxes.records.get(link.mailboxId) : undefined;
    if (!mailbox) throw new Error("The conversation has no mailbox");
    return mailbox;
  };

  /** An email conversation on `mailbox` with its first customer message, its review due in a minute. */
  const openThread = async (mailbox: EmailMailboxRecord): Promise<{ conversationId: string; messageId: string }> => {
    const conversationId = randomUUID();
    conversations.set(conversationId, { id: conversationId, workspaceId: mailbox.workspaceId } as ConversationRecord);
    await threads.upsertLink({
      conversationId,
      workspaceId: mailbox.workspaceId,
      mailboxId: mailbox.id,
      threadKey: randomUUID(),
      threadToken: `TOKEN${conversationId.slice(0, 8).toUpperCase()}`,
      participantAddress: "pat@example.org",
    });
    const messageId = await receive(conversationId);
    return { conversationId, messageId };
  };

  const draftTurn = (conversationId: string, facts: Partial<ConnectorTurnFacts> = {}, text = "Your order ships on Monday."): ConnectorTurnResult => ({
    kind: "draft",
    conversationId,
    ownershipVersion: 0,
    facts: { ...REVIEW_PUBLISHABLE_FACTS, ...facts },
    draft: { text, presentation: { citations: [{ documentId: "doc-1" }] } },
  });

  return {
    runner,
    heldReplies,
    clock,
    domains,
    domain,
    mailboxes,
    threads,
    ownership,
    heldRows,
    history,
    outbox,
    handoffs,
    hold,
    queueAuto,
    respond,
    replyTriage,
    replyCompleteness,
    notes,
    deliveryIdOf,
    revisionUnits,
    requestHumanOwnership,
    requestDrain,
    logger,
    metrics,
    seedMailbox,
    openThread,
    receive,
    draftTurn,
    counted: (name: string) => metrics.incrementCounter.mock.calls
      .filter(([metric]) => metric === name)
      .map(([, options]) => (options as { labels: Record<string, string> }).labels),
    advance: (ms: number) => {
      now = new Date(now.getTime() + ms);
    },
    /** Runs every review due now. */
    drain: () => runner.runDue({ maxJobs: 10 }),
  };
};

export type EmailReviewHarness = ReturnType<typeof createEmailReviewHarness>;
