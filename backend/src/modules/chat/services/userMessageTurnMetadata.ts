import type { MessageCreateInput, UserMessageInputMetadata } from "../../../db/repositories/messageRepository.js";
import type { ReferenceTimeZone } from "../../../shared/domain/referenceTimeZone.js";
import { sensitiveTurnMetadata } from "../../../shared/domain/sensitiveTranscript.js";
import { visitorTimeZoneTurnMetadata } from "./turnReferenceTimeZone.js";

/**
 * What a visitor's message records about its own turn, as the fields the message is created
 * with: how it was entered, the routine slots that were sensitive while it was typed (#1543), and
 * the zone the visitor's client reported. A message with nothing beyond its input method keeps the
 * plain `inputMetadata` shape.
 */
export const userMessageTurnMetadata = (input: {
  inputMetadata?: UserMessageInputMetadata;
  sensitiveSlotKeys: readonly string[];
  referenceTimeZone: ReferenceTimeZone;
}): Pick<MessageCreateInput, "metadata" | "inputMetadata"> => {
  const turnMetadata = {
    ...sensitiveTurnMetadata(input.sensitiveSlotKeys),
    ...visitorTimeZoneTurnMetadata(input.referenceTimeZone),
  };
  return Object.keys(turnMetadata).length > 0
    ? { metadata: { ...input.inputMetadata, ...turnMetadata } }
    : { inputMetadata: input.inputMetadata };
};
