import { z } from "zod";
import type { OpenAPIRegistry } from "@asteasolutions/zod-to-openapi";

import {
  CONTEXT_VALUE_WRITER_KINDS,
  CONTEXT_VARIABLE_VALUE_TYPES,
  CONVERSATION_SCOPE_TYPES,
  type ConversationAttribute,
} from "../../../../modules/context-variables/public.js";
import type { SameType } from "../../../../shared/types/sameType.js";

const scopeSchema = z.enum(CONVERSATION_SCOPE_TYPES);
// The documented rungs are the ones a conversation's attributes come from; a rung added there fails tsc here.
const documentedScopesMatch: SameType<z.infer<typeof scopeSchema>, ConversationAttribute["scope"]> = true;
void documentedScopesMatch;

/**
 * A conversation's attribute as the operator history read returns it. Registered in the assistant
 * history schemas, beside the conversation detail that carries it.
 */
export const registerConversationAttributeSchema = (registry: OpenAPIRegistry) => registry.register(
  "ConversationAttribute",
  z.object({
    name: z.string().openapi({ description: "The attribute's name, as in `{{context.<name>}}`." }),
    valueType: z.enum(CONTEXT_VARIABLE_VALUE_TYPES),
    value: z.unknown().openapi({
      description: "The value, as `GET /api/v1/context-variables/{id}/values` returns it: an `enum` value is its option's key. Null when `redacted`.",
    }),
    option: z.object({ label: z.string(), archived: z.boolean() }).optional().openapi({
      description: "The option an `enum` value names, archived or not. Absent for other types, for a redacted value, and for a key no option has.",
    }),
    redacted: z.boolean().openapi({
      description: "True for a Private (`sensitive`) attribute: its value and option are left out, and who set it and when remain.",
    }),
    scope: scopeSchema.openapi({
      description: "Where the value is kept: set for this conversation, the visitor's chat session, or the verified customer. The most specific one wins. A value set for an agent or the workspace is a default and is not listed.",
    }),
    writtenBy: z.object({
      kind: z.enum(CONTEXT_VALUE_WRITER_KINDS),
      ref: z.string().nullable().openapi({
        description: "What wrote the value: the API credential's or teammate's id for `api`, the version of the instructions for `classifier`.",
      }),
    }).openapi({ description: "The value's last writer." }),
    updatedAt: z.string().datetime(),
  }),
);
