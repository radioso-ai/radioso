import { randomUUID } from "node:crypto";

import { vi } from "vitest";

import type { ConversationOwnershipRecord } from "../../src/db/repositories/conversationOwnershipRepository.js";
import type { ConversationRecord } from "../../src/db/repositories/conversationRepository.js";
import type { MessageRecord } from "../../src/db/repositories/messageRepository.js";
import type { ConversationActivityEvent } from "../../src/modules/conversationActivity/contracts/index.js";
import type { CustomerReplyRoute } from "../../src/modules/customerReplyDelivery/public.js";
import { heldReplyEventSources, heldReplyEventTarget, isHeldReplyAttentionOpen } from "../../src/modules/handoff/heldReplies/heldReplyState.js";
import {
  HeldReplyService,
  OperatorReplyService,
  type HeldReplyChannelScope,
  type HeldReplyInsert,
  type HeldReplyReadStore,
  type HeldReplyRecord,
  type HeldReplySupersedeScope,
  type HeldReplyWriteStore,
} from "../../src/modules/handoff/public.js";
import { AppError } from "../../src/shared/domain/errors.js";

type ListQuery = Parameters<HeldReplyReadStore["listAll"]>[1];

const newestFirst = (left: HeldReplyRecord, right: HeldReplyRecord): number =>
  right.createdAt.getTime() - left.createdAt.getTime() || (right.id < left.id ? -1 : right.id > left.id ? 1 : 0);

const isLive = (row: HeldReplyRecord): boolean => row.state === "pending" || row.state === "queued_auto";

/** A clock a second further on at every reading, so rows recorded in turn sort in turn. */
const steppingClock = (): (() => Date) => {
  let at = Date.parse("2026-10-04T10:00:00.000Z");
  return () => {
    at += 1000;
    return new Date(at);
  };
};

/**
 * `held_replies` in memory, with the rules the Postgres repository keeps: the table's two unique
 * indexes (one live draft per conversation, one held reply per review ref), so a producer that
 * holds without superseding the last draft fails here as it would against Postgres; a release, a
 * discard or a materialization applies only from the states the held-reply machine allows (a release
 * only at the bound ownership version); the current held reply is the conversation's newest, and pages run newest
 * first with the agent filter over the held reply's author.
 */
export class InMemoryHeldReplyRows
implements HeldReplyWriteStore, HeldReplyReadStore, Pick<HeldReplySupersedeScope, "supersedePendingForConversation"> {
  /** Every row by id, in the order it was recorded. */
  readonly rows = new Map<string, HeldReplyRecord>();
  private readonly clock: () => Date;
  private readonly customerMessages: ReadonlyMap<string, readonly string[]>;

  constructor(options: {
    /** Stamps creation and decisions; by default a clock that moves a second at every reading. */
    clock?: () => Date;
    /** Customer message ids per conversation, oldest first, read as the latest customer message. */
    customerMessages?: ReadonlyMap<string, readonly string[]>;
  } = {}) {
    this.clock = options.clock ?? steppingClock();
    this.customerMessages = options.customerMessages ?? new Map();
  }

  /** Places a row as it is, bypassing the unique indexes, for a test that needs a held reply in a given state. */
  seed(input: Partial<HeldReplyRecord> & Pick<HeldReplyRecord, "workspaceId" | "conversationId">): HeldReplyRecord {
    const record: HeldReplyRecord = {
      id: randomUUID(),
      agentId: randomUUID(),
      state: "pending",
      releaseKind: null,
      reviewRef: null,
      answersMessageId: randomUUID(),
      ownershipVersion: 0,
      policy: { ref: "email_mailbox:mailbox-1", version: 5 },
      holdReason: "draft_mode",
      facts: {
        outcome: "answered",
        grounding: "grounded",
        coverage: "answered",
        handoff: { requested: false },
        suppressedEffects: [{ skillName: "issue_refund" }],
        citationCount: 1,
      },
      draft: { text: "Your refund was issued on Monday.", presentation: { metadata: { citations: [{ documentId: "doc-1" }] } } },
      editedText: null,
      editorUserId: null,
      releaserUserId: null,
      discardedByUserId: null,
      releasedMessageId: null,
      supersededReason: null,
      attentionClearedAt: null,
      attentionClearedReason: null,
      decidedAt: null,
      createdAt: this.clock(),
      ...input,
    };
    this.rows.set(record.id, record);
    return record;
  }

  async insert(input: HeldReplyInsert): Promise<{ record: HeldReplyRecord; created: boolean }> {
    const held = input.reviewRef === null ? null : await this.findByReviewRef(input.conversationId, input.reviewRef);
    if (held) return { record: held, created: false };
    if (input.born.state !== "superseded" && this.of(input.conversationId).some(isLive)) {
      throw new Error("duplicate key value violates unique constraint \"held_replies_live_conversation_uniq\"");
    }
    const born = input.born.state === "superseded"
      ? { ...this.decided(heldReplyEventTarget({ kind: "supersede", reason: input.born.reason })), supersededReason: input.born.reason }
      : { state: input.born.state, releaseKind: null, attentionClearedAt: null, attentionClearedReason: null, decidedAt: null, supersededReason: null };
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
    this.rows.set(record.id, record);
    return { record, created: true };
  }

  async findById(id: string): Promise<HeldReplyRecord | null> {
    return this.rows.get(id) ?? null;
  }

  async findInConversation(conversationId: string, id: string): Promise<HeldReplyRecord | null> {
    const row = this.rows.get(id);
    return row?.conversationId === conversationId ? row : null;
  }

  async latestCustomerMessageId(conversationId: string): Promise<string | null> {
    return this.customerMessages.get(conversationId)?.at(-1) ?? null;
  }

  async release(input: Parameters<HeldReplyWriteStore["release"]>[0]): Promise<HeldReplyRecord | null> {
    const row = await this.findInConversation(input.conversationId, input.id);
    if (!row || !heldReplyEventSources("release").includes(row.state) || row.ownershipVersion !== input.ownershipVersion) {
      return null;
    }
    const edited = input.editedText !== null;
    const target = heldReplyEventTarget({ kind: "release", edited });
    const at = this.clock();
    return this.update(row, {
      state: target.state,
      releaseKind: target.releaseKind,
      editedText: input.editedText,
      editorUserId: edited ? input.userId : null,
      releaserUserId: input.userId,
      attentionClearedAt: at,
      attentionClearedReason: target.attentionCleared,
      decidedAt: at,
    });
  }

  async attachReleasedMessage(id: string, messageId: string): Promise<HeldReplyRecord> {
    return this.update(this.rows.get(id)!, { releasedMessageId: messageId });
  }

  async discard(input: Parameters<HeldReplyWriteStore["discard"]>[0]): Promise<HeldReplyRecord | null> {
    const row = await this.findInConversation(input.conversationId, input.id);
    if (!row || !heldReplyEventSources("discard").includes(row.state)) {
      return null;
    }
    return this.update(row, { state: "discarded", discardedByUserId: input.userId, decidedAt: this.clock() });
  }

  async materialize(input: Parameters<HeldReplyWriteStore["materialize"]>[0]): Promise<HeldReplyRecord | null> {
    const row = await this.findInConversation(input.conversationId, input.id);
    if (!row || !heldReplyEventSources("materialize").includes(row.state)) {
      return null;
    }
    const target = heldReplyEventTarget({ kind: "materialize", authorized: input.authorized });
    const settled = input.authorized
      ? this.decided(target)
      : { state: target.state, releaseKind: target.releaseKind, attentionClearedAt: null, attentionClearedReason: null };
    return this.update(row, { ...settled, holdReason: target.holdReason ?? row.holdReason });
  }

  async findByReviewRef(conversationId: string, reviewRef: string): Promise<HeldReplyRecord | null> {
    return [...this.rows.values()].find((row) => row.conversationId === conversationId && row.reviewRef === reviewRef) ?? null;
  }

  async current(workspaceId: string, conversationId: string): Promise<HeldReplyRecord | null> {
    return this.page(workspaceId, { agentId: undefined, after: null, limit: Number.MAX_SAFE_INTEGER })
      .find((row) => row.conversationId === conversationId) ?? null;
  }

  async listOpen(workspaceId: string, query: ListQuery): Promise<HeldReplyRecord[]> {
    return this.page(workspaceId, query).filter(isHeldReplyAttentionOpen).slice(0, query.limit);
  }

  async listAll(workspaceId: string, query: ListQuery): Promise<HeldReplyRecord[]> {
    return this.page(workspaceId, query).slice(0, query.limit);
  }

  async supersedePendingForConversation(
    conversationId: string,
    reason: Parameters<HeldReplySupersedeScope["supersedePendingForConversation"]>[1],
  ): Promise<number> {
    const live = this.of(conversationId).filter((row) => heldReplyEventSources("supersede").includes(row.state));
    for (const row of live) {
      this.update(row, { ...this.decided(heldReplyEventTarget({ kind: "supersede", reason })), supersededReason: reason });
    }
    return live.length;
  }

  /** The live and decided rows of one conversation, oldest first. */
  of(conversationId: string): HeldReplyRecord[] {
    return [...this.rows.values()].filter((row) => row.conversationId === conversationId);
  }

  private page(workspaceId: string, query: ListQuery): HeldReplyRecord[] {
    const { after } = query;
    return [...this.rows.values()].sort(newestFirst).filter((row) => row.workspaceId === workspaceId
      && (query.agentId === undefined || row.agentId === query.agentId)
      && (!after || row.createdAt < after.createdAt || (row.createdAt.getTime() === after.createdAt.getTime() && row.id < after.id)));
  }

  private decided(target: ReturnType<typeof heldReplyEventTarget>) {
    const at = this.clock();
    return {
      state: target.state,
      releaseKind: target.releaseKind,
      attentionClearedAt: target.attentionCleared === null ? null : at,
      attentionClearedReason: target.attentionCleared,
      decidedAt: at,
    };
  }

  private update(row: HeldReplyRecord, change: Partial<HeldReplyRecord>): HeldReplyRecord {
    const next = { ...row, ...change };
    this.rows.set(row.id, next);
    return next;
  }
}

/**
 * How the conversation's channel answers a release: it routes the reply, has no route outside the
 * web, or refuses before anything is written because its sending domain is not verified.
 */
type ChannelRoute = "ready" | "none" | "not_verified";

/**
 * A real {@link HeldReplyService} over in-memory held replies, conversations, ownership and an
 * email-shaped channel scope, with the audit, activity and outbox it writes kept for assertions.
 */
export const createInMemoryHeldReplyService = (options: {
  audit: { record: (event: never) => Promise<void> };
  route?: ChannelRoute;
  /** The policy version the channel locks now; null when the channel cannot vouch for the policy. */
  lockedPolicyVersion?: number | null;
  /** Whether the fake channel reserves an automatic send (default yes) and authorizes its dispatch (default yes). */
  autoSend?: { budgetLeft?: boolean; dispatch?: { authorized: true } | { authorized: false; code: string } };
  /** A real channel's scope and reply delivery, in place of the fakes `route` and `lockedPolicyVersion` describe. */
  channel?: {
    scope: HeldReplyChannelScope;
    delivery: { route(conversation: ConversationRecord): Promise<CustomerReplyRoute | null> };
  };
}) => {
  const heldReplies = new InMemoryHeldReplyRows();
  const conversations = new Map<string, ConversationRecord>();
  const ownershipVersions = new Map<string, number>();
  const activities: ConversationActivityEvent[] = [];
  const outbox: { idempotencyKey?: string | null }[] = [];
  const messages: MessageRecord[] = [];
  const lockedPolicyVersion = options.lockedPolicyVersion === undefined ? 5 : options.lockedPolicyVersion;

  const writeMessage = (input: { conversationId: string; workspaceId: string; content: string; source?: MessageRecord["source"] }) => {
    const message: MessageRecord = { id: randomUUID(), role: "assistant", createdAt: new Date(), ...input };
    messages.push(message);
    return message;
  };
  const channelScope: HeldReplyChannelScope = options.channel?.scope ?? {
    lockPolicy: async () => (lockedPolicyVersion === null ? null : { version: lockedPolicyVersion }),
    enqueueRelease: async (heldReply, messageId, onOutbox) => {
      await onOutbox.enqueue({
        type: "email.send",
        payload: { trigger: "held_release", heldReplyId: heldReply.id, messageId },
        idempotencyKey: `email:send:msg:${messageId}`,
      });
    },
    reserveAutoSend: async () => options.autoSend?.budgetLeft ?? true,
    enqueueAutoSend: async (heldReply, onOutbox) => {
      await onOutbox.enqueue({
        type: "email.send",
        payload: { trigger: "auto_reply", heldReplyId: heldReply.id, messageId: null },
        idempotencyKey: `email:send:held:${heldReply.id}`,
      });
    },
    authorizeAutoDispatch: async () => options.autoSend?.dispatch ?? { authorized: true },
    recordMaterialized: async () => undefined,
  };
  const route: CustomerReplyRoute = {
    enqueue: async (onOutbox, message) => {
      await onOutbox.enqueue({ type: "email.send", payload: { messageId: message.id }, idempotencyKey: `email:send:msg:${message.id}` });
    },
  };
  const customerReplyDelivery = {
    route: vi.fn(async (conversation: ConversationRecord) => {
      if (options.channel) return options.channel.delivery.route(conversation);
      if (options.route === "not_verified") {
        throw new AppError(409, "email_sending_not_verified", "The sending domain is not verified.");
      }
      return options.route === "none" ? null : route;
    }),
  };
  const replyScope = {
    messages: {
      create: async (input: { conversationId: string; workspaceId: string; content: string; source?: MessageRecord["source"] }) => writeMessage(input),
    },
    conversations: { touch: async () => undefined },
    outbox: {
      enqueue: async (input: { idempotencyKey?: string | null }) => {
        outbox.push(input);
        return { id: randomUUID(), duplicate: false };
      },
    },
  };
  const audit = options.audit as { record: (event: unknown) => Promise<void> };
  const replies = new OperatorReplyService({
    auditService: audit,
    publicConversationEventBus: { publish: vi.fn() },
    customerReplyDelivery,
  });
  const service = new HeldReplyService({
    conversations: {
      findByIdAndWorkspaceId: async (id: string, workspaceId: string) => {
        const conversation = conversations.get(id);
        return conversation?.workspaceId === workspaceId ? conversation : null;
      },
    },
    writes: {
      run: (work) => work({
        conversations: { lockForUpdate: async (id, workspaceId) => conversations.get(id)?.workspaceId === workspaceId },
        ownership: {
          loadForUpdate: async (id) => {
            const version = ownershipVersions.get(id);
            return version === undefined ? null : ({ conversationId: id, version } as ConversationOwnershipRecord);
          },
        },
        channelFor: (policyRef) => (policyRef.startsWith("email_mailbox:") ? channelScope : null),
        heldReplies,
        reply: replyScope,
        drafts: {
          writeAgentMessage: async (input) => writeMessage({ ...input, content: input.draft.text, source: "ai_agent" }),
        },
        activity: { record: async (event) => { activities.push(event); } },
      }),
    },
    reads: heldReplies,
    operatorIdentities: {
      resolve: async (input) => ({ userId: input.userId, teammateLabel: "Dana Scully", replySignature: "Dana" }),
    },
    customerReplyDelivery,
    replies,
    audit,
  });

  /**
   * Records an email conversation of the workspace, with its ownership at `ownershipVersion` when
   * given, and the channel context a real channel's delivery reads.
   */
  const seedConversation = (workspaceId: string, ownershipVersion?: number, channelContext: ConversationRecord["channelContext"] = null): string => {
    const id = randomUUID();
    conversations.set(id, { id, workspaceId, sourceChannel: "email", channelContext } as unknown as ConversationRecord);
    if (ownershipVersion !== undefined) ownershipVersions.set(id, ownershipVersion);
    return id;
  };

  return {
    service,
    heldReplies,
    seedConversation,
    /** Moves the conversation's ownership on, as a takeover or transfer would. */
    changeOwnership: (conversationId: string, version: number) => ownershipVersions.set(conversationId, version),
    activities,
    outbox,
    messages,
    customerReplyDelivery,
  };
};
