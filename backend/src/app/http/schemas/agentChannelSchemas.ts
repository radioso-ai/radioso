import { z } from "zod";

import { chatMessageSchema } from "./textInputLimits.js";

export const agentChannelCredentialIssueSchema = z.object({
  audience: z.enum(["mcp", "rest"]),
  label: z.string(),
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
  startConversation: z.boolean().optional().default(false),
  stream: z.boolean().optional().default(false),
  userExpectedLocale: z.string().trim().max(35).optional(),
}).strict().superRefine((value, ctx) => {
  if (!value.message && !value.startConversation) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: "message is required unless startConversation is true",
      path: ["message"],
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
