import type { ConversationTrace } from "@radioso/conversation-contract";

import type { MessageCreateInput } from "../../../../db/repositories/messageRepository.js";
import { sensitiveTurnMetadata } from "../../../../shared/domain/sensitiveTranscript.js";
import type { ChatRoutineTurnReporter } from "../../contracts/routineTurnState.js";
import type { CapturedRoutineTransition } from "./deferredRoutineStore.js";

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const isConsentRejection = (value: unknown): value is { key: string } =>
  isRecord(value) && value.reason === "consent" && typeof value.key === "string";

/**
 * The slots whose value the turn's routine kept out because their consent was not granted
 * (#1544), read from its routine trace. The message stated the value all the same, and a consent
 * covers only sensitive slots, so it is marked as if the value had been captured.
 */
const consentWithheldSlotKeys = (trace: ConversationTrace | undefined): string[] =>
  (trace?.stages ?? []).flatMap((stage) => {
    const payload = stage.subTrace?.namespace === "routine" ? stage.subTrace.payload : undefined;
    const steps = isRecord(payload) && Array.isArray(payload.steps) ? payload.steps : [];
    return steps.flatMap((step) => (isRecord(step) && Array.isArray(step.rejectedSlots) ? step.rejectedSlots : []))
      .filter(isConsentRejection)
      .map((rejected) => rejected.key);
  });

/**
 * The sensitive slots (#1543) the routine this turn saved holds a value for, those the step the
 * turn started on asks for (the visitor's message answers it, stored or not), and those whose
 * value the routine kept out for want of consent (#1544). Both messages of such a turn are
 * marked, so every copy of the transcript that leaves reads them as withheld.
 */
export const sensitiveSlotKeysForTurn = (input: {
  routineStateTransition?: CapturedRoutineTransition | null;
  routineReporter?: ChatRoutineTurnReporter;
  engineTrace?: ConversationTrace;
}): string[] => {
  const { routineReporter: reporter, routineStateTransition: transition } = input;
  const held = reporter && transition?.kind === "save" ? reporter.sensitiveSlotKeysHeld(transition.state) : [];
  const awaited = reporter && transition?.startedFrom ? reporter.sensitiveSlotKeysAwaited(transition.startedFrom) : [];
  return [...new Set([...held, ...awaited, ...consentWithheldSlotKeys(input.engineTrace)])];
};

/** The turn's presentation with its reply marked as carrying those sensitive slots; unchanged when there are none. */
export const withSensitiveTurnMarker = <TPresentation extends { assistantMessage: MessageCreateInput }>(
  presentation: TPresentation,
  sensitiveSlotKeys: readonly string[],
): TPresentation =>
  sensitiveSlotKeys.length === 0
    ? presentation
    : {
        ...presentation,
        assistantMessage: {
          ...presentation.assistantMessage,
          metadata: { ...presentation.assistantMessage.metadata, ...sensitiveTurnMetadata(sensitiveSlotKeys) },
        },
      };
