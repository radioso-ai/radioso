import type { AnswerSchemaExtension } from "../../../../shared/domain/answerSideChannel.js";
import { REPLY_BLOCK_LIMITS } from "../../contracts/replyBlocks.js";

/** The grounded answer's field that says which of the turn's images to show. */
export const PRESENT_FIELD = "present";

/** Whether the visitor can pick one of the items shown: the model's call, `none` unless it says otherwise. */
export type PresentSelection = "none" | "single";

/** What the model returned in `present`: image handles in display order, a caption, and whether one can be picked. */
export interface PresentHead {
  images: string[];
  caption: string;
  selection: PresentSelection;
}

/** The `selection` field of the `present` head: whether the visitor can pick one of the pictures shown. */
const PRESENT_SELECTION_PROPERTY = {
  type: "string",
  enum: ["none", "single"],
  description: "single when the visitor is to pick one of the items shown; none when they are only shown.",
} as const;

/** The model's `selection`, or `none` when it is missing or not one the schema offers. */
const readPresentSelection = (value: unknown): PresentSelection => (value === "single" ? "single" : "none");

// The same on every turn that offers it: the handles are plain strings rather than a per-turn
// enum, so the schema stays in the provider's response-schema cache. The block builder drops
// any handle this turn did not offer.
const PRESENT_HEAD_FIELDS = {
  properties: {
    [PRESENT_FIELD]: {
      type: "object",
      additionalProperties: false,
      required: ["images", "caption", "selection"],
      properties: {
        images: {
          type: "array",
          description: "Before you write the answer: image handles from the Results' image lines, such as m3, in the order to show them. Empty to show none.",
          maxItems: REPLY_BLOCK_LIMITS.items,
          items: { type: "string" },
        },
        caption: {
          type: "string",
          description: "A short label for the images shown, in the answer's language.",
          minLength: 1,
          maxLength: REPLY_BLOCK_LIMITS.captionLength,
        },
        selection: PRESENT_SELECTION_PROPERTY,
      },
    },
  },
  required: [PRESENT_FIELD],
};

const PRESENT_HEAD_EXTENSION: AnswerSchemaExtension = {
  properties: {},
  required: [],
  beforeAnswer: PRESENT_HEAD_FIELDS,
};

/**
 * The `present` field, written ahead of `answer`: the model decides which pictures to show
 * first, then writes the answer around them. Written after the answer, a lead that already
 * listed the items left no reason to show them (#1763).
 */
export const presentHeadSchemaExtension = (): AnswerSchemaExtension => PRESENT_HEAD_EXTENSION;

/** The model's `present` field, or null when it is missing or malformed. */
export const readPresentHead = (extras: Record<string, unknown> | undefined): PresentHead | null => {
  const value = extras?.[PRESENT_FIELD];
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }
  const { images, caption, selection } = value as Record<string, unknown>;
  if (!Array.isArray(images) || !images.every((image) => typeof image === "string") || typeof caption !== "string") {
    return null;
  }
  return { images, caption: caption.trim(), selection: readPresentSelection(selection) };
};
