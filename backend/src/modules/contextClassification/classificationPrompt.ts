import type { ContextVariable } from "../context-variables/public.js";
import type { JsonSchemaResponseFormat } from "../../shared/infra/llm/providerTypes.js";
import { loadPromptTemplate } from "../../shared/infra/prompts/promptLoader.js";
import type { ConversationExcerpt } from "./contracts.js";

/**
 * Identity of the classification recipe. Every value the classifier writes names it as its writer
 * reference, so a value can be traced to the recipe that chose it.
 */
export const CONTEXT_CLASSIFICATION_PROMPT_VERSION = "context-classification/1";

/** The excerpt's bounds: the visitor's latest messages, each cut to a length. */
export const CLASSIFICATION_EXCERPT_MAX_MESSAGES = 6;
export const CLASSIFICATION_EXCERPT_MAX_MESSAGE_CHARS = 1_000;
const CLASSIFICATION_SUMMARY_MAX_CHARS = 4_000;

/**
 * The input budget holds the largest prompt authoring allows: eight attributes of fifty options,
 * every name, label and description at its length limit, with the longest excerpt. The model
 * pipeline estimates the budget per character, one token for a non-Latin code point and a quarter
 * for an ASCII one, so the worst case is text the prompt's JSON escapes (`<` becomes `\u003c`, six
 * ASCII characters): about 305,000 tokens. CJK at every limit is about 210,000, ASCII about 67,000;
 * a typical agent sends a few thousand. `context-classification.test.ts` builds the worst case.
 */
export const CLASSIFICATION_MAX_INPUT_TOKENS = 320_000;
export const CLASSIFICATION_MAX_OUTPUT_TOKENS = 400;

/** The variable's options the classifier may pick; an archived option is never offered. */
export const activeOptionKeys = (variable: Pick<ContextVariable, "options">): string[] =>
  (variable.options ?? []).filter((option) => !option.archived).map((option) => option.key);

/** Fields are positional, so a variable's name never has to be a valid schema property. */
const fieldFor = (index: number): string => `attribute_${index + 1}`;

/** A strict schema: one field per variable, each an enum of its active keys or null. */
export const classificationResponseFormat = (variables: readonly ContextVariable[]): JsonSchemaResponseFormat => ({
  type: "json_schema",
  name: "context_classification",
  strict: true,
  schema: {
    type: "object",
    additionalProperties: false,
    required: variables.map((_, index) => fieldFor(index)),
    properties: Object.fromEntries(variables.map((variable, index) => [
      fieldFor(index),
      { type: ["string", "null"], enum: [...activeOptionKeys(variable), null] },
    ])),
  },
});

const HTML_SENSITIVE_CHARACTERS: Record<string, string> = { "<": "\\u003c", ">": "\\u003e", "&": "\\u0026" };

/** JSON with the characters that could close a tag escaped, so no text can leave its envelope. */
const serializeEnvelope = (value: unknown): string =>
  JSON.stringify(value, null, 2).replace(/[<>&]/g, (character) => HTML_SENSITIVE_CHARACTERS[character]);

const describeOption = (option: NonNullable<ContextVariable["options"]>[number]): string =>
  option.description ? `${option.key} — ${option.label} — ${option.description}` : `${option.key} — ${option.label}`;

/** The recipe, the variables it may fill, and the conversation as data. */
export const buildClassificationPrompt = (variables: readonly ContextVariable[], excerpt: ConversationExcerpt): string => {
  const attributes = variables.map((variable, index) => ({
    field: fieldFor(index),
    name: variable.name,
    description: variable.description,
    options: (variable.options ?? []).filter((option) => !option.archived).map(describeOption),
  }));
  const conversation = {
    summary: excerpt.summary ? excerpt.summary.slice(0, CLASSIFICATION_SUMMARY_MAX_CHARS) : null,
    visitorMessages: excerpt.messages,
  };
  return [
    loadPromptTemplate("context-classification.md"),
    `<attributes>\n${serializeEnvelope(attributes)}\n</attributes>`,
    `<conversation>\n${serializeEnvelope(conversation)}\n</conversation>`,
  ].join("\n\n");
};

/** The model's answer did not fit the schema it was given; the run fails and the job retries. */
export class ClassificationOutputError extends Error {}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** Each variable's chosen key, or null, in the order the variables were given. */
export const parseClassificationOutput = (variables: readonly ContextVariable[], text: string): Array<string | null> => {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new ClassificationOutputError("Context classification response was not valid JSON");
  }
  if (!isRecord(parsed)) throw new ClassificationOutputError("Context classification response was not an object");
  return variables.map((variable, index) => {
    const field = fieldFor(index);
    if (!(field in parsed)) throw new ClassificationOutputError("Context classification response left out a field");
    const value = parsed[field];
    if (value === null) return null;
    if (typeof value !== "string" || !activeOptionKeys(variable).includes(value)) {
      throw new ClassificationOutputError("Context classification response named a key outside the schema");
    }
    return value;
  });
};
