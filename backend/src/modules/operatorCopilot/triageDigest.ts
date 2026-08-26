import type { CopilotEntityReference } from "./contracts.js";

/**
 * Why an item is in the digest, and therefore where it ranks. The three tiers answer the three
 * questions an operator asks in this order: who is waiting on me, what is broken, and what has
 * piled up. Ordering is the product here — a digest that lists everything is the same as no
 * digest — so the tier is part of the result rather than an implementation detail of the sort.
 */
export type CopilotTriageUrgency = "blocking" | "attention" | "backlog";

export type CopilotTriageItemKind =
  | "approval"
  | "handoff"
  | "negative_feedback"
  | "failed_document"
  | "failed_source_sync"
  | "failing_eval_case"
  | "untriaged_quality_turns"
  | "documents_processing";

export interface CopilotTriageItem {
  readonly kind: CopilotTriageItemKind;
  readonly urgency: CopilotTriageUrgency;
  /** Workspace data, never composed copy: a reason, preview, name, or signal id — or null. */
  readonly title: string | null;
  readonly detail: string | null;
  /** When the wait or the failure started. Null on aggregate rows, which have no single clock. */
  readonly since: string | null;
  /** Rows this line stands for: 1 for a single item, the group size for an aggregate. */
  readonly count: number;
  readonly agentId: string | null;
  readonly conversationId: string | null;
  /** Where this item hands off to in the dashboard. */
  readonly subject: CopilotEntityReference;
}

/**
 * The reads the digest is composed from. One report per read, always present, and one cap per
 * report. Documents and their sources read the same permission but stay separate: a broken crawl
 * is the cause of the failed documents under it and there are far fewer of them, so sharing a cap
 * would let a run of recent document failures bury the handful of syncs that explain them.
 */
export type CopilotTriageSourceId = "approvals" | "handoffs" | "quality" | "documents" | "document_sources" | "evals";

/**
 * A source that could not be read reports why. Absence and emptiness are different answers, and
 * a digest that renders "could not read" as zero tells an operator their workspace is clear.
 */
export type CopilotTriageSourceStatus = "ok" | "unauthorized" | "failed";

export interface CopilotTriageSourceReport {
  readonly source: CopilotTriageSourceId;
  readonly status: CopilotTriageSourceStatus;
  /** Rows the source matched before the digest's cap. Null when the source could not be read. */
  readonly total: number | null;
  /** Rows the digest lists individually for this source. Aggregate lines are not rows. */
  readonly included: number;
}

/**
 * Which read produced a kind. The digest drops items after ranking, so the count a source reports
 * has to be derived from what survived rather than from what was fetched.
 */
const sourceByKind: Record<CopilotTriageItemKind, CopilotTriageSourceId> = {
  approval: "approvals",
  handoff: "handoffs",
  negative_feedback: "quality",
  untriaged_quality_turns: "quality",
  failed_document: "documents",
  documents_processing: "documents",
  failed_source_sync: "document_sources",
  failing_eval_case: "evals",
};

export const copilotTriageSourceForKind = (kind: CopilotTriageItemKind): CopilotTriageSourceId => sourceByKind[kind];

/**
 * Kinds that stand for a group rather than for one row. They are never subject to a source's cap,
 * so counting them among the rows a source listed would let a section report listing more than it
 * matched — "0 matched, 2 listed" — which is the opposite of what the two counts exist to say.
 */
const aggregateKinds: ReadonlySet<CopilotTriageItemKind> = new Set(["untriaged_quality_turns", "documents_processing"]);

export const isCopilotTriageAggregate = (kind: CopilotTriageItemKind): boolean => aggregateKinds.has(kind);

const urgencyRank: Record<CopilotTriageUrgency, number> = { blocking: 0, attention: 1, backlog: 2 };

const parsedTime = (value: string | null): number | null => {
  if (value === null) return null;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
};

/**
 * Whole minutes elapsed, floored at zero. A clock skewed slightly ahead of the row it measures
 * must read as "just now", never as a negative wait that sorts below every real one.
 */
export const copilotTriageWaitingMinutes = (since: string | null, now: Date): number | null => {
  const started = parsedTime(since);
  return started === null ? null : Math.max(0, Math.floor((now.getTime() - started) / 60_000));
};

/** Orders two clocks, keeping rows with no clock last whichever direction is asked for. */
const byTime = (left: number | null, right: number | null, direction: "oldest_first" | "newest_first"): number => {
  if (left === right) return 0;
  if (left === null) return 1;
  if (right === null) return -1;
  return direction === "oldest_first" ? left - right : right - left;
};

/**
 * Longest wait first inside `blocking`: #936 established that newest-first inverts the urgency
 * model for handoffs, and the same inversion would put the freshest approval above the one that
 * has been open all morning. `attention` inverts deliberately — for a failure or a complaint the
 * operator wants what just broke — and `backlog` ranks by size, since an aggregate has no clock.
 */
const withinUrgency = (left: CopilotTriageItem, right: CopilotTriageItem): number => {
  if (left.urgency === "backlog") return right.count - left.count;
  return byTime(
    parsedTime(left.since),
    parsedTime(right.since),
    left.urgency === "blocking" ? "oldest_first" : "newest_first",
  );
};

const rankTriageItems = (items: ReadonlyArray<CopilotTriageItem>): ReadonlyArray<CopilotTriageItem> =>
  [...items].sort((left, right) =>
    urgencyRank[left.urgency] - urgencyRank[right.urgency]
    || withinUrgency(left, right)
    || left.kind.localeCompare(right.kind)
    || (left.title ?? "").localeCompare(right.title ?? ""));

/**
 * A conversation an operator is already being asked to act on does not also need a review line:
 * the escalation is the more urgent statement of the same work, and listing both spends the
 * digest's attention budget twice on one conversation.
 */
const withoutConversationsAlreadyEscalated = (
  items: ReadonlyArray<CopilotTriageItem>,
): ReadonlyArray<CopilotTriageItem> => {
  const escalated = new Set(items
    .filter((item) => item.urgency === "blocking" && item.conversationId !== null)
    .map((item) => item.conversationId));
  return items.filter((item) =>
    item.kind !== "negative_feedback" || !escalated.has(item.conversationId));
};

/** Applies the digest's product rules to already-projected items. Pure: no I/O, no clock. */
export const buildCopilotTriageDigest = (
  items: ReadonlyArray<CopilotTriageItem>,
): ReadonlyArray<CopilotTriageItem> => rankTriageItems(withoutConversationsAlreadyEscalated(items));
