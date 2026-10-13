import type { ChatStreamEvent, ChatTurnHandoffReason } from "../../chat/contracts/index.js";
import type { VoiceTurnOutcome } from "../domain.js";

/** The part of chat's closing `done` event the outcome is read from. */
type ChatReplyEnvelope = Pick<Extract<ChatStreamEvent, { type: "done" }>, "ownership" | "handoff">;

interface DerivedVoiceTurnOutcome {
  outcome: VoiceTurnOutcome;
  /** Why this turn handed the conversation to a person; null when it did not. */
  handoffReason: ChatTurnHandoffReason | null;
}

/**
 * The outcome of a turn from the reply envelope chat closed it with, by the `web` column of the
 * channel contract's outcome table:
 *
 * - The turn handed the conversation to a person (`human_owned`, not suppressed): `callback_requested`
 *   when the routine that handed off held a value for at least one of its declared slots, else
 *   `continue`. Holding a value is the whole test; a slot's key and value are never read.
 * - A person already owned the conversation when the turn started (`human_owned`, suppressed):
 *   `continue`, and the reply is chat's waiting message.
 * - Otherwise `continue`.
 */
export const deriveVoiceTurnOutcome = (envelope: ChatReplyEnvelope): DerivedVoiceTurnOutcome => {
  const handedOff = envelope.ownership?.state === "human_owned" && !envelope.ownership.suppressed;
  const handoff = handedOff ? envelope.handoff : undefined;
  if (!handoff) {
    return { outcome: { kind: "continue" }, handoffReason: null };
  }
  return {
    outcome: handoff.collectedSlotCount > 0
      ? { kind: "callback_requested", handoffReason: handoff.reason }
      : { kind: "continue" },
    handoffReason: handoff.reason,
  };
};
