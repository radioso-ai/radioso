const MAX_STRING_CHARS = 500;
const MAX_ARRAY_ITEMS = 40;
const MAX_MESSAGES = 20;
// Keeps the serialized tool result safely inside the runtime's tool-token
// budget (spec 104 SC-006: family readers are size-bounded, never raw dumps).
export const CONVERSATION_PAYLOAD_CHAR_BUDGET = 28_000;

const truncateString = (value: string): string =>
  value.length > MAX_STRING_CHARS ? `${value.slice(0, MAX_STRING_CHARS)}…` : value;

const compactValue = (value: unknown): unknown => {
  if (typeof value === "string") return truncateString(value);
  if (Array.isArray(value)) return value.slice(0, MAX_ARRAY_ITEMS).map(compactValue);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value as Record<string, unknown>).map(([key, entry]) => [key, compactValue(entry)]));
  }
  return value;
};

const serializedLength = (value: unknown): number => JSON.stringify(value).length;

/**
 * Bounds a conversation history payload for model consumption. Debug/trace
 * envelopes dominate the size, so after generic compaction they are dropped
 * from the oldest messages first (marked `debugOmitted`), keeping the most
 * recent turns fully inspectable.
 */
export const boundConversationPayload = (payload: Record<string, unknown>): Record<string, unknown> => {
  const source = { ...payload };
  // Newest messages matter most for troubleshooting; keep them before the
  // generic array cap can discard them from the head.
  if (Array.isArray(source.messages) && source.messages.length > MAX_MESSAGES) {
    source.messages = source.messages.slice(-MAX_MESSAGES);
  }
  const compact = compactValue(source) as Record<string, unknown>;
  if (serializedLength(compact) <= CONVERSATION_PAYLOAD_CHAR_BUDGET) return compact;

  const messages = Array.isArray(compact.messages) ? [...(compact.messages as Array<Record<string, unknown>>)] : null;
  if (!messages) return compact;

  const bounded = { ...compact, messages };
  for (const message of bounded.messages) {
    if (serializedLength(bounded) <= CONVERSATION_PAYLOAD_CHAR_BUDGET) break;
    if (message.debug !== undefined) {
      delete message.debug;
      message.debugOmitted = true;
    }
  }
  return bounded;
};
