import { z } from "zod";

import { routineInvocationRequestSchema } from "./routineInvocationSchemas.js";

const controlCharacter = /[\u0000-\u001F\u007F-\u009F]/u;
const boundedClientValue = (max: number) => z.string()
  .min(1)
  .max(max)
  .refine((value) => !controlCharacter.test(value), "Client metadata must not contain control characters")
  .refine((value) => value.trim().length > 0, "Client metadata must not be blank")
  .transform((value) => value.trim());

const mcpConverseClientSchema = z.object({
  name: boundedClientValue(128).optional(),
  version: boundedClientValue(64).optional(),
}).optional();

export const mcpConverseSessionRequestSchema = z.object({
  launchToken: z.string().min(1).max(2048).refine((value) => !controlCharacter.test(value)),
  client: mcpConverseClientSchema,
});

export const mcpConverseSessionValidateRequestSchema = z.object({
  sessionToken: z.string().min(1).max(2048).refine((value) => !controlCharacter.test(value)),
});

export const mcpConverseAskRequestSchema = z.object({
  message: z.string().trim().min(1).optional(),
  routine: routineInvocationRequestSchema.optional(),
  stream: z.literal(false).optional(),
}).superRefine((value, ctx) => {
  // An object with a refine, not a union: a union would silently match the first
  // branch when both keys are present.
  if (Boolean(value.message) === Boolean(value.routine)) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: "exactly one of message or routine is required",
      path: [value.routine ? "routine" : "message"],
    });
  }
});

export const mcpConverseSessionResponseSchema = z.object({
  sessionToken: z.string(),
  expiresAt: z.string().datetime(),
  resumeToken: z.string().optional(),
  agent: z.object({
    id: z.string().uuid(),
    name: z.string(),
  }),
  conversationId: z.string().uuid(),
});

export const mcpConverseSessionValidateResponseSchema = z.object({
  valid: z.literal(true),
  workspaceId: z.string().uuid(),
  agentId: z.string().uuid(),
  conversationId: z.string().uuid(),
  permissions: z.array(z.string()),
});
