import { z } from "zod";

import type { SameType } from "../../../shared/types/sameType.js";
import {
  CONTEXT_VALUE_WRITER_KINDS,
  CONTEXT_VARIABLE_VALUE_TYPES,
  CONVERSATION_SCOPE_TYPES,
  type ConversationAttribute,
} from "../../context-variables/public.js";
import { jsonValueSchema } from "./chatPayloadBounds.js";

/** One attribute of a conversation as Ray and operator MCP read it, in a transcript and after an edit. */
export const conversationAttributeSchema = z.object({
  name: z.string(),
  valueType: z.enum(CONTEXT_VARIABLE_VALUE_TYPES),
  /** Null when redacted. An enum value is its option's key. A long value is its first characters, as text. */
  value: jsonValueSchema,
  option: z.object({ label: z.string(), archived: z.boolean() }).nullable(),
  redacted: z.boolean(),
  truncated: z.boolean(),
  scope: z.enum(CONVERSATION_SCOPE_TYPES),
  writtenBy: z.object({ kind: z.enum(CONTEXT_VALUE_WRITER_KINDS), ref: z.string().nullable() }),
  updatedAt: z.string(),
  /** Whether the conversation's agent fills this attribute with the AI. */
  classified: z.boolean(),
});
// Compile-time guard: the rungs Ray names are the ones a conversation's attributes come from.
const attributeScopeMatches: SameType<z.infer<typeof conversationAttributeSchema>["scope"], ConversationAttribute["scope"]> = true;
void attributeScopeMatches;

/** How much of a Text or JSON attribute's value Ray reads: a value can hold 32 KB, which would crowd out the messages. */
const ATTRIBUTE_VALUE_CHARS = 500;

const boundAttributeValue = (value: unknown): { value: unknown; truncated: boolean } => {
  const text = typeof value === "string" ? value : JSON.stringify(value);
  return text.length > ATTRIBUTE_VALUE_CHARS ? { value: text.slice(0, ATTRIBUTE_VALUE_CHARS), truncated: true } : { value, truncated: false };
};

export const projectConversationAttribute = (attribute: ConversationAttribute): z.infer<typeof conversationAttributeSchema> => ({
  name: attribute.name,
  valueType: attribute.valueType,
  ...boundAttributeValue(attribute.value),
  option: attribute.option ?? null,
  redacted: attribute.redacted,
  scope: attribute.scope,
  writtenBy: attribute.writtenBy,
  updatedAt: attribute.updatedAt.toISOString(),
  classified: attribute.classified,
});
