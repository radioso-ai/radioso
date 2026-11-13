import type { AnswerSchemaExtension } from "../../../../shared/domain/answerSideChannel.js";
import { REPLY_BLOCK_LIMITS } from "../../contracts/replyBlocks.js";
import { PRESENT_FIELD, PRESENT_SELECTION_PROPERTY, readPresentSelection, type PresentSelection } from "./presentHead.js";

/**
 * What the model returned in `present` for a skill's records: the handles to show, in order, and
 * where in each record its card's fields are, as JSON Pointers. The model points; it never writes
 * a title, an address or any other value a card shows.
 */
export interface RecordPresentHead {
  records: string[];
  fields: {
    title: string;
    subtitle: string | null;
    image: string | null;
    link: string | null;
  };
  caption: string;
  selection: PresentSelection;
}

const pointer = (description: string, nullable: boolean) => ({
  type: nullable ? ["string", "null"] : "string",
  description,
});

// The same on every turn that offers it: handles and pointers are plain strings rather than a
// per-turn enum, so the schema stays in the provider's response-schema cache. The block builder
// drops any handle this turn did not offer and any pointer that resolves to nothing usable.
const RECORD_PRESENT_HEAD_EXTENSION: AnswerSchemaExtension = {
  properties: {},
  required: [],
  beforeAnswer: {
    properties: {
      [PRESENT_FIELD]: {
        type: "object",
        additionalProperties: false,
        required: ["records", "fields", "caption", "selection"],
        properties: {
          records: {
            type: "array",
            description: "Before you write the answer: record handles, such as r3, in the order to show them as cards. Empty to show none.",
            maxItems: REPLY_BLOCK_LIMITS.items,
            items: { type: "string" },
          },
          fields: {
            type: "object",
            additionalProperties: false,
            required: ["title", "subtitle", "image", "link"],
            properties: {
              title: pointer("JSON Pointer, within each shown record, to the text that names it, such as /name.", false),
              subtitle: pointer("JSON Pointer, within each shown record, to one short line about it, or null.", true),
              image: pointer("JSON Pointer, within each shown record, to its picture's address, or null when the records have none.", true),
              link: pointer("JSON Pointer, within each shown record, to the address of its own page, or null.", true),
            },
          },
          caption: {
            type: "string",
            description: "A short label for the cards shown, in the answer's language.",
            minLength: 1,
            maxLength: REPLY_BLOCK_LIMITS.captionLength,
          },
          selection: PRESENT_SELECTION_PROPERTY,
        },
      },
    },
    required: [PRESENT_FIELD],
  },
};

/** The `present` field for a skill's records, written ahead of `answer`. */
export const recordPresentHeadSchemaExtension = (): AnswerSchemaExtension => RECORD_PRESENT_HEAD_EXTENSION;

const nullableString = (value: unknown): value is string | null => value === null || typeof value === "string";

/** The model's `present` field, or null when it is missing or malformed. */
export const readRecordPresentHead = (extras: Record<string, unknown> | undefined): RecordPresentHead | null => {
  const value = extras?.[PRESENT_FIELD];
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }
  const { records, fields, caption, selection } = value as Record<string, unknown>;
  if (!Array.isArray(records) || !records.every((record) => typeof record === "string") || typeof caption !== "string") {
    return null;
  }
  if (!fields || typeof fields !== "object" || Array.isArray(fields)) {
    return null;
  }
  const { title, subtitle, image, link } = fields as Record<string, unknown>;
  if (typeof title !== "string" || !nullableString(subtitle) || !nullableString(image) || !nullableString(link)) {
    return null;
  }
  return { records, fields: { title, subtitle, image, link }, caption: caption.trim(), selection: readPresentSelection(selection) };
};
