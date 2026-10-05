import type { WorkspaceInvalidationKind, WorkspaceInvalidationPublisher } from "@radioso/workspace-invalidation-contract";

import type { ConversationOwnershipRepository } from "../../../db/repositories/conversationOwnershipRepository.js";
import type {
  ConversationRecord,
  ConversationRepository,
  ConversationRepositoryPort,
} from "../../../db/repositories/conversationRepository.js";
import type { MessageRecord } from "../../../db/repositories/messageRepository.js";
import { CursorPaginationError, decodeCursorWithKeys, encodeCursor } from "../../../shared/domain/cursorPagination.js";
import { notFound } from "../../../shared/domain/errors.js";
import type { MetricsRegistry } from "../../../shared/observability/metrics/metricsRegistry.js";
import type { AuditService } from "../../audit/contracts/index.js";
import type { ConversationActivityWriter } from "../../conversationActivity/contracts/index.js";
import type {
  CustomerChannelReplyDeliverer,
  CustomerReplyOutboxPort,
  CustomerReplyRoute,
} from "../../customerReplyDelivery/public.js";
import { notifyAfterCommit, recordCommittedOwnershipAudit, type CommittedAuditReporting } from "../committedOwnershipAudit.js";
import type { OwnershipActor } from "../conversationOwnershipService.js";
import type { OperatorIdentity, OperatorIdentityResolver } from "../operatorIdentity.js";
import type { OperatorReplyService, OperatorReplyWriteScope } from "../operatorReplyService.js";
import {
  autoDispatchRefusal,
  autoSendRefusal,
  heldBirth,
  heldReplyEventSources,
  isHeldReplyAttentionOpen,
  releaseRefusal,
  type AutoSendRefusal,
  type HeldReplyDraft,
  type HeldReplyRecord,
  type HeldReplyReleaseRefusal,
  type HeldReplyState,
  type HeldReplyTurnFacts,
  type SupersedeReason,
} from "./heldReplyState.js";

/** A review's result as its producer hands it over to be held. */
export interface HoldReplyInput {
  workspaceId: string;
  conversationId: string;
  agentId: string | null;
  /** The customer message the review answered. */
  answersMessageId: string;
  /** The conversation's ownership version the review ran at; 0 when it had no ownership row. */
  ownershipVersion: number;
  /** The producer's policy the review ran under, opaque to handoff; null when it binds none. */
  policy: { ref: string; version: number } | null;
  /** The producer's idempotency ref for the review; holding it again finds the first. */
  reviewRef: string | null;
  /** The producer's code for why it is held. */
  holdReason: string;
  facts: HeldReplyTurnFacts;
  draft: HeldReplyDraft;
}

type HoldReplyResult =
  | { heldReplyId: string; state: "pending" | "superseded"; duplicate: false }
  /** The review was held before; its held reply as it is now. */
  | { heldReplyId: string; state: HeldReplyState; duplicate: true };

/** A review's result to publish: as one to hold, without a hold reason, since it waits for no one. */
export type QueueAutoInput = Omit<HoldReplyInput, "holdReason">;

type QueueAutoResult =
  | { ok: true; heldReplyId: string; duplicate: boolean }
  /** Nothing was recorded; the producer holds the result for a teammate instead. */
  | { ok: false; refused: AutoSendRefusal };

/**
 * How a channel's review runner hands its results over: to wait for a teammate, or queued for an
 * automatic send the channel dispatches later.
 */
export interface HeldReplyProducerPort {
  hold(input: HoldReplyInput): Promise<HoldReplyResult>;
  queueAuto(input: QueueAutoInput): Promise<QueueAutoResult>;
  findByReviewRef(conversationId: string, reviewRef: string): Promise<{ heldReplyId: string; state: HeldReplyState } | null>;
}

/** How a channel's send handler turns a queued automatic send into the message it delivers. */
export interface HeldReplyDispatchPort {
  materializeAuto(heldReplyId: string): Promise<
    | { ok: true; messageId: string }
    /** No message was written: the send was no longer queued, or went back to a teammate. */
    | { ok: false; reason: "not_queued" | "returned_to_pending" }
  >;
  /**
   * Returns a queued automatic send whose dispatch was abandoned, its outbox action given up before
   * it materialized, to a teammate as pending; false when it was no longer queued.
   */
  returnAbandonedAuto(heldReplyId: string): Promise<boolean>;
}

/**
 * Supersedes live drafts inside another unit of work's transaction — an ownership change, an
 * operator reply, a customer's newer message, a policy change — so the draft is replaced with the
 * change that replaced it, or not at all. Each returns how many held replies it changed.
 */
export interface HeldReplySupersedeScope {
  supersedePendingForConversation(conversationId: string, reason: Exclude<SupersedeReason, "policy_changed">): Promise<number>;
  supersedePendingForPolicy(policyRef: string, reason: "policy_changed"): Promise<number>;
  /** Closes the attention a discarded draft left open, once a teammate replied or took over. */
  clearDiscardedAttention(conversationId: string, reason: "operator_reply" | "takeover"): Promise<number>;
}

/** What a producing channel is told of a held reply: ids and the authority it was bound to. */
export interface HeldReplyAuthorityView {
  id: string;
  conversationId: string;
  policyRef: string | null;
  policyVersion: number | null;
  ownershipVersion: number;
}

/**
 * The producing channel's side of a held-reply transaction, bound to it by composition and found by
 * the policy ref's prefix, so handoff never names a channel.
 */
export interface HeldReplyChannelScope {
  /**
   * Locks the policy against change until the transaction ends and returns its version; null when
   * the policy no longer exists.
   */
  lockPolicy(policyRef: string): Promise<{ version: number } | null>;
  /**
   * Queues the delivery of the message a release wrote, on the caller's outbox, as the release of
   * this held reply under its bound authority, keyed by the message so it goes out once.
   */
  enqueueRelease(heldReply: HeldReplyAuthorityView, messageId: string, outbox: CustomerReplyOutboxPort): Promise<void>;
  /** Reserves one automatic send against the conversation's send budget; false when the budget is spent. */
  reserveAutoSend(conversationId: string): Promise<boolean>;
  /**
   * Queues the automatic send of a held reply just queued, on the caller's outbox, keyed by the held
   * reply: no message exists until the send is materialized at dispatch.
   */
  enqueueAutoSend(heldReply: HeldReplyAuthorityView, outbox: CustomerReplyOutboxPort): Promise<void>;
  /** Whether the channel can still send automatically under the held reply's bound authority; when not, its code. */
  authorizeAutoDispatch(heldReply: HeldReplyAuthorityView): Promise<{ authorized: true } | { authorized: false; code: string }>;
  /** Records the send of the message a materialization wrote, in the same transaction. */
  recordMaterialized(heldReply: HeldReplyAuthorityView, messageId: string): Promise<void>;
}

/**
 * Writes a released draft as the agent's message, from the presentation its review produced. The
 * presentation is the host's, so handoff hands it over unread.
 */
interface HeldReplyDraftMessageWriter {
  writeAgentMessage(input: {
    workspaceId: string;
    conversationId: string;
    agentId: string | null;
    draft: HeldReplyDraft;
  }): Promise<MessageRecord>;
}

/**
 * A held reply to record: born pending or, once its binding went stale, superseded; or queued for
 * an automatic send.
 */
export interface HeldReplyInsert extends HoldReplyInput {
  born: { state: "pending" } | { state: "superseded"; reason: SupersedeReason } | { state: "queued_auto" };
}

/** The held replies' rows, bound to the transaction of the unit of work that writes them. */
export interface HeldReplyWriteStore extends Pick<HeldReplyReadStore, "findByReviewRef"> {
  /** Records the held reply; with a review ref already held on the conversation, finds that one instead. */
  insert(input: HeldReplyInsert): Promise<{ record: HeldReplyRecord; created: boolean }>;
  findById(heldReplyId: string): Promise<HeldReplyRecord | null>;
  findInConversation(conversationId: string, heldReplyId: string): Promise<HeldReplyRecord | null>;
  /** The id of the conversation's newest customer message; null when it has none. */
  latestCustomerMessageId(conversationId: string): Promise<string | null>;
  /**
   * Releases the draft, edited when `editedText` is set, only while it is pending at
   * `ownershipVersion`; null when a concurrent change got there first.
   */
  release(input: {
    id: string;
    conversationId: string;
    ownershipVersion: number;
    editedText: string | null;
    userId: string;
  }): Promise<HeldReplyRecord | null>;
  /** Names the message a release wrote. */
  attachReleasedMessage(heldReplyId: string, messageId: string): Promise<HeldReplyRecord>;
  /** Discards the draft only while it is pending; null when it is not. */
  discard(input: { id: string; conversationId: string; userId: string }): Promise<HeldReplyRecord | null>;
  /**
   * Settles a queued automatic send only while it is queued: released as automatic when
   * `authorized`, and otherwise back to pending for a teammate; null when it is no longer queued.
   */
  materialize(input: { id: string; conversationId: string; authorized: boolean }): Promise<HeldReplyRecord | null>;
}

/** Where a page of held replies ends: newest first, so the next page holds the ones before it. */
interface HeldReplyPosition {
  createdAt: Date;
  id: string;
}

type HeldReplyListQuery = { agentId: string | undefined; after: HeldReplyPosition | null; limit: number };

export interface HeldReplyReadStore {
  findByReviewRef(conversationId: string, reviewRef: string): Promise<HeldReplyRecord | null>;
  /** The conversation's newest held reply in the workspace, whatever its state. */
  current(workspaceId: string, conversationId: string): Promise<HeldReplyRecord | null>;
  /** Up to `limit` held replies waiting for a teammate, newest first, after `after`; with `agentId`, that agent's. */
  listOpen(workspaceId: string, query: HeldReplyListQuery): Promise<HeldReplyRecord[]>;
  /** As {@link listOpen}, with every other held reply among them. */
  listAll(workspaceId: string, query: HeldReplyListQuery): Promise<HeldReplyRecord[]>;
}

/**
 * One held-reply command's writes, bound to one transaction: the conversation and ownership locks,
 * the producing channel's scope, the held reply, and the message a release writes with its
 * delivery and activity.
 */
export interface HeldReplyWriteScope {
  conversations: Pick<ConversationRepository, "lockForUpdate">;
  ownership: Pick<ConversationOwnershipRepository, "loadForUpdate">;
  /** The producing channel's scope for a policy, found by the ref's prefix; null when no channel claims it. */
  channelFor(policyRef: string): HeldReplyChannelScope | null;
  heldReplies: HeldReplyWriteStore;
  /** A teammate's edit is written as their reply, through the operator-reply write. */
  reply: OperatorReplyWriteScope;
  drafts: HeldReplyDraftMessageWriter;
  activity: ConversationActivityWriter;
}

/** Runs a held-reply command as one unit: everything it writes commits, or none of it does. */
export interface HeldReplyUnitOfWork {
  run<T>(work: (scope: HeldReplyWriteScope) => Promise<T>): Promise<T>;
}

/** A held reply as operator surfaces present it. Operator-only: it carries the draft. */
export interface HeldReplyView {
  id: string;
  conversationId: string;
  agentId: string | null;
  state: HeldReplyState;
  holdReason: string;
  facts: {
    outcome: string;
    grounding: string;
    coverage: string;
    handoff: { requested: boolean; reason: string | null };
  };
  dependsOnSuppressedAction: boolean;
  suppressedEffects: { skillName: string }[];
  draftText: string;
  editedText: string | null;
  /** The customer message the draft answers: its review turn's request message. */
  answersMessageId: string;
  releasedMessageId: string | null;
  createdAt: Date;
  decidedAt: Date | null;
  releaserUserId: string | null;
  editorUserId: string | null;
  discardedByUserId: string | null;
  supersededReason: SupersedeReason | null;
  attentionOpen: boolean;
}

interface HeldReplyPage {
  items: HeldReplyView[];
  /** Pass back to read the next page; null on the last one. */
  nextCursor: string | null;
}

type HeldReplyReleaseResult =
  | { ok: true; heldReply: HeldReplyView; messageId: string }
  | { ok: false; refusal: HeldReplyReleaseRefusal; current: HeldReplyView | null };

type HeldReplyDiscardResult =
  | { ok: true; heldReply: HeldReplyView }
  | { ok: false; refusal: "not_pending"; current: HeldReplyView };

/** How teammates see and decide held replies: the HTTP routes and Ray. */
interface HeldReplyOperatorPort {
  list(actor: OwnershipActor, query: { attention: "open" | "all"; agentId?: string; cursor?: string; limit: number }): Promise<HeldReplyPage>;
  current(actor: OwnershipActor, conversationId: string): Promise<{ heldReply: HeldReplyView | null }>;
  /** An unchanged release with `editedText` null; an edited release with it set. */
  release(actor: OwnershipActor, input: { conversationId: string; heldReplyId: string; editedText: string | null }): Promise<HeldReplyReleaseResult>;
  discard(actor: OwnershipActor, input: { conversationId: string; heldReplyId: string }): Promise<HeldReplyDiscardResult>;
}

type HeldReplyAuditMetadata = Record<string, unknown> & { action: string; conversationId: string; actorUserId: string | null };

const heldReplyNotFound = () => notFound("Held reply not found");

/** A queued send waits for no one; it is given a reason to be held only if it returns to a teammate. */
const QUEUED_AUTO_HOLD_REASON = "queued_auto";
/** Why a queued send returned to a teammate when its dispatch gave up before it materialized. */
const DISPATCH_ABANDONED = "dispatch_abandoned";

type MaterializeOutcome =
  | { kind: "not_queued" }
  | { kind: "returned"; heldReply: HeldReplyRecord; code: string }
  | { kind: "materialized"; heldReply: HeldReplyRecord; messageId: string };

const authorityView = (record: HeldReplyRecord): HeldReplyAuthorityView => ({
  id: record.id,
  conversationId: record.conversationId,
  policyRef: record.policy?.ref ?? null,
  policyVersion: record.policy?.version ?? null,
  ownershipVersion: record.ownershipVersion,
});

const presentHeldReply = (record: HeldReplyRecord): HeldReplyView => ({
  id: record.id,
  conversationId: record.conversationId,
  agentId: record.agentId,
  state: record.state,
  holdReason: record.holdReason,
  facts: {
    outcome: record.facts.outcome,
    grounding: record.facts.grounding,
    coverage: record.facts.coverage,
    handoff: record.facts.handoff.requested
      ? { requested: true, reason: record.facts.handoff.reason }
      : { requested: false, reason: null },
  },
  dependsOnSuppressedAction: record.facts.suppressedEffects.length > 0,
  suppressedEffects: record.facts.suppressedEffects.map((effect) => ({ skillName: effect.skillName })),
  draftText: record.draft.text,
  editedText: record.editedText,
  answersMessageId: record.answersMessageId,
  releasedMessageId: record.releasedMessageId,
  createdAt: record.createdAt,
  decidedAt: record.decidedAt,
  releaserUserId: record.releaserUserId,
  editorUserId: record.editorUserId,
  discardedByUserId: record.discardedByUserId,
  supersededReason: record.supersededReason,
  attentionOpen: isHeldReplyAttentionOpen(record),
});

const CURSOR_KEYS = ["createdAt", "id"] as const;

const encodePosition = (record: HeldReplyView): string =>
  encodeCursor({ createdAt: record.createdAt.toISOString(), id: record.id });

const decodePosition = (cursor: string): HeldReplyPosition => {
  const { keys } = decodeCursorWithKeys(cursor, CURSOR_KEYS);
  const createdAt = new Date(keys.createdAt);
  if (Number.isNaN(createdAt.getTime())) {
    throw new CursorPaginationError("Invalid cursor");
  }
  return { createdAt, id: keys.id };
};

/**
 * Replies an agent produced in review that wait for a teammate, channel-neutral. A channel's review
 * runner holds them, bound to the policy, ownership and customer message the review ran under;
 * teammates release one unchanged as the agent's message, release their edit as their own message
 * with the original kept, or discard it. A release never changes who owns the conversation, and
 * goes ahead only while the draft is pending and its ownership and policy are still current, under
 * the conversation, ownership and policy locks, so concurrent releases send it once.
 */
export class HeldReplyService implements HeldReplyProducerPort, HeldReplyDispatchPort, HeldReplyOperatorPort {
  constructor(private readonly deps: {
    conversations: Pick<ConversationRepositoryPort, "findByIdAndWorkspaceId">;
    writes: HeldReplyUnitOfWork;
    reads: HeldReplyReadStore;
    operatorIdentities: Pick<OperatorIdentityResolver, "resolve">;
    customerReplyDelivery: Pick<CustomerChannelReplyDeliverer, "route">;
    replies: Pick<OperatorReplyService, "write" | "announce">;
    audit: Pick<AuditService, "record">;
    publisher?: WorkspaceInvalidationPublisher;
    metrics?: Pick<MetricsRegistry, "incrementCounter"> | null;
  } & CommittedAuditReporting) {}

  /**
   * Holds a review's result. Under the conversation, ownership and policy locks it is born pending
   * while it still answers the newest customer message at the ownership and policy the review ran
   * under, and superseded otherwise, so a newer review runs. Holding a review ref again finds the
   * first held reply and changes nothing.
   */
  async hold(input: HoldReplyInput): Promise<HoldReplyResult> {
    const outcome = await this.deps.writes.run(async (scope) => {
      if (!(await scope.conversations.lockForUpdate(input.conversationId, input.workspaceId))) {
        throw notFound("Conversation not found");
      }
      const ownership = await scope.ownership.loadForUpdate(input.conversationId);
      const policy = input.policy
        ? { bound: input.policy.version, current: await this.lockedPolicyVersion(scope, input.policy.ref) }
        : null;
      const latestCustomerMessageId = await scope.heldReplies.latestCustomerMessageId(input.conversationId);
      const born = heldBirth({
        ownership: { bound: input.ownershipVersion, current: ownership?.version ?? 0 },
        policy,
        answersLatestCustomerMessage: latestCustomerMessageId === input.answersMessageId,
      });
      return scope.heldReplies.insert({ ...input, born });
    });
    const { record } = outcome;
    if (!outcome.created) {
      return { heldReplyId: record.id, state: record.state, duplicate: true };
    }
    if (record.state === "pending") {
      this.notifyDashboard(record, null, "hitl.decision_created");
      this.countTransition("created");
      await this.recordAudit(record, null, {
        action: "created",
        actorUserId: null,
        heldReplyId: record.id,
        conversationId: record.conversationId,
        holdReason: record.holdReason,
        grounding: record.facts.grounding,
        coverage: record.facts.coverage,
        handoffRequested: record.facts.handoff.requested,
      });
      return { heldReplyId: record.id, state: "pending", duplicate: false };
    }
    this.countTransition("superseded");
    await this.recordAudit(record, null, {
      action: "superseded",
      actorUserId: null,
      heldReplyId: record.id,
      conversationId: record.conversationId,
      reason: record.supersededReason,
    });
    return { heldReplyId: record.id, state: "superseded", duplicate: false };
  }

  /**
   * Queues a review's result for an automatic send (research B9). Under the conversation, ownership
   * and policy locks it is queued only while it answers the newest customer message at the bound
   * ownership and policy, and the channel reserves a send; the channel enqueues the send in the same
   * transaction, and no message is written until it is materialized at dispatch. A refusal records
   * nothing. Queueing a review ref again finds the first held reply, whatever its state, and changes
   * nothing.
   */
  async queueAuto(input: QueueAutoInput): Promise<QueueAutoResult> {
    const outcome = await this.deps.writes.run(async (scope): Promise<QueueAutoResult> => {
      if (!(await scope.conversations.lockForUpdate(input.conversationId, input.workspaceId))) {
        throw notFound("Conversation not found");
      }
      const ownership = await scope.ownership.loadForUpdate(input.conversationId);
      const held = input.reviewRef === null ? null : await scope.heldReplies.findByReviewRef(input.conversationId, input.reviewRef);
      if (held) {
        return { ok: true, heldReplyId: held.id, duplicate: true };
      }
      const channel = input.policy ? scope.channelFor(input.policy.ref) : null;
      const refused = autoSendRefusal({
        ownership: { bound: input.ownershipVersion, current: ownership?.version ?? 0 },
        policy: input.policy && channel
          ? { bound: input.policy.version, current: (await channel.lockPolicy(input.policy.ref))?.version ?? null }
          : null,
        answersLatestCustomerMessage: (await scope.heldReplies.latestCustomerMessageId(input.conversationId)) === input.answersMessageId,
      });
      // No channel means no policy vouched for, which the refusal already names.
      if (refused || !channel) {
        return { ok: false, refused: refused ?? "policy_changed" };
      }
      if (!(await channel.reserveAutoSend(input.conversationId))) {
        return { ok: false, refused: "send_budget" };
      }
      const { record, created } = await scope.heldReplies.insert({
        ...input,
        holdReason: QUEUED_AUTO_HOLD_REASON,
        born: { state: "queued_auto" },
      });
      if (created) {
        await channel.enqueueAutoSend(authorityView(record), scope.reply.outbox);
      }
      return { ok: true, heldReplyId: record.id, duplicate: !created };
    });
    if (outcome.ok && !outcome.duplicate) {
      this.countTransition("queued_auto");
    }
    return outcome;
  }

  /**
   * Turns a queued automatic send into the agent's message (research B9). Under the conversation,
   * ownership and policy locks, only while it is still queued, it re-authorizes the send — the
   * bound ownership and policy still current, and the channel still able to send automatically —
   * and then writes the message from the draft's presentation, releases the held reply as
   * automatic, and has the channel record the send, together. A send no longer authorized goes back
   * to a teammate as pending, with no message; one superseded while queued changes nothing.
   */
  async materializeAuto(heldReplyId: string): Promise<{ ok: true; messageId: string } | { ok: false; reason: "not_queued" | "returned_to_pending" }> {
    const outcome = await this.deps.writes.run(async (scope): Promise<MaterializeOutcome> => {
      const found = await scope.heldReplies.findById(heldReplyId);
      // Lock order: the conversation row, then its ownership row, then the producing channel's policy.
      if (!found || !(await scope.conversations.lockForUpdate(found.conversationId, found.workspaceId))) {
        return { kind: "not_queued" };
      }
      const ownership = await scope.ownership.loadForUpdate(found.conversationId);
      // Read again under the locks: a supersede that committed meanwhile leaves nothing to send.
      const heldReply = await scope.heldReplies.findInConversation(found.conversationId, found.id);
      if (!heldReply || !heldReplyEventSources("materialize").includes(heldReply.state)) {
        return { kind: "not_queued" };
      }
      const verdict = await this.autoDispatchVerdict(scope, heldReply, ownership?.version ?? 0);
      // Conditional on the state: a policy change can supersede it while the policy lock waits.
      const settled = await scope.heldReplies.materialize({
        id: heldReply.id,
        conversationId: heldReply.conversationId,
        authorized: verdict.authorized,
      });
      if (!settled) {
        return { kind: "not_queued" };
      }
      if (!verdict.authorized) {
        return { kind: "returned", heldReply: settled, code: verdict.code };
      }
      const message = await this.writeDraft(scope, settled, null);
      await verdict.channel.recordMaterialized(authorityView(settled), message.id);
      const linked = await scope.heldReplies.attachReleasedMessage(settled.id, message.id);
      return { kind: "materialized", heldReply: linked, messageId: message.id };
    });

    if (outcome.kind === "not_queued") {
      return { ok: false, reason: "not_queued" };
    }
    const { heldReply } = outcome;
    if (outcome.kind === "returned") {
      await this.announceReturned(heldReply, outcome.code);
      return { ok: false, reason: "returned_to_pending" };
    }
    this.notifyDashboard(heldReply, null, "conversation.turn_committed");
    this.countTransition("auto_released");
    await this.recordAudit(heldReply, null, {
      action: "auto_released",
      actorUserId: null,
      heldReplyId: heldReply.id,
      conversationId: heldReply.conversationId,
      messageId: outcome.messageId,
    });
    return { ok: true, messageId: outcome.messageId };
  }

  /**
   * Returns a queued automatic send whose outbox action gave up before it materialized to a
   * teammate (research B9). Under the conversation and ownership locks, only while it is still
   * queued, it goes back to pending as a send whose authority changed, with no message; it is not
   * authorized again, since nothing is left to send it.
   */
  async returnAbandonedAuto(heldReplyId: string): Promise<boolean> {
    const returned = await this.deps.writes.run(async (scope) => {
      const found = await scope.heldReplies.findById(heldReplyId);
      // The materialization's lock order, so a supersede or a late dispatch serializes with it.
      if (!found || !(await scope.conversations.lockForUpdate(found.conversationId, found.workspaceId))) {
        return null;
      }
      await scope.ownership.loadForUpdate(found.conversationId);
      return scope.heldReplies.materialize({ id: found.id, conversationId: found.conversationId, authorized: false });
    });
    if (!returned) {
      return false;
    }
    await this.announceReturned(returned, DISPATCH_ABANDONED);
    return true;
  }

  async findByReviewRef(conversationId: string, reviewRef: string): Promise<{ heldReplyId: string; state: HeldReplyState } | null> {
    const record = await this.deps.reads.findByReviewRef(conversationId, reviewRef);
    return record ? { heldReplyId: record.id, state: record.state } : null;
  }

  /** The workspace's held replies, newest first: those waiting for a teammate, or with `attention: "all"` every one. */
  async list(
    actor: OwnershipActor,
    query: { attention: "open" | "all"; agentId?: string; cursor?: string; limit: number },
  ): Promise<HeldReplyPage> {
    const after = query.cursor === undefined ? null : decodePosition(query.cursor);
    // One past the page tells whether another follows.
    const page = { agentId: query.agentId, after, limit: query.limit + 1 };
    const rows = query.attention === "all"
      ? await this.deps.reads.listAll(actor.workspaceId, page)
      : await this.deps.reads.listOpen(actor.workspaceId, page);
    const items = rows.slice(0, query.limit).map(presentHeldReply);
    const last = items.at(-1);
    return { items, nextCursor: rows.length > query.limit && last ? encodePosition(last) : null };
  }

  /** The conversation's current held reply: its newest, whatever its state; null when it has none. */
  async current(actor: OwnershipActor, conversationId: string): Promise<{ heldReply: HeldReplyView | null }> {
    await this.requireConversation(actor, conversationId);
    const record = await this.deps.reads.current(actor.workspaceId, conversationId);
    return { heldReply: record ? presentHeldReply(record) : null };
  }

  /**
   * Sends a pending draft to the customer: unchanged as the agent's message, written from the
   * draft's presentation, or the teammate's edit as their own message with the draft kept. The
   * release, the message and its delivery commit together under the conversation, ownership and
   * policy locks, without changing who owns the conversation.
   */
  async release(
    actor: OwnershipActor,
    input: { conversationId: string; heldReplyId: string; editedText: string | null },
  ): Promise<HeldReplyReleaseResult> {
    const [conversation, operator] = await Promise.all([
      this.requireConversation(actor, input.conversationId),
      this.deps.operatorIdentities.resolve({ accountId: actor.accountId, userId: actor.userId }),
    ]);
    // Resolved before the transaction opens: it can call the channel's provider, which must not
    // hold the transaction's locks. A channel that cannot send yet refuses here, before any write.
    const channel = await this.deps.customerReplyDelivery.route(conversation);

    const outcome = await this.deps.writes.run(async (scope): Promise<
      | { ok: true; heldReply: HeldReplyRecord; message: MessageRecord }
      | { ok: false; refusal: HeldReplyReleaseRefusal; current: HeldReplyRecord }
    > => {
      // Lock order: the conversation row, then its ownership row — the order an operator reply
      // takes them — then the producing channel's policy.
      if (!(await scope.conversations.lockForUpdate(conversation.id, conversation.workspaceId))) {
        throw notFound("Conversation not found");
      }
      const ownership = await scope.ownership.loadForUpdate(conversation.id);
      const heldReply = await scope.heldReplies.findInConversation(conversation.id, input.heldReplyId);
      if (!heldReply) {
        throw heldReplyNotFound();
      }
      const ownershipVersion = ownership?.version ?? 0;
      const refusal = releaseRefusal({
        state: heldReply.state,
        ownership: { bound: heldReply.ownershipVersion, current: ownershipVersion },
        policy: heldReply.policy
          ? { bound: heldReply.policy.version, current: await this.lockedPolicyVersion(scope, heldReply.policy.ref) }
          : null,
        routed: channel !== null,
      });
      if (refusal) {
        // Read again: the policy lock can wait out a change that superseded the draft meanwhile.
        const current = await scope.heldReplies.findInConversation(conversation.id, heldReply.id);
        return { ok: false, refusal, current: current ?? heldReply };
      }
      const released = await scope.heldReplies.release({
        id: heldReply.id,
        conversationId: conversation.id,
        ownershipVersion,
        editedText: input.editedText,
        userId: actor.userId,
      });
      if (!released) {
        const current = await scope.heldReplies.findInConversation(conversation.id, heldReply.id);
        return { ok: false, refusal: "not_pending", current: current ?? heldReply };
      }
      // A draft a channel produced goes out as that channel's release of it; one no channel bound
      // goes the way any reply on the conversation does.
      const producer = released.policy ? scope.channelFor(released.policy.ref) : null;
      const route = producer ? null : channel;
      const message = input.editedText === null
        ? await this.writeDraft(scope, released, route)
        : await this.deps.replies.write(scope.reply, { ...this.operatorReply(actor, conversation, operator, input.editedText), channel: route });
      await producer?.enqueueRelease(authorityView(released), message.id, scope.reply.outbox);
      const linked = await scope.heldReplies.attachReleasedMessage(released.id, message.id);
      await scope.activity.record({
        kind: "held_reply_released",
        conversationId: conversation.id,
        workspaceId: conversation.workspaceId,
        actorUserId: actor.userId,
        detail: { heldReplyId: released.id, messageId: message.id, edited: input.editedText !== null },
      });
      return { ok: true, heldReply: linked, message };
    });
    if (!outcome.ok) {
      return { ok: false, refusal: outcome.refusal, current: presentHeldReply(outcome.current) };
    }

    // Committed. The visitor and the dashboard hear first; the audit only records what happened.
    const { heldReply, message } = outcome;
    this.deps.replies.announce(this.operatorReply(actor, conversation, operator, message.content), message);
    this.notifyDashboard(heldReply, actor, "hitl.decision_resolved");
    const edited = heldReply.state === "edited";
    this.countTransition(edited ? "edited" : "released");
    await this.recordAudit(heldReply, actor, edited
      ? {
          action: "edited_released",
          actorUserId: actor.userId,
          heldReplyId: heldReply.id,
          conversationId: heldReply.conversationId,
          editorUserId: heldReply.editorUserId,
          releaserUserId: heldReply.releaserUserId,
          messageId: message.id,
        }
      : {
          action: "released",
          actorUserId: actor.userId,
          heldReplyId: heldReply.id,
          conversationId: heldReply.conversationId,
          releaserUserId: heldReply.releaserUserId,
          messageId: message.id,
        });
    return { ok: true, heldReply: presentHeldReply(heldReply), messageId: message.id };
  }

  /**
   * Sets a pending draft aside. The conversation keeps waiting for a teammate until one replies or
   * takes it over; the customer hears nothing.
   */
  async discard(actor: OwnershipActor, input: { conversationId: string; heldReplyId: string }): Promise<HeldReplyDiscardResult> {
    await this.requireConversation(actor, input.conversationId);
    const outcome = await this.deps.writes.run(async (scope): Promise<
      { ok: true; heldReply: HeldReplyRecord } | { ok: false; current: HeldReplyRecord }
    > => {
      const discarded = await scope.heldReplies.discard({
        id: input.heldReplyId,
        conversationId: input.conversationId,
        userId: actor.userId,
      });
      if (!discarded) {
        const current = await scope.heldReplies.findInConversation(input.conversationId, input.heldReplyId);
        if (!current) {
          throw heldReplyNotFound();
        }
        return { ok: false, current };
      }
      await scope.activity.record({
        kind: "held_reply_discarded",
        conversationId: discarded.conversationId,
        workspaceId: discarded.workspaceId,
        actorUserId: actor.userId,
        detail: { heldReplyId: discarded.id },
      });
      return { ok: true, heldReply: discarded };
    });
    if (!outcome.ok) {
      return { ok: false, refusal: "not_pending", current: presentHeldReply(outcome.current) };
    }
    const { heldReply } = outcome;
    this.notifyDashboard(heldReply, actor, "hitl.decision_resolved");
    this.countTransition("discarded");
    await this.recordAudit(heldReply, actor, {
      action: "discarded",
      actorUserId: actor.userId,
      heldReplyId: heldReply.id,
      conversationId: heldReply.conversationId,
      userId: actor.userId,
    });
    return { ok: true, heldReply: presentHeldReply(heldReply) };
  }

  /**
   * Whether a queued send may still go out: its bound ownership and policy current — the policy
   * locked by its channel — and then the channel's own verdict. With the code why not when it may not.
   */
  private async autoDispatchVerdict(
    scope: HeldReplyWriteScope,
    heldReply: HeldReplyRecord,
    ownershipVersion: number,
  ): Promise<{ authorized: true; channel: HeldReplyChannelScope } | { authorized: false; code: string }> {
    const channel = heldReply.policy ? scope.channelFor(heldReply.policy.ref) : null;
    const refusal = autoDispatchRefusal({
      ownership: { bound: heldReply.ownershipVersion, current: ownershipVersion },
      policy: heldReply.policy && channel
        ? { bound: heldReply.policy.version, current: (await channel.lockPolicy(heldReply.policy.ref))?.version ?? null }
        : null,
    });
    if (refusal || !channel) {
      return { authorized: false, code: refusal ?? "policy_changed" };
    }
    const verdict = await channel.authorizeAutoDispatch(authorityView(heldReply));
    return verdict.authorized ? { authorized: true, channel } : verdict;
  }

  /** The policy's version as its channel locked it; null when no channel claims the policy or it is gone. */
  private async lockedPolicyVersion(scope: HeldReplyWriteScope, policyRef: string): Promise<number | null> {
    const channel = scope.channelFor(policyRef);
    return channel ? ((await channel.lockPolicy(policyRef))?.version ?? null) : null;
  }

  /** Writes the unchanged draft as the agent's message, dates the conversation, and queues it on `route`. */
  private async writeDraft(
    scope: HeldReplyWriteScope,
    heldReply: HeldReplyRecord,
    route: CustomerReplyRoute | null,
  ): Promise<MessageRecord> {
    const message = await scope.drafts.writeAgentMessage({
      workspaceId: heldReply.workspaceId,
      conversationId: heldReply.conversationId,
      agentId: heldReply.agentId,
      draft: heldReply.draft,
    });
    await scope.reply.conversations.touch(heldReply.conversationId, heldReply.workspaceId);
    await route?.enqueue(scope.reply.outbox, { id: message.id, content: message.content });
    return message;
  }

  private operatorReply(
    actor: OwnershipActor,
    conversation: ConversationRecord,
    operator: OperatorIdentity,
    message: string,
  ): Parameters<OperatorReplyService["announce"]>[0] {
    return { conversation, accountId: actor.accountId, operator, message };
  }

  private async requireConversation(actor: OwnershipActor, conversationId: string): Promise<ConversationRecord> {
    const conversation = await this.deps.conversations.findByIdAndWorkspaceId(conversationId, actor.workspaceId);
    if (!conversation) {
      throw notFound("Conversation not found");
    }
    return conversation;
  }

  private notifyDashboard(heldReply: HeldReplyRecord, actor: OwnershipActor | null, kind: WorkspaceInvalidationKind): void {
    notifyAfterCommit(this.deps, {
      notification: "dashboard_refresh",
      accountId: actor?.accountId ?? null,
      workspaceId: heldReply.workspaceId,
      conversationId: heldReply.conversationId,
    }, () => {
      this.deps.publisher?.enqueue(heldReply.workspaceId, [kind]);
    });
  }

  /** A queued send back with a teammate: the dashboard is told, and the audit names why, never the draft. */
  private async announceReturned(heldReply: HeldReplyRecord, code: string): Promise<void> {
    this.notifyDashboard(heldReply, null, "hitl.decision_created");
    this.countTransition("returned_to_pending");
    await this.recordAudit(heldReply, null, {
      action: "returned_to_pending",
      actorUserId: null,
      heldReplyId: heldReply.id,
      conversationId: heldReply.conversationId,
      holdReason: heldReply.holdReason,
      code,
    });
  }

  private countTransition(
    transition: "created" | "released" | "edited" | "discarded" | "superseded" | "queued_auto" | "auto_released" | "returned_to_pending",
  ): void {
    this.deps.metrics?.incrementCounter("held_replies_total", {
      help: "Held reply transitions",
      labels: { transition },
    });
  }

  private recordAudit(heldReply: HeldReplyRecord, actor: OwnershipActor | null, metadata: HeldReplyAuditMetadata): Promise<void> {
    return recordCommittedOwnershipAudit(this.deps, {
      eventType: "hitl.held_reply",
      accountId: actor?.accountId ?? null,
      workspaceId: heldReply.workspaceId,
      metadata,
    });
  }
}
