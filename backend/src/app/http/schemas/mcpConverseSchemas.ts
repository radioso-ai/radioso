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
  launchToken: z.string().min(1).max(2048).refine((value) => !controlCharacter.test(value)).optional(),
  /** An agent's public id, for an agent that accepts walk-in connections. Carries no secret. */
  publicId: z.string().min(1).max(128).regex(/^[A-Za-z0-9_-]+$/u).optional(),
  client: mcpConverseClientSchema,
}).superRefine((value, ctx) => {
  // An object with a refine, not a union: a union would silently match the first
  // branch when both keys are present.
  if (Boolean(value.launchToken) === Boolean(value.publicId)) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: "exactly one of launchToken or publicId is required",
      path: [value.publicId ? "publicId" : "launchToken"],
    });
  }
});

export const mcpConverseSessionValidateRequestSchema = z.object({
  sessionToken: z.string().min(1).max(2048).refine((value) => !controlCharacter.test(value)),
});

/**
 * The longest a caller may park on the updates route. 25 s sits far inside Node's
 * default 300 s `requestTimeout` and Cloud Run's default 300 s service timeout, so no
 * deployment setting has to change to support it; `headersTimeout` (60 s) bounds how
 * long a client may take to send request headers, not how long a response may take.
 */
const MCP_CONVERSE_MESSAGES_MAX_WAIT_MS = 25_000;

/** One page of updates; the wire carries no page-size knob. */
export const MCP_CONVERSE_MESSAGES_PAGE_LIMIT = 50;

export const mcpConverseMessagesQuerySchema = z.object({
  // Opaque and base64url by construction: history keysets on `(created_at, id)`, so the
  // cursor carries both and a bare message id could not seek against it.
  cursor: z.string().min(1).max(1024).regex(/^[A-Za-z0-9_-]+$/u).optional(),
  waitMs: z.coerce.number().int().min(0).max(MCP_CONVERSE_MESSAGES_MAX_WAIT_MS).default(0),
});

export type McpConverseMessagesQuery = z.output<typeof mcpConverseMessagesQuerySchema>;

export const mcpConverseAskRequestSchema = z.object({
  message: z.string().trim().min(1).optional(),
  routine: routineInvocationRequestSchema.optional(),
  /**
   * The same HMAC visitor token the website embed sends, bound to this session's
   * `conversationId` instead of a browser origin.
   */
  signedIdentity: z.string().max(8192).optional(),
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
