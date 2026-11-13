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
 *
 * A withholding finds a message two ways: by the sensitive marker a turn records on it, and by the
 * erased values themselves, so a message the visitor wrote before any routine asked, or a reply
 * that repeated a value after the routine ended, is found as well.
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
 * segments, chips and reply blocks (the picture cards it showed), the prompt it was composed from,
 * the photos a visitor's message carried. A withheld message drops them with its text, so no
 * history read presents them.
 */
export const WITHHELD_MESSAGE_COPY_FIELDS = ["answerSegments", "composedInstructions", "suggestions", "blocks", "imageInput"] as const;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** The withholding a message's metadata records; undefined for a message that is not withheld or whose marker does not read. */
export const messageWithholdingOf = (metadata: unknown): MessageWithholding | undefined => {
  const marker = isRecord(metadata) ? metadata[WITHHELD_METADATA_KEY] : undefined;
  return isRecord(marker) && marker.reason === "consent_withdrawn" && typeof marker.at === "string"
    ? { reason: marker.reason, at: marker.at }
    : undefined;
};

/** The messages one withholding covers, all in one conversation, and the values they carried. */
export interface WithheldMessages {
  readonly workspaceId: string;
  readonly conversationId: string;
  readonly messageIds: readonly string[];
  /**
   * The values the withholding erases, as `matchableValueTexts` reads them. A copy whose own text
   * holds one is withheld too, though the message it came from was not, as a coverage request
   * framed with an earlier turn's words.
   */
  readonly valueTexts: readonly string[];
}

/** One module's copies of message text, withheld with the messages they copy, bound to the withholding's transaction. */
export interface MessageCopyWithholder {
  /** The owning module, named with its row count in the withholding's audit event. */
  readonly owner: string;
  /** Withholds the owner's copies of `messages` and returns how many rows it changed or removed. */
  withhold(messages: WithheldMessages): Promise<number>;
}

/**
 * What one withholding reaches in a conversation: each message whose sensitive marker names one of
 * `slotKeys`, and each whose text contains one of `valueTexts` (`containsValueText`'s rule), visitor
 * or agent, whenever it was written.
 */
export interface MessageWithholdingTarget {
  readonly workspaceId: string;
  readonly conversationId: string;
  readonly slotKeys: readonly string[];
  readonly valueTexts: readonly string[];
  /** When the consent was withdrawn, recorded on each message. */
  readonly at: Date;
  /** Only among these messages; any of the conversation's when absent. */
  readonly among?: readonly string[];
}

/** A withholding's writes, bound to one transaction: the message rows, and every module's copies. */
export interface MessageWithholdingScope {
  messages: {
    /** Withholds the messages `target` reaches and returns their ids. */
    withhold(target: MessageWithholdingTarget): Promise<string[]>;
  };
  messageCopies: readonly MessageCopyWithholder[];
}

/** The messages a withholding reached, and the rows each module's copies changed, by owner. */
interface MessageWithholdingResult {
  messageIds: string[];
  rowsByOwner: Record<string, number>;
}

/**
 * Withholds what `target` reaches: the messages first, then every module's copies of them and of
 * the values. The one sequence a consent withdrawal and a turn that raced it both run.
 */
export const withholdMessagesWithCopies = async (
  scope: MessageWithholdingScope,
  target: MessageWithholdingTarget,
): Promise<MessageWithholdingResult> => {
  const messageIds = await scope.messages.withhold(target);
  const rowsByOwner: Record<string, number> = {};
  if (messageIds.length === 0 && target.valueTexts.length === 0) {
    return { messageIds, rowsByOwner };
  }
  const withheld: WithheldMessages = {
    workspaceId: target.workspaceId,
    conversationId: target.conversationId,
    messageIds,
    valueTexts: target.valueTexts,
  };
  for (const copies of scope.messageCopies) {
    rowsByOwner[copies.owner] = (rowsByOwner[copies.owner] ?? 0) + await copies.withhold(withheld);
  }
  return { messageIds, rowsByOwner };
};
