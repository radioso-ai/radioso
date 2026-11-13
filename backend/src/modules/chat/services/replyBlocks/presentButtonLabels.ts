import type { ReplyBlock, ReplyButtonLabels } from "@radioso/conversation-contract";

import type { AnswerSchemaExtension } from "../../../../shared/domain/answerSideChannel.js";
import { renderPromptTemplate } from "../../../../shared/infra/prompts/promptLoader.js";

/**
 * The words on a block's buttons, for a client that draws them from the reply because it has no
 * copy of its own (`buttonLabels` in its `reply.blocks` capability), such as WhatsApp. The model
 * writes them in the `present` head beside the cards it picks, in the conversation's language.
 * Offered to no other client, so the head every other client is offered is unchanged.
 */

/** The longest label a messaging channel's button takes (WhatsApp's reply and URL buttons). */
export const BUTTON_LABEL_MAX_LENGTH = 20;

const label = (description: string) => ({
  type: "string",
  description,
  minLength: 1,
  maxLength: BUTTON_LABEL_MAX_LENGTH,
});

const BUTTON_LABEL_PROPERTIES = {
  selectLabel: label("The label of the button that picks one card, in the answer's language, at most 20 characters."),
  openLabel: label("The label of the button that opens a card's own page, in the answer's language, at most 20 characters."),
} as const;

/**
 * A `present` head that also asks for the button labels. Built once per head, so the schema is the
 * same on every turn that offers it and stays in the provider's response-schema cache.
 */
export const withButtonLabelFields = (extension: AnswerSchemaExtension, presentField: string): AnswerSchemaExtension => {
  const head = extension.beforeAnswer;
  const present = head?.properties[presentField] as { required: string[]; properties: Record<string, unknown> } | undefined;
  if (!head || !present) {
    return extension;
  }
  return {
    ...extension,
    beforeAnswer: {
      ...head,
      properties: {
        ...head.properties,
        [presentField]: {
          ...present,
          required: [...present.required, ...Object.keys(BUTTON_LABEL_PROPERTIES)],
          properties: { ...present.properties, ...BUTTON_LABEL_PROPERTIES },
        },
      },
    },
  };
};

/** A label as a button takes it: text of 1 to 20 characters on one line; anything else is no label. */
const readLabel = (value: unknown): string | undefined => {
  if (typeof value !== "string") {
    return undefined;
  }
  const trimmed = value.trim();
  const length = Array.from(trimmed).length;
  return length > 0 && length <= BUTTON_LABEL_MAX_LENGTH && !/[\r\n]/.test(trimmed) ? trimmed : undefined;
};

/** The labels the model wrote in its `present` head, or undefined when it wrote no usable one. */
export const readButtonLabels = (present: Record<string, unknown>): ReplyButtonLabels | undefined => {
  const select = readLabel(present.selectLabel);
  const open = readLabel(present.openLabel);
  return select || open ? { ...(select ? { select } : {}), ...(open ? { open } : {}) } : undefined;
};

/** The rules for the labels, appended to the `present` rules of a turn that asks for them. */
export const buttonLabelsPromptSection = (): string => renderPromptTemplate("chat/present-button-labels.md", {});

/** The presented blocks with the labels the reply wrote, or as they are when it wrote none. */
export const withButtonLabels = (blocks: ReplyBlock[], labels: ReplyButtonLabels | undefined): ReplyBlock[] =>
  labels && (labels.select || labels.open) ? blocks.map((block) => ({ ...block, buttonLabels: labels })) : blocks;
