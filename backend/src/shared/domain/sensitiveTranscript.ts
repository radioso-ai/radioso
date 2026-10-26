import { REDACTED_VALUE } from "@radioso/conversation-contract";

/**
 * Which messages of a transcript may hold a sensitive routine value (#1543), and how a copy of
 * the transcript reads them.
 *
 * A turn run while a routine held a value for a sensitive slot records those slots' keys on both
 * of its messages' metadata: the visitor's message may hold the value as they typed it, and the
 * agent's reply may restate it. The transcript keeps both as they are, since it is the
 * conversation. Every copy of it that leaves — the rolling summary, a facet, an eval snapshot, an
 * operator notice's AI summary — reads such a message as withheld. The decision is structural,
 * from the routine's authored slots and the state the turn left, never from the message's words.
 */
export const SENSITIVE_SLOT_KEYS_METADATA_KEY = "sensitiveSlotKeys";

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** The sensitive slot keys a message's metadata records; empty for a message that holds none. */
export const sensitiveSlotKeysOf = (metadata: unknown): string[] => {
  const keys = isRecord(metadata) ? metadata[SENSITIVE_SLOT_KEYS_METADATA_KEY] : undefined;
  return Array.isArray(keys) ? keys.filter((key): key is string => typeof key === "string") : [];
};

export const carriesSensitiveValue = (metadata: unknown): boolean => sensitiveSlotKeysOf(metadata).length > 0;

/** The metadata fields that mark a message of such a turn; empty when the turn held none. */
export const sensitiveTurnMetadata = (sensitiveSlotKeys: readonly string[]): Record<string, string[]> =>
  sensitiveSlotKeys.length > 0 ? { [SENSITIVE_SLOT_KEYS_METADATA_KEY]: [...sensitiveSlotKeys] } : {};

/** A message's text as a copy of the transcript carries it. */
export const transcriptCopyContent = (message: { content: string; metadata?: unknown }): string =>
  carriesSensitiveValue(message.metadata) ? REDACTED_VALUE : message.content;
