import type { AccountPermission } from "../../account/public.js";
import type { Db } from "../../../shared/infra/kysely/types.js";

/**
 * What people and the agent did to a conversation that operators follow. Replies are not here:
 * they are messages already.
 */
export const CONVERSATION_ACTIVITY_KINDS = [
  "handoff_requested",
  "claimed",
  "reassigned",
  "handed_back",
  "approval_decided",
  "feedback_resolved",
  "feedback_dismissed",
] as const;

export type ConversationActivityKind = typeof CONVERSATION_ACTIVITY_KINDS[number];

/** The kinds that close an Inbox item: a handoff, an approval, or negative feedback. */
export const CLOSING_ACTIVITY_KINDS = [
  "handed_back",
  "approval_decided",
  "feedback_resolved",
  "feedback_dismissed",
] as const satisfies readonly ConversationActivityKind[];

export type ClosingActivityKind = typeof CLOSING_ACTIVITY_KINDS[number];

/** Negative feedback resolved or dismissed: a Quality triage outcome. */
export const FEEDBACK_ACTIVITY_KINDS = [
  "feedback_resolved",
  "feedback_dismissed",
] as const satisfies readonly ClosingActivityKind[];

/**
 * The permission a reader needs to see feedback triage outcomes. They are Quality data, and a
 * teammate who can follow conversations does not always hold Quality access.
 */
const FEEDBACK_ACTIVITY_PERMISSION = "workspace.quality.read" as const satisfies AccountPermission;

/** Which events a read may carry, resolved once from the caller's permissions at the edge. */
export interface ConversationActivityReadScope {
  /** Feedback resolved or dismissed: only for a caller holding {@link FEEDBACK_ACTIVITY_PERMISSION}. */
  includeFeedback: boolean;
}

/**
 * Resolves a read's scope at the edge, through however that edge checks the caller's permissions
 * (an HTTP session, a Ray turn), so which permission gates which events is decided only here.
 */
export const resolveActivityReadScope = async (
  holdsPermission: (permission: AccountPermission) => Promise<boolean>,
): Promise<ConversationActivityReadScope> => ({
  includeFeedback: await holdsPermission(FEEDBACK_ACTIVITY_PERMISSION),
});

// An ISO 8601 UTC timestamp, as `Date.prototype.toISOString` writes one, to microseconds at most.
const ACTIVITY_CURSOR_FORMAT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,6})?Z$/;

/**
 * A timeline read's cursor: when the read began, which the next read looks back from. Opaque to
 * callers, who pass back the one a read returned.
 */
export const formatActivityCursor = (readAt: Date): string => readAt.toISOString();

/** The time an activity cursor names; null for a string no read could have issued. */
export const parseActivityCursor = (cursor: string): Date | null => {
  if (!ACTIVITY_CURSOR_FORMAT.test(cursor)) {
    return null;
  }
  const readAt = new Date(cursor);
  return Number.isNaN(readAt.getTime()) ? null : readAt;
};

interface ConversationActivityScope {
  conversationId: string;
  workspaceId: string;
}

/**
 * One event as its writer records it. `actorUserId` is the teammate who acted — null when the agent
 * acted, or the change came from a caller that is no teammate. `detail` carries ids and enum codes
 * only, never message content.
 */
export type ConversationActivityEvent = ConversationActivityScope & (
  | { kind: "handoff_requested"; actorUserId: null; detail: { reason: string } }
  | { kind: "claimed"; actorUserId: string }
  | {
      kind: "reassigned";
      actorUserId: string;
      /** The teammate who holds the conversation now. */
      subjectUserId: string;
      /** Who held it before; null when nobody had claimed the handoff yet. */
      detail: { fromUserId: string | null };
    }
  | { kind: "handed_back"; actorUserId: string }
  | {
      kind: "approval_decided";
      actorUserId: string | null;
      /** The option chosen, with its label as the routine author wrote it. */
      detail: { handle: string; decision: { optionId: string; label: string } };
    }
  | {
      kind: "feedback_resolved" | "feedback_dismissed";
      actorUserId: string | null;
      /**
       * The answer the feedback was on, the triage transition that closed it — how a backfill or a
       * later read tells this closure apart from any other on the same answer, since this row's own
       * `created_at` is stamped independently of the transition's — and the resolution code if one
       * was given.
       */
      detail: { assistantMessageId: string; triageTransitionId: string; resolution: string | null };
    }
);

/**
 * Writes an event in the transaction the change it records runs in: pass that transaction as `db`.
 * A failed write throws, so the change rolls back with it — neither commits without the other.
 */
export interface ConversationActivityRecorder {
  record(db: Db, event: ConversationActivityEvent): Promise<void>;
}

/** A {@link ConversationActivityRecorder} already bound to the transaction a unit of work holds. */
export interface ConversationActivityWriter {
  record(event: ConversationActivityEvent): Promise<void>;
}

/** A stored event, as read back. */
export interface ConversationActivityRecord {
  id: string;
  conversationId: string;
  workspaceId: string;
  kind: ConversationActivityKind;
  actorUserId: string | null;
  subjectUserId: string | null;
  detail: Record<string, unknown>;
  createdAt: Date;
}

/** A closing event read back with its conversation's generated title, for the Inbox strip. */
export interface ClosingConversationActivityRecord extends Omit<ConversationActivityRecord, "kind"> {
  kind: ClosingActivityKind;
  conversationTitle: string | null;
}

/** A teammate an event names, labelled as they are now; the label is null once the user is gone. */
export interface ConversationActivityPerson {
  userId: string;
  label: string | null;
}

/**
 * An event as operator surfaces present it. Every teammate is labelled as they are now (display
 * name, else email), so the entry is operator-only: a label can be an email and never reaches a
 * visitor. The kind-specific fields are null on the kinds they do not belong to.
 */
export interface ConversationActivityEntry {
  id: string;
  kind: ConversationActivityKind;
  createdAt: string;
  /** Who acted; null when the agent acted, or a caller that is no teammate. */
  actor: ConversationActivityPerson | null;
  /** The new owner of a reassigned conversation. */
  subject: ConversationActivityPerson | null;
  /** Who held a reassigned conversation before; null when nobody had claimed it yet. */
  from: ConversationActivityPerson | null;
  /** Why the agent handed off: a handoff reason code. */
  handoffReason: string | null;
  /** The option chosen on an approval. */
  decision: { optionId: string; label: string } | null;
  /** The triage resolution code given when feedback was resolved or dismissed. */
  resolution: string | null;
  /** The answer resolved or dismissed feedback was on. */
  assistantMessageId: string | null;
}

/** The Inbox item a closing event closed. */
export const CLOSED_INBOX_ITEM_KINDS = ["handoff", "approval", "negative_feedback"] as const;

export type ClosedInboxItemKind = typeof CLOSED_INBOX_ITEM_KINDS[number];

/** One Inbox item closed recently: what it was, how it closed, who closed it and when. */
export interface RecentlyClosedInboxItem {
  /** The closing event's id. */
  id: string;
  conversationId: string;
  itemKind: ClosedInboxItemKind;
  outcome: ClosingActivityKind;
  closedAt: string;
  /** The teammate who closed it; null for a caller that is no teammate, or a user since deleted. */
  closedBy: ConversationActivityPerson | null;
  decision: { optionId: string; label: string } | null;
  resolution: string | null;
  assistantMessageId: string | null;
  /** The conversation's generated title, and its first-message preview for while it has none. */
  title: string | null;
  preview: string | null;
}

/**
 * A conversation's events as read, before its teammates are labelled, so a reader that labels other
 * teammates too (the repliers on a transcript) resolves every label in one lookup.
 */
export interface ConversationActivityTimeline {
  /** Every teammate the events name, once each. */
  readonly userIds: readonly string[];
  /** The cursor for the next read: {@link formatActivityCursor} of when this read began. */
  readonly cursor: string;
  /** The events, oldest first, each teammate labelled from `labels`. */
  present(labels: ReadonlyMap<string, string>): ConversationActivityEntry[];
}

/** Operator reads of a conversation's activity. */
export interface ConversationActivityTimelineReader {
  /**
   * The conversation's events, oldest first, within `scope`. With `after` — the cursor a previous
   * read returned — only the events recorded in a window reaching back from that read, wide enough
   * to take in an event whose transaction was still open then: the reader may get an event again,
   * and keeps each one once by its id.
   */
  readTimeline(
    workspaceId: string,
    conversationId: string,
    scope: ConversationActivityReadScope & { after?: string },
  ): Promise<ConversationActivityTimeline>;
}
