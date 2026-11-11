import type { MessageCreateInput, UserMessageInputMetadata } from "../../../db/repositories/messageRepository.js";
import type { ReferenceTimeZone } from "../../../shared/domain/referenceTimeZone.js";
import { sensitiveTurnMetadata } from "../../../shared/domain/sensitiveTranscript.js";
import { visitorTimeZoneTurnMetadata } from "./turnReferenceTimeZone.js";
import type { RoutineInvocation } from "../contracts/routineInvocation.js";

/**
 * The recorded form of a tool call: Activity and the Inbox render it as a tool-call block
 * from this, while the message content stays the rendered text a person would have typed.
 */
export const routineInvocationInputMetadata = (invocation: RoutineInvocation): UserMessageInputMetadata => ({
  method: "routine_invocation",
  routine: { toolName: invocation.toolName, input: { ...invocation.input } },
});

/**
 * What a visitor's message records about its own turn, as the fields the message is created
 * with: how it was entered, the routine slots that were sensitive while it was typed (#1543), and
 * the zone the visitor's client reported. The input method is always passed as `inputMetadata` too:
 * a store that keeps `metadata` and `inputMetadata` apart (the in-memory replay store, a test fake)
 * would otherwise lose it once anything else is recorded, and the turn's input event with it. The
 * Postgres store writes `metadata` when it is present, which already holds the input method.
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
    ? { metadata: { ...input.inputMetadata, ...turnMetadata }, inputMetadata: input.inputMetadata }
    : { inputMetadata: input.inputMetadata };
};
