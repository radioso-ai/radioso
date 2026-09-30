import type { TeammateLabelReaderPort } from "../auth/contracts/index.js";
import type {
  ClosingConversationActivityRecord,
  ConversationActivityEntry,
  ConversationActivityRecord,
  ConversationActivityTimelineReader,
  RecentlyClosedInboxItem,
} from "./contracts/index.js";
import { activityUserIds, closedItemKind, isClosingKind, presentActivity } from "./presentation.js";

/** Where the events are read from. */
export interface ConversationActivityStore {
  listForConversation(workspaceId: string, conversationId: string): Promise<ConversationActivityRecord[]>;
  listRecentClosing(workspaceId: string, limit: number): Promise<ClosingConversationActivityRecord[]>;
}

/** Each conversation's first-message preview, the fallback title while it has no generated one. */
interface ConversationPreviewReader {
  previewsByConversationIds(workspaceId: string, conversationIds: readonly string[]): Promise<ReadonlyMap<string, string | null>>;
}

const NO_LABELS: ReadonlyMap<string, string> = new Map();

/**
 * Operator reads of conversation activity: a conversation's timeline, and the Inbox's recently
 * closed items. Every teammate an event names is labelled as they are now, in one lookup per read.
 */
export class ConversationActivityReadService implements ConversationActivityTimelineReader {
  constructor(private readonly dependencies: {
    store: ConversationActivityStore;
    teammateLabels: TeammateLabelReaderPort;
    previews: ConversationPreviewReader;
  }) {}

  async listForConversation(workspaceId: string, conversationId: string): Promise<ConversationActivityEntry[]> {
    const records = await this.dependencies.store.listForConversation(workspaceId, conversationId);
    const labels = await this.labelsFor(records);
    return records.map((record) => presentActivity(record, labels));
  }

  async listRecentlyClosed(workspaceId: string, limit: number): Promise<RecentlyClosedInboxItem[]> {
    const records = await this.dependencies.store.listRecentClosing(workspaceId, limit);
    const conversationIds = [...new Set(records.map((record) => record.conversationId))];
    const [labels, previews] = await Promise.all([
      this.labelsFor(records),
      conversationIds.length > 0
        ? this.dependencies.previews.previewsByConversationIds(workspaceId, conversationIds)
        : Promise.resolve(new Map<string, string | null>()),
    ]);
    return records.flatMap((record) => {
      if (!isClosingKind(record.kind)) {
        return [];
      }
      const entry = presentActivity(record, labels);
      return [{
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
      }];
    });
  }

  private labelsFor(records: readonly ConversationActivityRecord[]): Promise<ReadonlyMap<string, string>> {
    const userIds = activityUserIds(records);
    return userIds.length > 0 ? this.dependencies.teammateLabels.labelsByUserIds(userIds) : Promise.resolve(NO_LABELS);
  }
}
