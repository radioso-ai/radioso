import { randomUUID } from "node:crypto";

import { vi } from "vitest";

import type { ConversationOwnershipRecord } from "../../src/db/repositories/conversationOwnershipRepository.js";
import type { ConversationRecord } from "../../src/db/repositories/conversationRepository.js";
import type { MessageRecord } from "../../src/db/repositories/messageRepository.js";
import type { ConversationActivityEvent } from "../../src/modules/conversationActivity/contracts/index.js";
import type { CustomerReplyRoute } from "../../src/modules/customerReplyDelivery/public.js";
import {
  heldReplyEventSources,
  heldReplyEventTarget,
  HeldReplyService,
  isHeldReplyAttentionOpen,
  OperatorReplyService,
  type HeldReplyChannelScope,
  type HeldReplyInsert,
  type HeldReplyReadStore,
  type HeldReplyRecord,
  type HeldReplyWriteStore,
} from "../../src/modules/handoff/public.js";
import { AppError } from "../../src/shared/domain/errors.js";

type ListQuery = Parameters<HeldReplyReadStore["listAll"]>[1];

const newestFirst = (left: HeldReplyRecord, right: HeldReplyRecord): number =>
  right.createdAt.getTime() - left.createdAt.getTime() || (right.id < left.id ? -1 : right.id > left.id ? 1 : 0);

/**
 * `held_replies` in memory, with the rules the Postgres repository keeps: a release or a discard
 * applies only from the states the held-reply machine allows (a release only at the bound
 * ownership version), the current held reply is the conversation's newest, and pages run newest
 * first with the agent filter over the held reply's author.
 */
class InMemoryHeldReplyRows implements HeldReplyWriteStore, HeldReplyReadStore {
  readonly rows = new Map<string, HeldReplyRecord>();
  private clock = Date.parse("2026-10-04T10:00:00.000Z");

  seed(input: Partial<HeldReplyRecord> & Pick<HeldReplyRecord, "workspaceId" | "conversationId">): HeldReplyRecord {
    this.clock += 1000;
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
      createdAt: new Date(this.clock),
      ...input,
    };
    this.rows.set(record.id, record);
    return record;
  }

  async insert(input: HeldReplyInsert): Promise<{ record: HeldReplyRecord; created: boolean }> {
    const { born: _born, ...held } = input;
    return { record: this.seed(held), created: true };
  }

  async findInConversation(conversationId: string, id: string): Promise<HeldReplyRecord | null> {
    const row = this.rows.get(id);
    return row?.conversationId === conversationId ? row : null;
  }

  async latestCustomerMessageId(): Promise<string | null> {
    return null;
  }

  async release(input: Parameters<HeldReplyWriteStore["release"]>[0]): Promise<HeldReplyRecord | null> {
    const row = await this.findInConversation(input.conversationId, input.id);
    if (!row || !heldReplyEventSources("release").includes(row.state) || row.ownershipVersion !== input.ownershipVersion) {
      return null;
    }
    const edited = input.editedText !== null;
    const target = heldReplyEventTarget({ kind: "release", edited });
    return this.update(row, {
      state: target.state,
      releaseKind: target.releaseKind,
      editedText: input.editedText,
      editorUserId: edited ? input.userId : null,
      releaserUserId: input.userId,
      attentionClearedAt: new Date(this.clock),
      attentionClearedReason: target.attentionCleared,
      decidedAt: new Date(this.clock),
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
    return this.update(row, { state: "discarded", discardedByUserId: input.userId, decidedAt: new Date(this.clock) });
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

  private page(workspaceId: string, query: ListQuery): HeldReplyRecord[] {
    const { after } = query;
    return [...this.rows.values()].sort(newestFirst).filter((row) => row.workspaceId === workspaceId
      && (query.agentId === undefined || row.agentId === query.agentId)
      && (!after || row.createdAt < after.createdAt || (row.createdAt.getTime() === after.createdAt.getTime() && row.id < after.id)));
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
  const channelScope: HeldReplyChannelScope = {
    lockPolicy: async () => (lockedPolicyVersion === null ? null : { version: lockedPolicyVersion }),
    enqueueRelease: async (heldReply, messageId, onOutbox) => {
      await onOutbox.enqueue({
        type: "email.send",
        payload: { trigger: "held_release", heldReplyId: heldReply.id, messageId },
        idempotencyKey: `email:send:msg:${messageId}`,
      });
    },
  };
  const route: CustomerReplyRoute = {
    enqueue: async (onOutbox, message) => {
      await onOutbox.enqueue({ type: "email.send", payload: { messageId: message.id }, idempotencyKey: `email:send:msg:${message.id}` });
    },
  };
  const customerReplyDelivery = {
    route: vi.fn(async () => {
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

  /** Records an email conversation of the workspace, with its ownership at `ownershipVersion` when given. */
  const seedConversation = (workspaceId: string, ownershipVersion?: number): string => {
    const id = randomUUID();
    conversations.set(id, { id, workspaceId, sourceChannel: "email", channelContext: null } as unknown as ConversationRecord);
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
