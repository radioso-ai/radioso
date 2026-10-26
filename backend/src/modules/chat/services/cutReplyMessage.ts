import type { MessageCreateInput } from "../../../db/repositories/messageRepository.js";
import { withoutUnclosedMarkdownDelimiters } from "../../../shared/text/unclosedMarkdownDelimiters.js";
import { stripResidualCitationSyntax } from "./citationAnchorParser.js";
import { canonicalizeUnsourcedMarkers } from "./unsourcedMarkerCanonicalization.js";

/**
 * The part of a reply that reached its listener, as the conversation stores it: the composer's
 * citation markers removed, as they are from every stored answer, the markdown kept, and any
 * delimiter the cut left open removed. Empty when the part held nothing but markers and whitespace.
 */
export const cutReplyContent = (text: string): string =>
  withoutUnclosedMarkdownDelimiters(stripResidualCitationSyntax(canonicalizeUnsourcedMarkers(text))).trim();

/**
 * The assistant message that keeps the heard part of a reply a newer input cut off mid-stream,
 * marked cut short from the start with the channel's counts. `metadata` carries the turn's
 * sensitive-value marker (#1543) when its visitor message had one.
 */
export const cutReplyMessage = (input: {
  id: string;
  workspaceId: string;
  conversationId: string;
  content: string;
  heardCharacterCount: number;
  spokenCharacterCount: number;
  metadata?: Record<string, unknown>;
}): MessageCreateInput & { id: string } => ({
  id: input.id,
  conversationId: input.conversationId,
  workspaceId: input.workspaceId,
  role: "assistant",
  content: input.content,
  ...(input.metadata && Object.keys(input.metadata).length > 0 ? { metadata: input.metadata } : {}),
  interruption: {
    heardCharacterCount: input.heardCharacterCount,
    spokenCharacterCount: input.spokenCharacterCount,
    partial: true,
  },
});
