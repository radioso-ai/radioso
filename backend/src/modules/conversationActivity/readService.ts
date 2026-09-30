import type { TeammateLabelReaderPort } from "../auth/contracts/index.js";
import type {
  ClosingActivityKind,
  ClosingConversationActivityRecord,
  ConversationActivityKind,
  ConversationActivityReadScope,
  ConversationActivityRecord,
  ConversationActivityTimeline,
  ConversationActivityTimelineReader,
  RecentlyClosedInboxItem,
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
   * A conversation's events of `kinds`, oldest first. With `after` — an event's id — only the events
   * recorded after that one; an id the conversation has no event for matches nothing.
   */
  listForConversation(
    workspaceId: string,
    conversationId: string,
    options: { kinds: readonly ConversationActivityKind[]; after?: string },
  ): Promise<ConversationActivityRecord[]>;
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

  async readTimeline(
    workspaceId: string,
    conversationId: string,
    scope: ConversationActivityReadScope & { after?: string },
  ): Promise<ConversationActivityTimeline> {
    const records = await this.dependencies.store.listForConversation(workspaceId, conversationId, {
      kinds: visibleActivityKinds(scope),
      after: scope.after,
    });
    return {
      userIds: activityUserIds(records),
      cursor: records.at(-1)?.id ?? scope.after ?? null,
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
