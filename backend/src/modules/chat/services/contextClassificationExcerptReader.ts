import type { ConversationRepositoryPort } from "../../../db/repositories/conversationRepository.js";
import type { MessageRepositoryPort } from "../../../db/repositories/messageRepository.js";
import { carriesSensitiveValue } from "../../../shared/domain/sensitiveTranscript.js";
import type { AppLogger } from "../../../shared/observability/logger.js";
import type { ConversationExcerpt, ConversationExcerptReader } from "../../contextClassification/public.js";
import { isAudiencePulseCustomerSource } from "../audiencePulseHistorySource.js";
import { loadConversationSummaryText, type ConversationSummaryStore } from "../contracts/conversationSummary.js";

/**
 * The classifier's view of a conversation: its rolling summary, which already reads a withheld
 * message as withheld, and the visitor's latest messages. A message a teammate sent is not the
 * visitor's. A message of a turn whose routine held a sensitive slot (#1543) is never sent: it is
 * counted, so a run whose every recent message was withheld can say so.
 */
export class ContextClassificationExcerptReader implements ConversationExcerptReader {
  constructor(private readonly deps: {
    conversations: Pick<ConversationRepositoryPort, "findByIdAndWorkspaceId">;
    messages: Pick<MessageRepositoryPort, "listRecentByConversationId">;
    summaries: Pick<ConversationSummaryStore, "load">;
    logger?: Pick<AppLogger, "warn">;
  }) {}

  async readExcerpt(input: {
    workspaceId: string;
    conversationId: string;
    maxMessages: number;
    maxMessageChars: number;
  }): Promise<ConversationExcerpt | null> {
    const conversation = await this.deps.conversations.findByIdAndWorkspaceId(input.conversationId, input.workspaceId);
    if (!conversation) return null;
    const [summary, recent] = await Promise.all([
      loadConversationSummaryText(this.deps.summaries, input.conversationId, this.deps.logger),
      this.deps.messages.listRecentByConversationId(input.workspaceId, input.conversationId, input.maxMessages, { roles: ["user"] }),
    ]);
    const visitors = recent.filter((message) => isAudiencePulseCustomerSource(message.source ?? null));
    const sendable = visitors.filter((message) => !carriesSensitiveValue(message.metadata));
    return {
      summary: summary ?? null,
      messages: sendable.map((message) => message.content.trim().slice(0, input.maxMessageChars)).filter((text) => text.length > 0),
      withheldCount: visitors.length - sendable.length,
    };
  }
}
