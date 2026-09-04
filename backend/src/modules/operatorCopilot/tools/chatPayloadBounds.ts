import {
  compactForBudget,
  compactRecord,
  MAX_ARRAY_ITEMS,
  MAX_STRING_CHARS,
  serializedLength,
  type TruncationEntry,
  withTruncation,
} from "../payloadCompaction.js";
import { copilotPayloadCharBudget } from "../turnBudget.js";

const MAX_MESSAGES = 20;

/**
 * A transcript read is context for a question, not the question itself, so it takes the smaller
 * share and leaves the turn room to follow up on what it found.
 */
export const CONVERSATION_PAYLOAD_CHAR_BUDGET = copilotPayloadCharBudget(1 / 3);

/**
 * A turn trace is usually the whole point of the turn that reads it, so it takes the largest share
 * a single read may take — half, which still leaves as much again for corroborating reads and the
 * answer itself.
 */
export const TURN_TRACE_PAYLOAD_CHAR_BUDGET = copilotPayloadCharBudget(1 / 2);

const DEFAULT_PROFILE = { maxStringChars: MAX_STRING_CHARS, maxArrayItems: MAX_ARRAY_ITEMS };

/**
 * Chat's profile preserves recent turns and removes their debug payloads first.
 *
 * Dropping debug envelopes is a preference, not the bound: it says which content this reader would
 * rather lose, and it runs out once no message carries one. Whatever survives that preference is
 * handed to `compactForBudget`, which is what actually holds the payload inside the budget — a
 * conversation can carry arbitrarily large content outside its debug envelopes.
 */
export const boundConversationPayload = (payload: Record<string, unknown>): Record<string, unknown> => {
  const source = { ...payload };
  const truncation: TruncationEntry[] = [];
  if (Array.isArray(source.messages) && source.messages.length > MAX_MESSAGES) {
    truncation.push({
      path: "$.messages",
      reason: "array_length",
      originalLength: source.messages.length,
      retainedLength: MAX_MESSAGES,
    });
    source.messages = source.messages.slice(-MAX_MESSAGES);
  }

  // Copied before mutating: the caller's message objects are not this function's to edit.
  const messages = Array.isArray(source.messages)
    ? (source.messages as Array<Record<string, unknown>>).map((message) => ({ ...message }))
    : null;
  if (messages) {
    source.messages = messages;
    while (
      serializedLength(withTruncation(compactRecord(source, DEFAULT_PROFILE, truncation).value, truncation))
        > CONVERSATION_PAYLOAD_CHAR_BUDGET
    ) {
      const messageIndex = messages.findIndex((candidate) => candidate.debug !== undefined);
      if (messageIndex === -1) break;
      delete messages[messageIndex].debug;
      messages[messageIndex].debugOmitted = true;
      truncation.push({ path: `$.messages[${messageIndex}].debug`, reason: "budget_omitted" });
    }
  }

  const compacted = compactForBudget(source, [DEFAULT_PROFILE], CONVERSATION_PAYLOAD_CHAR_BUDGET, truncation);
  return withTruncation(compacted.value, compacted.truncation);
};

/** Chat's trace profile gives one diagnostic turn a materially larger budget. */
export const boundTurnTracePayload = (payload: Record<string, unknown>): Record<string, unknown> => {
  const compacted = compactForBudget(
    payload,
    [
      { maxStringChars: 6_000, maxArrayItems: 160 },
      { maxStringChars: 3_000, maxArrayItems: 120 },
      { maxStringChars: 1_500, maxArrayItems: 80 },
      { maxStringChars: MAX_STRING_CHARS, maxArrayItems: MAX_ARRAY_ITEMS },
    ],
    TURN_TRACE_PAYLOAD_CHAR_BUDGET,
  );
  return withTruncation(compacted.value, compacted.truncation);
};
