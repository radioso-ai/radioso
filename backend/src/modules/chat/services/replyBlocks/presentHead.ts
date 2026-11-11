import type { AnswerSchemaExtension } from "../../../../shared/domain/answerSideChannel.js";
import { REPLY_BLOCK_LIMITS } from "../../contracts/replyBlocks.js";

/** The grounded answer's field that says which of the turn's images to show. */
export const PRESENT_FIELD = "present";

/** What the model returned in `present`: image handles in display order, and a caption. */
export interface PresentHead {
  images: string[];
  caption: string;
}

// The same on every turn that offers it: the handles are plain strings rather than a per-turn
// enum, so the schema stays in the provider's response-schema cache. The block builder drops
// any handle this turn did not offer.
const PRESENT_HEAD_EXTENSION: AnswerSchemaExtension = {
  properties: {
    [PRESENT_FIELD]: {
      type: "object",
      additionalProperties: false,
      required: ["images", "caption"],
      properties: {
        images: {
          type: "array",
          description: "Image handles from the Results' image lines, such as m3, in the order to show them. Empty to show none.",
          maxItems: REPLY_BLOCK_LIMITS.items,
          items: { type: "string" },
        },
        caption: {
          type: "string",
          description: "A short label for the images shown, in the answer's language.",
          minLength: 1,
          maxLength: REPLY_BLOCK_LIMITS.captionLength,
        },
      },
    },
  },
  required: [PRESENT_FIELD],
};

/**
 * The `present` field, written after `answer` so it adds nothing before the first visible
 * token: the model writes its answer first and picks the images after.
 */
export const presentHeadSchemaExtension = (): AnswerSchemaExtension => PRESENT_HEAD_EXTENSION;

/** The model's `present` field, or null when it is missing or malformed. */
export const readPresentHead = (extras: Record<string, unknown> | undefined): PresentHead | null => {
  const value = extras?.[PRESENT_FIELD];
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }
  const { images, caption } = value as Record<string, unknown>;
  if (!Array.isArray(images) || !images.every((image) => typeof image === "string") || typeof caption !== "string") {
    return null;
  }
  return { images, caption: caption.trim() };
};
