import type { TeammateLabelReaderPort } from "../auth/contracts/index.js";
import {
  formatActivityCursor,
  parseActivityCursor,
  type ClosingActivityKind,
  type ClosingConversationActivityRecord,
  type ConversationActivityKind,
  type ConversationActivityReadScope,
  type ConversationActivityRecord,
  type ConversationActivityTimeline,
  type ConversationActivityTimelineReader,
  type RecentlyClosedInboxItem,
} from "./contracts/index.js";
import {
  activityUserIds,
  closedItemKind,
  presentActivity,
  visibleActivityKinds,
  visibleClosingKinds,
} from "./presentation.js";

/** Where the events are read from. */
export interface ConversationActivityStore {
  /**
   * A conversation's latest events of `kinds`, oldest first — with `recordedAfter`, only those
   * recorded after that time — and when the read began, by the clock that dates the events.
   */
  listForConversation(
    workspaceId: string,
    conversationId: string,
    options: { kinds: readonly ConversationActivityKind[]; recordedAfter?: Date },
  ): Promise<{ records: ConversationActivityRecord[]; readAt: Date }>;
  /** A workspace's latest events of `kinds`, newest first, each with its conversation's title. */
  listRecentClosing(
    workspaceId: string,
    limit: number,
    kinds: readonly ClosingActivityKind[],
  ): Promise<ClosingConversationActivityRecord[]>;
}

/** Each conversation's first-message preview, the fallback title while it has no generated one. */
interface ConversationPreviewReader {
  previewsByConversationIds(workspaceId: string, conversationIds: readonly string[]): Promise<ReadonlyMap<string, string | null>>;
}

const NO_LABELS: ReadonlyMap<string, string> = new Map();

/**
 * How far a read with a cursor looks back from the read that issued it. An event is dated when it
 * is written but seen only once its transaction commits, so it can come into view after a read that
 * already saw a newer event. Every writer records inside the change it records, and the slowest is
 * an approval decided: its event is written before the routine's resume turn, which runs in the same
 * transaction — waiting out a turn already running on the conversation, then the turn's own model
 * calls and skill dispatches. A turn takes seconds, a slow one tens of seconds; five minutes covers
 * the slowest several times over, while a conversation records only a handful of events in that
 * window, so re-reading it costs a poll next to nothing.
 */
const COMMIT_LOOKBACK_MS = 5 * 60 * 1000;

/**
 * Operator reads of conversation activity: a conversation's timeline, and the Inbox's recently
 * closed items. Each read carries only the kinds its scope allows. Every teammate an event names is
 * labelled as they are now, in one lookup per read — the timeline leaves that lookup to its caller,
 * which labels other teammates in the same one.
 */
export class ConversationActivityReadService implements ConversationActivityTimelineReader {
  constructor(private readonly dependencies: {
    store: ConversationActivityStore;
    teammateLabels: TeammateLabelReaderPort;
    previews: ConversationPreviewReader;
  }) {}

  /**
   * With a cursor, the events recorded in the {@link COMMIT_LOOKBACK_MS} before the read that issued
   * it, and since: everything that committed after that read, and some the reader already holds.
   * The cursor names a time, not an event, so one from another conversation reads this one's window
   * and never stalls it; a string no read issued reads the whole timeline.
   */
  async readTimeline(
    workspaceId: string,
    conversationId: string,
    scope: ConversationActivityReadScope & { after?: string },
  ): Promise<ConversationActivityTimeline> {
    const previousRead = scope.after === undefined ? null : parseActivityCursor(scope.after);
    const { records, readAt } = await this.dependencies.store.listForConversation(workspaceId, conversationId, {
      kinds: visibleActivityKinds(scope),
      ...(previousRead ? { recordedAfter: new Date(previousRead.getTime() - COMMIT_LOOKBACK_MS) } : {}),
    });
    return {
      userIds: activityUserIds(records),
      cursor: formatActivityCursor(readAt),
      present: (labels) => records.map((record) => presentActivity(record, labels)),
    };
  }

  async listRecentlyClosed(
    workspaceId: string,
    limit: number,
    scope: ConversationActivityReadScope,
  ): Promise<RecentlyClosedInboxItem[]> {
    const records = await this.dependencies.store.listRecentClosing(workspaceId, limit, visibleClosingKinds(scope));
    const conversationIds = [...new Set(records.map((record) => record.conversationId))];
    const [labels, previews] = await Promise.all([
      this.labelsFor(records),
      conversationIds.length > 0
        ? this.dependencies.previews.previewsByConversationIds(workspaceId, conversationIds)
        : Promise.resolve(new Map<string, string | null>()),
    ]);
    return records.map((record) => {
      const entry = presentActivity(record, labels);
      return {
        id: entry.id,
        conversationId: record.conversationId,
        itemKind: closedItemKind(record.kind),
        outcome: record.kind,
        closedAt: entry.createdAt,
        closedBy: entry.actor,
        decision: entry.decision,
        resolution: entry.resolution,
        assistantMessageId: entry.assistantMessageId,
        title: record.conversationTitle,
        preview: previews.get(record.conversationId) ?? null,
      };
    });
  }

  private labelsFor(records: readonly ConversationActivityRecord[]): Promise<ReadonlyMap<string, string>> {
    const userIds = activityUserIds(records);
    return userIds.length > 0 ? this.dependencies.teammateLabels.labelsByUserIds(userIds) : Promise.resolve(NO_LABELS);
  }
}
