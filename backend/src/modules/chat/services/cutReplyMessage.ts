import type { MessageRepositoryPort } from "../../../db/repositories/messageRepository.js";
import { stripResidualCitationSyntax } from "./citationAnchorParser.js";
import { canonicalizeUnsourcedMarkers } from "./unsourcedMarkerCanonicalization.js";

type MessageCreateInput = Parameters<MessageRepositoryPort["create"]>[0];

/**
 * The part of a reply that reached its listener, as the conversation stores it: the composer's
 * citation markers removed, as they are from every stored answer, and the markdown kept. Empty when
 * the part held nothing but markers and whitespace.
 */
export const cutReplyContent = (text: string): string =>
  stripResidualCitationSyntax(canonicalizeUnsourcedMarkers(text)).trim();

/**
 * The assistant message that keeps the heard part of a reply a newer input cut off mid-stream,
 * marked cut short from the start with the channel's counts.
 */
export const cutReplyMessage = (input: {
  id: string;
  workspaceId: string;
  conversationId: string;
  content: string;
  heardCharacterCount: number;
  spokenCharacterCount: number;
}): MessageCreateInput & { id: string } => ({
  id: input.id,
  conversationId: input.conversationId,
  workspaceId: input.workspaceId,
  role: "assistant",
  content: input.content,
  interruption: {
    heardCharacterCount: input.heardCharacterCount,
    spokenCharacterCount: input.spokenCharacterCount,
    partial: true,
  },
});
