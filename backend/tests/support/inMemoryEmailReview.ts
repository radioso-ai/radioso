import { randomUUID } from "node:crypto";

import type { ConnectorRespondInput, ConnectorTurnFacts, ConnectorTurnResult } from "@radioso/connector-api";
import { vi } from "vitest";

import type { ConversationRecord } from "../../src/db/repositories/conversationRepository.js";
import { EmailReviewRunner } from "../../src/modules/connectors/plugins/email/emailReviewRunner.js";
import { emailMailboxPolicyRef, type EngagementMode } from "../../src/modules/emailChannel/public.js";
import type { EmailMailboxRecord } from "../../src/modules/emailChannel/persistence/emailMailboxRepository.js";
import {
  heldReplyEventSources,
  heldReplyEventTarget,
  HeldReplyService,
  isHeldReplyAttentionOpen,
  type HeldReplyInsert,
  type HeldReplyReadStore,
  type HeldReplyRecord,
  type HeldReplySupersedeScope,
  type HeldReplyWriteStore,
} from "../../src/modules/handoff/public.js";
import { InMemoryConversationOwnershipRepository } from "./fakes.js";
import { InMemoryEmailDomains, InMemoryEmailMailboxes, InMemoryEmailThreads } from "./inMemoryEmailChannel.js";

type Clock = () => Date;
type ListQuery = Parameters<HeldReplyReadStore["listOpen"]>[1];

const notOnTheReviewPath = (): never => {
  throw new Error("Not on the review path");
};

/**
 * In-memory `held_replies`, with the table's two unique indexes: one live draft per conversation and
 * one held reply per review ref, so a runner that holds without superseding the last draft fails here
 * as it would against Postgres. Only the producer and supersede paths are implemented.
 */
export class InMemoryHeldReplyRows
implements HeldReplyWriteStore, HeldReplyReadStore, Pick<HeldReplySupersedeScope, "supersedePendingForConversation"> {
  readonly rows: HeldReplyRecord[] = [];

  constructor(private readonly customerMessages: Map<string, string[]>, private readonly clock: Clock) {}

  async insert(input: HeldReplyInsert): Promise<{ record: HeldReplyRecord; created: boolean }> {
    const held = input.reviewRef === null
      ? undefined
      : this.rows.find((row) => row.conversationId === input.conversationId && row.reviewRef === input.reviewRef);
    if (held) return { record: held, created: false };
    if (input.born.state === "pending" && this.rows.some((row) => row.conversationId === input.conversationId && isLive(row))) {
      throw new Error("duplicate key value violates unique constraint \"held_replies_live_conversation_uniq\"");
    }
    const born = input.born.state === "superseded"
      ? { ...this.decided(heldReplyEventTarget({ kind: "supersede", reason: input.born.reason })), supersededReason: input.born.reason }
      : { state: "pending" as const, releaseKind: null, attentionClearedAt: null, attentionClearedReason: null, decidedAt: null, supersededReason: null };
    const record: HeldReplyRecord = {
      id: randomUUID(),
      workspaceId: input.workspaceId,
      conversationId: input.conversationId,
      agentId: input.agentId,
      reviewRef: input.reviewRef,
      answersMessageId: input.answersMessageId,
      ownershipVersion: input.ownershipVersion,
      policy: input.policy,
      holdReason: input.holdReason,
      facts: input.facts,
      draft: input.draft,
      editedText: null,
      editorUserId: null,
      releaserUserId: null,
      discardedByUserId: null,
      releasedMessageId: null,
      createdAt: this.clock(),
      ...born,
    };
    this.rows.push(record);
    return { record, created: true };
  }

  async findInConversation(conversationId: string, heldReplyId: string): Promise<HeldReplyRecord | null> {
    return this.rows.find((row) => row.conversationId === conversationId && row.id === heldReplyId) ?? null;
  }

  async latestCustomerMessageId(conversationId: string): Promise<string | null> {
    return this.customerMessages.get(conversationId)?.at(-1) ?? null;
  }

  release = notOnTheReviewPath;
  attachReleasedMessage = notOnTheReviewPath;
  discard = notOnTheReviewPath;

  async findByReviewRef(conversationId: string, reviewRef: string): Promise<HeldReplyRecord | null> {
    return this.rows.find((row) => row.conversationId === conversationId && row.reviewRef === reviewRef) ?? null;
  }

  async current(workspaceId: string, conversationId: string): Promise<HeldReplyRecord | null> {
    return this.rows.filter((row) => row.workspaceId === workspaceId && row.conversationId === conversationId).at(-1) ?? null;
  }

  async listOpen(workspaceId: string, query: ListQuery): Promise<HeldReplyRecord[]> {
    return this.list(workspaceId, query).filter(isHeldReplyAttentionOpen);
  }

  async listAll(workspaceId: string, query: ListQuery): Promise<HeldReplyRecord[]> {
    return this.list(workspaceId, query);
  }

  async supersedePendingForConversation(
    conversationId: string,
    reason: Parameters<HeldReplySupersedeScope["supersedePendingForConversation"]>[1],
  ): Promise<number> {
    let changed = 0;
    for (const [index, row] of this.rows.entries()) {
      if (row.conversationId !== conversationId || !heldReplyEventSources("supersede").includes(row.state)) continue;
      this.rows[index] = { ...row, ...this.decided(heldReplyEventTarget({ kind: "supersede", reason })), supersededReason: reason };
      changed += 1;
    }
    return changed;
  }

  /** The live and decided rows of one conversation, oldest first. */
  of(conversationId: string): HeldReplyRecord[] {
    return this.rows.filter((row) => row.conversationId === conversationId);
  }

  private list(workspaceId: string, query: ListQuery): HeldReplyRecord[] {
    return this.rows
      .filter((row) => row.workspaceId === workspaceId && (query.agentId === undefined || row.agentId === query.agentId))
      .reverse()
      .slice(0, query.limit);
  }

  private decided(target: ReturnType<typeof heldReplyEventTarget>) {
    return {
      state: target.state,
      releaseKind: target.releaseKind,
      attentionClearedAt: target.attentionCleared === null ? null : this.clock(),
      attentionClearedReason: target.attentionCleared,
      decidedAt: this.clock(),
    };
  }
}

const isLive = (row: HeldReplyRecord): boolean => row.state === "pending" || row.state === "queued_auto";

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
  const heldRows = new InMemoryHeldReplyRows(customerMessages, clock);
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
  const heldReplies = new HeldReplyService({
    conversations: { findByIdAndWorkspaceId: async (id, workspaceId) => (conversations.get(id)?.workspaceId === workspaceId ? conversations.get(id)! : null) },
    writes: {
      run: (work) => work({
        conversations: { lockForUpdate: async (id, workspaceId) => conversations.get(id)?.workspaceId === workspaceId },
        ownership,
        channelFor: (policyRef) => (policyRef.startsWith("email_mailbox:")
          ? {
              lockPolicy: async (ref) => {
                const mailbox = [...mailboxes.records.values()].find((candidate) => emailMailboxPolicyRef(candidate.id) === ref);
                return mailbox && mailbox.removedAt === null ? { version: mailbox.policyVersion } : null;
              },
              enqueueRelease: async (heldReply, messageId, onOutbox) => {
                await onOutbox.enqueue({ type: "email.send", payload: { heldReplyId: heldReply.id }, idempotencyKey: `email:send:msg:${messageId}` });
              },
            }
          : null),
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

  const respond = vi.fn<(input: ConnectorRespondInput) => Promise<ConnectorTurnResult>>();
  const requestDrain = vi.fn(async () => undefined);
  const logger = { warn: vi.fn() };
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
    },
    chat: { respond },
    heldReplies: {
      hold: (input) => heldReplies.hold(input),
      findByReviewRef: (conversationId, reviewRef) => heldReplies.findByReviewRef(conversationId, reviewRef),
      supersedePendingForConversation: (conversationId, reason) => heldRows.supersedePendingForConversation(conversationId, reason),
    },
    handoffs: { requestHumanOwnership },
    drains: { requestDrain },
    metrics,
    logger,
    clock,
    config: { supportedModes: options.supportedModes ?? ["operator_only", "draft"], maxAttempts: options.maxAttempts ?? 4 },
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

  /** A customer message lands on the thread: the message row, and a review scheduled as the inbound processor does. */
  const receive = async (conversationId: string, text = "Where is my order?"): Promise<string> => {
    const messageId = randomUUID();
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
    respond,
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
