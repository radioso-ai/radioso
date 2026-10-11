import { CursorPaginationError, decodeCursorWithKeys, encodeCursor } from "../../shared/domain/cursorPagination.js";
import type {
  ConversationActivityEvent,
  ConversationActivityWriter,
} from "../conversationActivity/contracts/index.js";

/**
 * How a reply failed to reach the customer: bounced or suppressed, refused or failed, of an outcome
 * nobody knows and nothing will retry, or halted before it was sent because the authority to send
 * it was gone.
 */
export type DeliveryFailureKind = "bounced" | "failed" | "uncertain" | "halted";

/**
 * Why the delivering channel clears a failure: a later send on the conversation was delivered,
 * provider evidence settled it, or a teammate resolved it through the channel's audited resolution.
 * A teammate's acknowledgement clears one too, but it is not the channel's to report.
 */
type DeliveryFailureClearReason = "later_delivery" | "provider_evidence" | "operator_resolved";

export interface DeliveryFailureRecord {
  id: string;
  workspaceId: string;
  conversationId: string;
  /** Null for a failure that names no message. */
  messageId: string | null;
  provider: string;
  kind: DeliveryFailureKind;
  /** The provider's code, sanitized; never its bounce message. */
  detailCode: string | null;
  openedAt: Date;
  clearedAt: Date | null;
  clearedByUserId: string | null;
  clearReason: DeliveryFailureClearReason | "acknowledged" | null;
}

interface DeliveryFailureOpenInput {
  workspaceId: string;
  conversationId: string;
  messageId: string | null;
  provider: string;
  kind: DeliveryFailureKind;
  detailCode: string | null;
}

interface DeliveryFailureRetargetInput {
  conversationId: string;
  messageId: string;
  kind: DeliveryFailureKind;
  detailCode: string | null;
}

/**
 * What a clear names. Provider evidence settles one message's failure, and a later delivered send
 * those of every message it vouches for, as the channel lists them: never a newer send's. A
 * teammate's resolution clears exactly the failure they decided on, and names them; the channel's
 * own clears name nobody.
 */
type DeliveryFailureClearInput =
  | { reason: "later_delivery" | "provider_evidence"; conversationId: string; messageIds: readonly string[] }
  | { reason: "operator_resolved"; failureId: string; userId: string };

/** Which open failures a clear matches: those on the conversation's listed messages, or one by id. */
type DeliveryFailureClearTarget = { conversationId: string; messageIds: readonly string[] } | { failureId: string };

/** How a delivering channel raises, settles and clears the failures of the replies it carries. */
export interface DeliveryFailureRecorderPort {
  /** Raises a failure on the message; a no-op while one is already open on it. */
  open(input: DeliveryFailureOpenInput): Promise<void>;
  /**
   * Moves the message's open failure to `kind`, as late provider evidence settles an uncertain
   * send; a no-op when none is open, or it already is of `kind`.
   */
  retarget(input: DeliveryFailureRetargetInput): Promise<void>;
  /** Clears the open failures the input names; returns how many it cleared. */
  clear(input: DeliveryFailureClearInput): Promise<number>;
}

/**
 * A delivering channel's hold on the failure a teammate decided on, inside the transaction that
 * settles the decision, so a stale request can never act on a failure other than the one it named.
 */
export interface DeliveryFailureLockPort {
  /** The workspace's failure `failureId` while it is still open, locked until the transaction ends; null once cleared. */
  lockOpen(input: { workspaceId: string; failureId: string }): Promise<DeliveryFailureRecord | null>;
}

export interface DeliveryFailurePage {
  items: DeliveryFailureRecord[];
  /** Pass back to read the next page; null on the last one. */
  nextCursor: string | null;
}

/** An open failure as a waiting queue ranks it: what failed, and since when. */
export interface DeliveryFailureWait {
  id: string;
  conversationId: string;
  kind: DeliveryFailureKind;
  /** The provider's code, sanitized; never its bounce message. */
  detailCode: string | null;
  openedAt: Date;
}

/** Operator surfaces' read of the failures waiting for attention. */
interface DeliveryFailureReaderPort {
  /** A workspace's open failures, newest first; with `agentId`, only on that agent's conversations. */
  listOpen(workspaceId: string, query: { agentId?: string; cursor?: string; limit: number }): Promise<DeliveryFailurePage>;
  /** The open failures waiting longest, up to `limit`, with how many are open; with `agentId`, on that agent's conversations. */
  longestWaiting(workspaceId: string, query: { agentId?: string; limit: number }): Promise<{ total: number; items: DeliveryFailureWait[] }>;
}

/** Where a page of open failures ends: newest first, so the next page holds the ones before it. */
interface DeliveryFailurePosition {
  openedAt: Date;
  id: string;
}

/** The failures' rows, bound to the transaction of the unit of work that writes them. */
export interface DeliveryFailureWriteStore {
  /** The failure raised; null when the message already has an open one. */
  insertOpen(input: DeliveryFailureOpenInput): Promise<DeliveryFailureRecord | null>;
  /** The message's open failure, now of `kind`; null when none is open, or it already was. */
  retargetOpen(input: DeliveryFailureRetargetInput): Promise<DeliveryFailureRecord | null>;
  /** The open failures `target` names, now cleared. */
  clearOpen(input: {
    target: DeliveryFailureClearTarget;
    reason: DeliveryFailureClearReason;
    clearedByUserId: string | null;
  }): Promise<DeliveryFailureRecord[]>;
  /** The workspace's open failure `failureId`, row-locked for the rest of the transaction; null when it has no such open failure. */
  lockOpen(input: { workspaceId: string; failureId: string }): Promise<DeliveryFailureRecord | null>;
  /** The workspace's open failure `failureId`, now acknowledged by `userId`; null when it has no such open failure. */
  acknowledgeOpen(input: { workspaceId: string; failureId: string; userId: string }): Promise<DeliveryFailureRecord | null>;
}

type DeliveryFailureListQuery = { agentId: string | undefined; after: DeliveryFailurePosition | null; limit: number };

export interface DeliveryFailureReadStore {
  /** Up to `limit` open failures, newest first, after `after`; with `agentId`, on that agent's conversations. */
  listOpen(workspaceId: string, query: DeliveryFailureListQuery): Promise<DeliveryFailureRecord[]>;
  /** As {@link listOpen}, with the cleared failures among them. */
  listAll(workspaceId: string, query: DeliveryFailureListQuery): Promise<DeliveryFailureRecord[]>;
  /** The workspace's failure `failureId`, open or cleared; null when the workspace has none of that id. */
  find(workspaceId: string, failureId: string): Promise<DeliveryFailureRecord | null>;
  /** Up to `limit` of the open failures, oldest first; with `agentId`, on that agent's conversations. */
  listOldestOpen(workspaceId: string, query: { agentId: string | undefined; limit: number }): Promise<DeliveryFailureWait[]>;
  /** How many failures are open; with `agentId`, how many on that agent's conversations. */
  countOpen(workspaceId: string, query: { agentId: string | undefined }): Promise<number>;
}

/** One failure change and the activity it records, bound to one transaction. */
export interface DeliveryFailureWriteScope {
  failures: DeliveryFailureWriteStore;
  activity: ConversationActivityWriter;
}

/** Runs a failure change with the activity it records as one unit: both commit, or neither does. */
export interface DeliveryFailureUnitOfWork {
  run<T>(work: (scope: DeliveryFailureWriteScope) => Promise<T>): Promise<T>;
}

const failedActivity = (failure: DeliveryFailureRecord): ConversationActivityEvent => ({
  kind: "delivery_failed",
  conversationId: failure.conversationId,
  workspaceId: failure.workspaceId,
  actorUserId: null,
  detail: { failureId: failure.id, messageId: failure.messageId, failureKind: failure.kind },
});

const clearedActivity = (
  failure: DeliveryFailureRecord,
  reason: DeliveryFailureClearReason | "acknowledged",
  actorUserId: string | null,
): ConversationActivityEvent => ({
  kind: "delivery_failure_cleared",
  conversationId: failure.conversationId,
  workspaceId: failure.workspaceId,
  actorUserId,
  detail: { failureId: failure.id, messageId: failure.messageId, reason },
});

/**
 * The recorder bound to a transaction its caller holds, such as the send path's fenced transition,
 * so a failure is raised, settled or cleared with the change that caused it, or not at all; and,
 * for a teammate's decision, the lock on the failure it settles.
 */
export const bindDeliveryFailureRecorder = (scope: DeliveryFailureWriteScope): DeliveryFailureRecorderPort & DeliveryFailureLockPort => ({
  async open(input) {
    const opened = await scope.failures.insertOpen(input);
    if (opened) {
      await scope.activity.record(failedActivity(opened));
    }
  },
  async retarget(input) {
    const retargeted = await scope.failures.retargetOpen(input);
    if (retargeted) {
      await scope.activity.record(failedActivity(retargeted));
    }
  },
  async clear(input) {
    const clearedByUserId = input.reason === "operator_resolved" ? input.userId : null;
    const target: DeliveryFailureClearTarget = input.reason === "operator_resolved"
      ? { failureId: input.failureId }
      : { conversationId: input.conversationId, messageIds: input.messageIds };
    const cleared = await scope.failures.clearOpen({ target, reason: input.reason, clearedByUserId });
    for (const failure of cleared) {
      await scope.activity.record(clearedActivity(failure, input.reason, clearedByUserId));
    }
    return cleared.length;
  },
  lockOpen: (input) => scope.failures.lockOpen(input),
});

const CURSOR_KEYS = ["openedAt", "id"] as const;

const encodePosition = (failure: DeliveryFailureRecord): string =>
  encodeCursor({ openedAt: failure.openedAt.toISOString(), id: failure.id });

const decodePosition = (cursor: string): DeliveryFailurePosition => {
  const { keys } = decodeCursorWithKeys(cursor, CURSOR_KEYS);
  const openedAt = new Date(keys.openedAt);
  if (Number.isNaN(openedAt.getTime())) {
    throw new CursorPaginationError("Invalid cursor");
  }
  return { openedAt, id: keys.id };
};

/**
 * Replies that may not have reached the customer, channel-neutral: a delivering channel raises,
 * settles and clears them, each change in its own unit of work with the activity it records;
 * operator surfaces read them, and a teammate acknowledges one.
 */
export class DeliveryFailures implements DeliveryFailureRecorderPort, DeliveryFailureReaderPort {
  constructor(private readonly deps: { writes: DeliveryFailureUnitOfWork; reads: DeliveryFailureReadStore }) {}

  open(input: DeliveryFailureOpenInput): Promise<void> {
    return this.deps.writes.run((scope) => bindDeliveryFailureRecorder(scope).open(input));
  }

  retarget(input: DeliveryFailureRetargetInput): Promise<void> {
    return this.deps.writes.run((scope) => bindDeliveryFailureRecorder(scope).retarget(input));
  }

  clear(input: DeliveryFailureClearInput): Promise<number> {
    return this.deps.writes.run((scope) => bindDeliveryFailureRecorder(scope).clear(input));
  }

  /**
   * A teammate's acknowledgement: clears the workspace's open failure with the activity it records.
   * Null when the workspace has no such open failure.
   */
  acknowledge(input: { workspaceId: string; failureId: string; userId: string }): Promise<DeliveryFailureRecord | null> {
    return this.deps.writes.run(async (scope) => {
      const acknowledged = await scope.failures.acknowledgeOpen(input);
      if (acknowledged) {
        await scope.activity.record(clearedActivity(acknowledged, "acknowledged", input.userId));
      }
      return acknowledged;
    });
  }

  find(workspaceId: string, failureId: string): Promise<DeliveryFailureRecord | null> {
    return this.deps.reads.find(workspaceId, failureId);
  }

  listOpen(
    workspaceId: string,
    query: { agentId?: string; cursor?: string; limit: number },
  ): Promise<DeliveryFailurePage> {
    return this.list(workspaceId, { ...query, state: "open" });
  }

  /**
   * The open failures waiting longest, up to `limit`, with how many are open: one bounded read and
   * one count however long the backlog, so a queue reader never pages through it.
   */
  async longestWaiting(workspaceId: string, query: { agentId?: string; limit: number }): Promise<{ total: number; items: DeliveryFailureWait[] }> {
    const [items, total] = await Promise.all([
      this.deps.reads.listOldestOpen(workspaceId, { agentId: query.agentId, limit: query.limit }),
      this.deps.reads.countOpen(workspaceId, { agentId: query.agentId }),
    ]);
    return { total, items };
  }

  /** A workspace's failures newest first: the open ones, or with `state: "all"` the cleared ones too. */
  async list(
    workspaceId: string,
    query: { state: "open" | "all"; agentId?: string; cursor?: string; limit: number },
  ): Promise<DeliveryFailurePage> {
    const after = query.cursor === undefined ? null : decodePosition(query.cursor);
    // One past the page tells whether another follows.
    const page = { agentId: query.agentId, after, limit: query.limit + 1 };
    const rows = query.state === "all"
      ? await this.deps.reads.listAll(workspaceId, page)
      : await this.deps.reads.listOpen(workspaceId, page);
    const items = rows.slice(0, query.limit);
    const last = items.at(-1);
    return {
      items,
      nextCursor: rows.length > query.limit && last ? encodePosition(last) : null,
    };
  }
}
