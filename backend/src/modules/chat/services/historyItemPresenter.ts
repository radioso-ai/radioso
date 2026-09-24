import type { ConversationRecord } from "../../../db/repositories/conversationRepository.js";
import type { HistoryItemsSourceRecord } from "../../../db/repositories/historyItemsRepository.js";
import type { ConversationMessageSummary } from "../../../db/repositories/messageRepository.js";
import {
  toDocumentSearchHistoryEntry,
  type DocumentSearchHistoryEntry,
} from "../../documents/historySupport.js";
import type { ChatConversationSummary, HistoryItem } from "./chatHistoryService.js";

const toIsoString = (value: Date): string => value.toISOString();

export const buildChatConversationSummary = (
  conversation: ConversationRecord,
  messageSummary?: ConversationMessageSummary,
): ChatConversationSummary => ({
  id: conversation.id,
  agentId: conversation.agentId,
  agentName: conversation.agentName,
  agentInternalName: conversation.agentInternalName,
  sourceChannel: conversation.sourceChannel,
  callerKind: conversation.callerKind,
  sourceOrigin: conversation.sourceOrigin,
  channelContext: conversation.channelContext,
  anonymousSessionId: conversation.anonymousSessionId ?? null,
  entryPageUrl: conversation.entryPageUrl ?? null,
  // Read straight off the conversation's own request_context — no `visitors` join for
  // a list (spec 1277, FR-040).
  visitorCountry: conversation.requestContext?.country ?? null,
  title: conversation.title ?? null,
  createdAt: toIsoString(conversation.createdAt),
  updatedAt: toIsoString(conversation.updatedAt),
  messageCount: messageSummary?.messageCount ?? 0,
  userMessageCount: messageSummary?.userMessageCount ?? 0,
  assistantMessageCount: messageSummary?.assistantMessageCount ?? 0,
  preview: messageSummary?.preview ?? null,
});

// Not exported: only buildHistoryItem below calls these, and nothing outside this file does.
const buildChatHistoryItem = (
  item: Extract<HistoryItemsSourceRecord, { kind: "chat" }>,
  messageSummary?: ConversationMessageSummary,
): HistoryItem => ({
  kind: "chat",
  id: item.id,
  sortAt: toIsoString(item.sortAt),
  conversation: buildChatConversationSummary(item.conversation, messageSummary),
});

const buildSearchHistoryItem = (
  item: Extract<HistoryItemsSourceRecord, { kind: "search" }>,
): HistoryItem & { kind: "search"; search: DocumentSearchHistoryEntry } => ({
  kind: "search",
  id: item.id,
  sortAt: toIsoString(item.sortAt),
  search: toDocumentSearchHistoryEntry(item.event),
});

export const buildHistoryItem = (
  item: HistoryItemsSourceRecord,
  messageSummary?: ConversationMessageSummary,
): HistoryItem => {
  if (item.kind === "chat") {
    return buildChatHistoryItem(item, messageSummary);
  }

  return buildSearchHistoryItem(item);
};
