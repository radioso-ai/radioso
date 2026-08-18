import {
  compactForBudget,
  compactRecord,
  MAX_ARRAY_ITEMS,
  MAX_STRING_CHARS,
  serializedLength,
  type TruncationEntry,
  withTruncation,
} from "../payloadCompaction.js";

const MAX_MESSAGES = 20;
export const CONVERSATION_PAYLOAD_CHAR_BUDGET = 28_000;
export const TURN_TRACE_PAYLOAD_CHAR_BUDGET = 96_000;

/** Chat's profile preserves recent turns and removes their debug payloads first. */
export const boundConversationPayload = (payload: Record<string, unknown>): Record<string, unknown> => {
  const source = { ...payload };
  const initialTruncation: TruncationEntry[] = [];
  if (Array.isArray(source.messages) && source.messages.length > MAX_MESSAGES) {
    initialTruncation.push({
      path: "$.messages",
      reason: "array_length",
      originalLength: source.messages.length,
      retainedLength: MAX_MESSAGES,
    });
    source.messages = source.messages.slice(-MAX_MESSAGES);
  }

  const compacted = compactRecord(source, { maxStringChars: MAX_STRING_CHARS, maxArrayItems: MAX_ARRAY_ITEMS }, initialTruncation);
  const messages = Array.isArray(compacted.value.messages)
    ? [...(compacted.value.messages as Array<Record<string, unknown>>)]
    : null;
  if (!messages) return withTruncation(compacted.value, compacted.truncation);

  const bounded = { ...compacted.value, messages };
  const truncation = [...compacted.truncation];
  while (serializedLength(withTruncation(bounded, truncation)) > CONVERSATION_PAYLOAD_CHAR_BUDGET) {
    const message = messages.find((candidate) => candidate.debug !== undefined);
    if (!message) break;
    const messageIndex = messages.indexOf(message);
    delete message.debug;
    message.debugOmitted = true;
    truncation.push({ path: `$.messages[${messageIndex}].debug`, reason: "budget_omitted" });
  }
  return withTruncation(bounded, truncation);
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
