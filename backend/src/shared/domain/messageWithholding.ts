import { REDACTED_VALUE } from "@radioso/conversation-contract";

/**
 * Withholding a message: its text is replaced where Radioso keeps it, while the message itself
 * stays in its conversation. A consent withdrawal (#1544) withholds the messages that carried the
 * values the consent covered.
 *
 * The message row keeps the redaction marker as its text and records why and when under
 * `withheld`. Other modules keep their own copies of a message's text: the email channel the mail
 * it came in as, the audit trail the turn that answered it, a photo the message attached. Each such
 * module implements a {@link MessageCopyWithholder}; application composition binds every one to the
 * withholding's transaction.
 */

/** The text a withheld message keeps: the same marker every copy of the transcript reads a sensitive message as. */
export const WITHHELD_MESSAGE_TEXT = REDACTED_VALUE;

/** The metadata key under which a withheld message records why and when it was withheld. */
export const WITHHELD_METADATA_KEY = "withheld";

export type MessageWithholdingReason = "consent_withdrawn";

/** Why and when a message was withheld. `at` is a UTC ISO time with milliseconds. */
export interface MessageWithholding {
  reason: MessageWithholdingReason;
  at: string;
}

/**
 * The metadata fields that repeat a message's text or carry what it attached: a reply's answer
 * segments and chips, the prompt it was composed from, the photos a visitor's message carried. A
 * withheld message drops them with its text.
 */
export const WITHHELD_MESSAGE_COPY_FIELDS = ["answerSegments", "composedInstructions", "suggestions", "imageInput"] as const;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** The withholding a message's metadata records; undefined for a message that is not withheld or whose marker does not read. */
export const messageWithholdingOf = (metadata: unknown): MessageWithholding | undefined => {
  const marker = isRecord(metadata) ? metadata[WITHHELD_METADATA_KEY] : undefined;
  return isRecord(marker) && marker.reason === "consent_withdrawn" && typeof marker.at === "string"
    ? { reason: marker.reason, at: marker.at }
    : undefined;
};

/** The messages one withholding covers, all in one conversation. */
export interface WithheldMessages {
  readonly workspaceId: string;
  readonly conversationId: string;
  readonly messageIds: readonly string[];
}

/** One module's copies of message text, withheld with the messages they copy, bound to the withholding's transaction. */
export interface MessageCopyWithholder {
  /** The owning module, named with its row count in the withholding's audit event. */
  readonly owner: string;
  /** Withholds the owner's copies of `messages` and returns how many rows it changed or removed. */
  withhold(messages: WithheldMessages): Promise<number>;
}
