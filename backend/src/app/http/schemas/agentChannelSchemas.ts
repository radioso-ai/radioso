import { z } from "zod";

import { routineInvocationRequestSchema } from "./routineInvocationSchemas.js";
import { chatMessageSchema } from "./textInputLimits.js";

const labelControlCharacter = /[\u0000-\u001F\u007F-\u009F]/u;

/**
 * Channel credential labels cross the HTTP/OpenAPI boundary unchanged. Keep
 * their canonical display representation explicit here; the domain layer still
 * normalizes labels for non-HTTP callers.
 */
export const agentChannelCredentialLabelSchema = z.string()
  .min(1)
  .max(80)
  .refine((value) => value === value.trim(), {
    message: "Credential labels must not have leading or trailing whitespace",
  })
  .refine((value) => value === value.normalize("NFC"), {
    message: "Credential labels must use Unicode NFC normalization",
  })
  .refine((value) => !labelControlCharacter.test(value), {
    message: "Credential labels must not contain control characters",
  });

export const agentChannelCredentialIssueSchema = z.object({
  audience: z.enum(["mcp", "rest"]),
  label: agentChannelCredentialLabelSchema,
  expiresAt: z.string().datetime().transform((value) => new Date(value)),
}).strict();

export const agentChannelCredentialListQuerySchema = z.object({
  audience: z.enum(["mcp", "rest"]).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(50),
  cursor: z.string().trim().min(1).max(500).optional(),
}).strict();

export const agentChannelCredentialParamsSchema = z.object({
  agentId: z.string().uuid(),
  credentialId: z.string().uuid(),
});

export const agentChannelChatSchema = z.object({
  conversationId: z.string().uuid().optional(),
  message: chatMessageSchema.optional(),
  routine: routineInvocationRequestSchema.optional(),
  startConversation: z.boolean().optional().default(false),
  stream: z.boolean().optional().default(false),
  userExpectedLocale: z.string().trim().max(35).optional(),
}).strict().superRefine((value, ctx) => {
  // Exactly one turn kind per request: a message, a tool call, or a bootstrap greeting.
  const turnKinds = [value.message, value.routine, value.startConversation || undefined].filter((kind) => kind !== undefined);
  if (turnKinds.length === 0) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: "message or routine is required unless startConversation is true",
      path: ["message"],
    });
  }
  if (turnKinds.length > 1) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: "message, routine, and startConversation are mutually exclusive",
      path: [value.routine ? "routine" : "message"],
    });
  }
  if (value.startConversation && value.conversationId) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: "startConversation may only be used for brand-new conversations",
      path: ["conversationId"],
    });
  }
  if (value.startConversation && value.stream) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: "startConversation does not support streaming",
      path: ["stream"],
    });
  }
});
