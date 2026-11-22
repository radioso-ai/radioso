/**
 * The narrow reads the chat history service takes from other modules, and the defaults it falls
 * back to when composition passes none: each reads nothing.
 */

import {
  formatActivityCursor,
  type ConversationActivityTimeline,
  type ConversationActivityTimelineReader,
} from "../../conversationActivity/contracts/index.js";
import type { TeammateLabelReaderPort } from "../../auth/contracts/index.js";
import type { ConversationOwnershipRecord } from "../../../db/repositories/conversationOwnershipRepository.js";
import type { VisitorRecord } from "../../../db/repositories/visitorRepository.js";

// Narrow read port the history service needs — single load for detail, batch for lists
// (no N+1). A missing entry means AI-owned (the ownership table is lazy).
export interface ConversationOwnershipHistoryReader {
  load(conversationId: string): Promise<ConversationOwnershipRecord | null>;
  loadByConversationIds(conversationIds: string[]): Promise<Map<string, ConversationOwnershipRecord>>;
}

export class NoopConversationOwnershipReader implements ConversationOwnershipHistoryReader {
  async load(): Promise<ConversationOwnershipRecord | null> {
    return null;
  }
  async loadByConversationIds(): Promise<Map<string, ConversationOwnershipRecord>> {
    return new Map();
  }
}

/**
 * Narrow read port chat/history needs from the visitors module: just enough to attach an
 * operator-facing profile to a conversation detail (spec 1277, FR-040). `VisitorRepository`
 * (`db/repositories/visitorRepository.ts`) satisfies this structurally — chat depends on this
 * shape, not on the visitors module's fuller `VisitorRepositoryPort`.
 */
export interface VisitorProfileReaderPort {
  findById(workspaceId: string, visitorId: string): Promise<VisitorRecord | null>;
}

export class NoopVisitorProfileReader implements VisitorProfileReaderPort {
  async findById(): Promise<VisitorRecord | null> {
    return null;
  }
}

export const NO_TEAMMATE_LABELS: ReadonlyMap<string, string> = new Map();

export class NoopTeammateLabelReader implements TeammateLabelReaderPort {
  async labelsByUserIds(): Promise<ReadonlyMap<string, string>> {
    return NO_TEAMMATE_LABELS;
  }
}

export class NoopConversationActivityReader implements ConversationActivityTimelineReader {
  async readTimeline(): Promise<ConversationActivityTimeline> {
    return { userIds: [], cursor: formatActivityCursor(new Date()), present: () => [] };
  }
}
