import type { ConversationTrace } from "@radioso/conversation-contract";

import type { MessageCreateInput, MessageRecord } from "../../../../db/repositories/messageRepository.js";
import { containsValueText, matchableValueTexts, sensitiveTurnMetadata } from "../../../../shared/domain/sensitiveTranscript.js";
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
const routinePayloads = (trace: ConversationTrace | undefined): Record<string, unknown>[] =>
  (trace?.stages ?? []).flatMap((stage) => {
    const payload = stage.subTrace?.namespace === "routine" ? stage.subTrace.payload : undefined;
    return isRecord(payload) ? [payload] : [];
  });

const consentWithheldSlotKeys = (trace: ConversationTrace | undefined): string[] =>
  routinePayloads(trace).flatMap((payload) => {
    const steps = Array.isArray(payload.steps) ? payload.steps : [];
    return steps.flatMap((step) => (isRecord(step) && Array.isArray(step.rejectedSlots) ? step.rejectedSlots : []))
      .filter(isConsentRejection)
      .map((rejected) => rejected.key);
  });

/** The covered slots the turn filled while they could take their value from earlier messages (#1544), read from its routine trace. */
const earlierMessageSlotKeys = (trace: ConversationTrace | undefined): string[] =>
  routinePayloads(trace).flatMap((payload) =>
    (Array.isArray(payload.earlierMessageSlotKeys) ? payload.earlierMessageSlotKeys : []).filter((key): key is string => typeof key === "string"));

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

/** An earlier visitor message the turn marks as carrying sensitive slots. */
interface SensitiveEarlierMessage {
  id: string;
  sensitiveSlotKeys: string[];
}

/** What a turn's transaction marks and checks among the visitor's messages (#1543, #1544). */
export interface SensitiveMessageMarks {
  /** The turn's visitor message, checked with its reply against a consent withdrawn while the turn ran. */
  visitorMessageId?: string;
  /**
   * The turn's visitor message when its routine holds a sensitive slot value (#1543): marked with
   * those slots' keys in the turn's transaction, and any facet already extracted from it removed.
   */
  sensitiveVisitorMessage?: { id: string; sensitiveSlotKeys: readonly string[] };
  /** Earlier visitor messages the turn read a covered value from: their marker gains these keys, and their facets go. */
  sensitiveEarlierMessages?: readonly SensitiveEarlierMessage[];
}

/**
 * The visitor messages the turn read from before its routine started: the routine's own turns
 * marked any that stated a covered value (held, asked for, or kept out for want of consent), so
 * only these can be an unmarked source. All of them when the run's first message is unknown; none
 * when it is older than what the turn read.
 */
const readBeforeRoutine = (read: readonly MessageRecord[], startedMessageId: string | undefined): readonly MessageRecord[] => {
  if (!startedMessageId) return read;
  const start = read.findIndex((message) => message.id === startedMessageId);
  return start < 0 ? [] : read.slice(0, start);
};

/**
 * The earlier visitor messages a turn marks (#1544). When the step filled a covered slot from what
 * the visitor said earlier (the consent's earlier-message rule), the value may come from any
 * visitor message the turn read: those that state it (`containsValueText`) are marked with the
 * slot. When none states it as stored, a value the rule does not search for
 * (`matchableValueTexts`), or one the reading put in other words, the ones the turn read from
 * before the routine started are marked, since any may be its source. Only on such a fill, so a
 * normal turn marks nothing earlier; the turn's own messages carry the turn marker.
 */
const sensitiveEarlierMessages = (input: {
  history: readonly MessageRecord[];
  visitorMessage: { content: string };
  routineStateTransition?: CapturedRoutineTransition | null;
  engineTrace?: ConversationTrace;
}): SensitiveEarlierMessage[] => {
  const state = input.routineStateTransition?.kind === "save" ? input.routineStateTransition.state : null;
  const keys = state ? [...new Set(earlierMessageSlotKeys(input.engineTrace))] : [];
  const read = input.history.filter((message) => message.role === "user");
  const marks = new Map<string, Set<string>>();
  for (const key of keys) {
    const texts = matchableValueTexts([state?.variables[key]]);
    const stating = read.filter((message) => containsValueText(message.content, texts));
    const sources = stating.length > 0 || containsValueText(input.visitorMessage.content, texts)
      ? stating
      : readBeforeRoutine(read, state?.startedMessageId);
    for (const message of sources) {
      marks.set(message.id, (marks.get(message.id) ?? new Set()).add(key));
    }
  }
  return [...marks].map(([id, slotKeys]) => ({ id, sensitiveSlotKeys: [...slotKeys] }));
};

/**
 * What a turn's transaction marks and checks among the visitor's messages: the turn's own, with
 * the turn's sensitive slots (#1543), the earlier ones the turn read a covered value from (#1544),
 * and its id, which a consent withdrawn while the turn ran is checked against.
 */
export const sensitiveMessageMarks = (input: {
  session: { userMessage: { id: string; content: string }; history: readonly MessageRecord[] };
  sensitiveSlotKeys: readonly string[];
  routineStateTransition?: CapturedRoutineTransition | null;
  engineTrace?: ConversationTrace;
}): SensitiveMessageMarks => {
  const { userMessage } = input.session;
  const earlier = sensitiveEarlierMessages({ ...input, history: input.session.history, visitorMessage: userMessage });
  return {
    visitorMessageId: userMessage.id,
    ...(input.sensitiveSlotKeys.length > 0 ? { sensitiveVisitorMessage: { id: userMessage.id, sensitiveSlotKeys: input.sensitiveSlotKeys } } : {}),
    ...(earlier.length > 0 ? { sensitiveEarlierMessages: earlier } : {}),
  };
};
