import type { MessageCreateInput } from "../../../db/repositories/messageRepository.js";
import { stripResidualCitationSyntax } from "./citationAnchorParser.js";
import { canonicalizeUnsourcedMarkers } from "./unsourcedMarkerCanonicalization.js";

/** Delimiters that come in pairs; an odd count means the cut left the last one open. */
const PAIRED_DELIMITERS = ["**", "__", "`"] as const;

/** The last `[` with no `]` after it: a link whose text the cut ran through. */
const UNCLOSED_LINK_TEXT = /\[(?=[^\]]*$)/u;

const withoutLast = (text: string, delimiter: string): string => {
  const at = text.lastIndexOf(delimiter);
  return text.slice(0, at) + text.slice(at + delimiter.length);
};

/**
 * Closes nothing and opens nothing at the cut: a link whose text the cut ran through loses its
 * `[`, and a bold, underline or code delimiter left without its pair is removed, so the stored
 * part renders as the words it holds. Structure only.
 */
const withoutOpenDelimiters = (text: string): string =>
  PAIRED_DELIMITERS.reduce(
    (repaired, delimiter) => (repaired.split(delimiter).length % 2 === 0 ? withoutLast(repaired, delimiter) : repaired),
    text.replace(UNCLOSED_LINK_TEXT, ""),
  );

/**
 * The part of a reply that reached its listener, as the conversation stores it: the composer's
 * citation markers removed, as they are from every stored answer, the markdown kept, and any
 * delimiter the cut left open removed. Empty when the part held nothing but markers and whitespace.
 */
export const cutReplyContent = (text: string): string =>
  withoutOpenDelimiters(stripResidualCitationSyntax(canonicalizeUnsourcedMarkers(text))).trim();

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
