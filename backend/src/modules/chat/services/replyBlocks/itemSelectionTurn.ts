import type { MessageRecord, UserMessageInputMetadata } from "../../../../db/repositories/messageRepository.js";
import type { ProductAnalyticsPort } from "../../../../shared/analytics/productAnalyticsService.js";
import { AppError, badRequest, notFound } from "../../../../shared/domain/errors.js";
import type { AppLogger } from "../../../../shared/observability/logger.js";
import type { MetricsRegistry } from "../../../../shared/observability/metrics/metricsRegistry.js";
import type { AssistantChatRequest, UserMessageStoredListener } from "../../types/assistantApi.js";
import { findTurnConversation, type TurnConversationReader } from "../turnConversation.js";
import { readItemSelection, type ItemSelectionRejection, type SelectedItem } from "./itemSelection.js";

/** The messages a pick reads: the one that showed the cards, and whether its reply was already picked from. */
export interface ItemSelectionMessages {
  findByIdAndWorkspaceId(workspaceId: string, messageId: string): Promise<MessageRecord | null>;
  hasItemSelectionFrom(input: { workspaceId: string; conversationId: string; messageId: string }): Promise<boolean>;
}

export interface ItemSelectionTurnDependencies {
  conversations: TurnConversationReader;
  messages: ItemSelectionMessages;
  analytics?: ProductAnalyticsPort | null;
  metrics?: Pick<MetricsRegistry, "incrementCounter"> | null;
  logger?: Pick<AppLogger, "info"> | null;
}

/**
 * A pick, claimed for its turn: the text the turn runs on (the item's stored title, whatever the
 * client sent), the metadata its message stores, the item the turn carries as its subject, and the
 * listener that records the pick once the message is stored.
 */
export interface ItemSelectionTurn {
  readonly query: string;
  readonly inputMetadata: UserMessageInputMetadata;
  readonly item: SelectedItem;
  readonly onUserMessageStored: UserMessageStoredListener;
}

type ItemSelectionOutcome = "accepted" | `rejected_${ItemSelectionRejection | "already_selected"}`;

const invalidSelection = (): AppError =>
  new AppError(400, "item_selection_invalid", "The selection names no card that can be picked in this conversation.");

const repeatedSelection = (): AppError =>
  new AppError(409, "item_already_selected", "A card was already picked from this reply.");

/**
 * Turns a visitor's pick (`inputMetadata.method: "item_select"`) into its turn. The item is read
 * from the block stored on the message that showed it, in the conversation the sender reaches,
 * never from client fields. A pick that names no such item is refused with 400 and a second pick
 * from the same reply with 409, both before a message is stored or a turn runs. It knows nothing
 * of channels: every surface that shows cards sends the same pick.
 */
export class ItemSelectionTurns {
  constructor(private readonly deps: ItemSelectionTurnDependencies) {}

  async claim(
    input: Pick<AssistantChatRequest, "workspaceId" | "conversationId" | "chatSessionId" | "anonymousSessionId" | "inputMetadata" | "imageIds" | "routineInvocation">,
  ): Promise<ItemSelectionTurn | null> {
    const selection = input.inputMetadata?.method === "item_select" ? input.inputMetadata.selection : undefined;
    if (!selection) {
      return null;
    }
    if (!input.conversationId || (input.imageIds?.length ?? 0) > 0 || input.routineInvocation) {
      throw badRequest("A selection is sent alone, in the conversation whose reply showed the card.");
    }
    const { workspaceId, conversationId } = input;
    const conversation = await findTurnConversation(this.deps.conversations, {
      conversationId,
      workspaceId,
      chatSessionId: input.chatSessionId ?? input.anonymousSessionId,
    });
    if (!conversation || conversation.purpose === "operator_test") {
      throw notFound("Conversation not found");
    }
    const message = await this.deps.messages.findByIdAndWorkspaceId(workspaceId, selection.messageId);
    const reading = readItemSelection(message, conversation.id, selection);
    const ids = { workspaceId, conversationId, messageId: selection.messageId, blockId: selection.blockId };
    if (!reading.ok) {
      this.reject(reading.reason, ids);
      throw invalidSelection();
    }
    if (await this.deps.messages.hasItemSelectionFrom({ workspaceId, conversationId, messageId: selection.messageId })) {
      this.reject("already_selected", ids);
      throw repeatedSelection();
    }
    this.count("accepted");
    const { item } = reading;
    return {
      query: item.title.trim() || item.document?.title.trim() || item.key,
      inputMetadata: { method: "item_select", selection },
      item,
      onUserMessageStored: async () => {
        await this.deps.analytics?.track({
          eventName: "chat.item_selected",
          workspaceId,
          subjectType: "conversation",
          subjectId: conversationId,
          properties: {
            messageId: item.messageId,
            blockId: item.blockId,
            itemKey: item.key,
            channel: conversation.sourceChannel ?? null,
            source: item.skillName ? "skill_result" : "document",
          },
          source: "backend",
        }).catch(() => null);
      },
    };
  }

  private reject(reason: ItemSelectionRejection | "already_selected", ids: Record<string, string>): void {
    this.count(`rejected_${reason}`);
    this.deps.logger?.info({ event: "chat.item_selection_rejected", reason, ...ids }, "A card selection was refused");
  }

  private count(outcome: ItemSelectionOutcome): void {
    this.deps.metrics?.incrementCounter("reply_item_selection_total", {
      help: "Cards visitors picked from reply blocks, accepted or refused by reason",
      labels: { outcome },
    });
  }
}
