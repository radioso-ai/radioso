import type { MessageRecord } from "../../../db/repositories/messageRepository.js";
import { loadPromptTemplate, renderPromptTemplate } from "../../../shared/infra/prompts/promptLoader.js";
import { turnTextCarriesPhotos } from "../../visitorImages/public.js";

/**
 * Whether the visitor's message carries photos: the photos its stored metadata records, or, for a
 * message that comes as text alone (an eval case, a replay), the photo blocks in its text.
 */
export const turnCarriesPhotos = (message: Pick<MessageRecord, "content" | "inputMetadata">): boolean =>
  (message.inputMetadata?.imageInput?.images.length ?? 0) > 0 || turnTextCarriesPhotos(message.content);

/**
 * The reply that renders the rules, which decides the second part of a reply to a photo the
 * evidence does not answer: the grounded answer commits an answer or a decline, the focused
 * decline redirects, and the direct and skill-result replies offer or ask.
 */
type AttachedPhotoReply = "grounded" | "decline" | "reply";

/**
 * The rules for a turn that carries photos: what the `<attached_photo>` blocks are, what a request
 * for something like a photo asks, and the reply's order when the evidence does not answer it.
 * Rendered only on a photo turn, so every other prompt reads exactly as it did.
 */
export const attachedPhotoRules = (reply: AttachedPhotoReply): string =>
  renderPromptTemplate("chat/attached-photos.md", {
    second_part: loadPromptTemplate(`chat/attached-photos-${reply}.md`),
  });
