import { z } from "zod";

import { a2aError, type A2aRpcError } from "./a2aErrors.js";
import type { A2aMethod } from "./jsonRpc.js";
import { A2A_TASK_STATES, type A2aTaskState } from "./taskState.js";

export interface SendMessageInput {
  /** The caller's own id for the message; retries reuse it, so it keys idempotency. */
  messageId: string;
  text: string;
  contextId: string | null;
  taskId: string | null;
  historyLength: number | null;
}

export interface GetTaskInput {
  id: string;
  historyLength: number | null;
}

export interface CancelTaskInput {
  id: string;
}

export interface ListTasksInput {
  contextId: string | null;
  state: A2aTaskState | null;
  pageSize: number;
  pageToken: string | null;
  historyLength: number | null;
  statusTimestampAfter: Date | null;
  includeArtifacts: boolean;
}

export type A2aCallInput =
  | { method: "SendMessage"; params: SendMessageInput }
  | { method: "GetTask"; params: GetTaskInput }
  | { method: "ListTasks"; params: ListTasksInput }
  | { method: "CancelTask"; params: CancelTaskInput };

type A2aCallInputParse = { ok: true; input: A2aCallInput } | { ok: false; error: A2aRpcError };

/** ProtoJSON's default for an unset page size is 0; A2A's server default is 50, and 100 is its ceiling. */
const DEFAULT_PAGE_SIZE = 50;
const MAX_PAGE_SIZE = 100;

/** Structural bounds that keep junk out of lookups; ids this server mints are far shorter. */
const MAX_CLIENT_MESSAGE_ID_LENGTH = 256;
const MAX_TASK_ID_LENGTH = 128;
const MAX_CONTEXT_ID_LENGTH = 2048;
const MAX_PAGE_TOKEN_LENGTH = 512;

/** ProtoJSON writes an unset string field as absent or as "" — both mean "not given". */
const optionalId = (max: number) => z.string().max(max).optional().transform((value) => (value ? value : null));

/** int32 fields arrive as JSON numbers; a lenient client may quote them. */
const optionalCount = z.union([z.number(), z.string().regex(/^\d+$/u).transform(Number)])
  .pipe(z.number().int().min(0))
  .optional()
  .transform((value) => value ?? null);

const PART_CONTENT_KEYS = ["text", "raw", "url", "data"] as const;

const partSchema = z.record(z.string(), z.unknown());

const sendMessageSchema = z.object({
  message: z.object({
    messageId: z.string().min(1).max(MAX_CLIENT_MESSAGE_ID_LENGTH),
    role: z.literal("ROLE_USER").optional(),
    parts: z.array(partSchema).min(1),
    contextId: optionalId(MAX_CONTEXT_ID_LENGTH),
    taskId: optionalId(MAX_TASK_ID_LENGTH),
  }),
  configuration: z.object({
    historyLength: optionalCount,
    taskPushNotificationConfig: z.unknown().optional(),
  }).optional(),
});

const getTaskSchema = z.object({
  id: z.string().min(1).max(MAX_TASK_ID_LENGTH),
  historyLength: optionalCount,
});

const cancelTaskSchema = z.object({ id: z.string().min(1).max(MAX_TASK_ID_LENGTH) });

const wireTaskStates = new Map<string, A2aTaskState>(
  A2A_TASK_STATES.map((state) => [`TASK_STATE_${state.toUpperCase()}`, state]),
);

const listTasksSchema = z.object({
  contextId: optionalId(MAX_CONTEXT_ID_LENGTH),
  status: z.string().optional().superRefine((value, ctx) => {
    if (value && value !== "TASK_STATE_UNSPECIFIED" && !wireTaskStates.has(value)) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: "unknown task state" });
    }
  }).transform((value) => (value ? wireTaskStates.get(value) ?? null : null)),
  pageSize: optionalCount.pipe(z.number().int().max(MAX_PAGE_SIZE).nullable())
    .transform((value) => (value ? value : DEFAULT_PAGE_SIZE)),
  pageToken: optionalId(MAX_PAGE_TOKEN_LENGTH),
  historyLength: optionalCount,
  statusTimestampAfter: z.string().optional().superRefine((value, ctx) => {
    if (value !== undefined && Number.isNaN(Date.parse(value))) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: "unreadable timestamp" });
    }
  }).transform((value) => (value ? new Date(value) : null)),
  includeArtifacts: z.boolean().optional().transform((value) => value ?? false),
});

const invalidParams = (): A2aCallInputParse => ({ ok: false, error: a2aError("INVALID_PARAMS") });

/**
 * Slice 1 reads text only. A part carries exactly one content field; one that carries none or
 * several is malformed (-32602), and a file, raw, url, or data part is a content type this agent
 * does not take (-32005). The text parts join with a newline, and the result is bounded like a
 * chat message.
 */
const readMessageText = (parts: readonly Record<string, unknown>[], maxLength: number): string | A2aRpcError => {
  const texts: string[] = [];
  let unsupported = false;
  for (const part of parts) {
    const contents = PART_CONTENT_KEYS.filter((key) => part[key] !== undefined);
    if (contents.length !== 1) {
      return a2aError("INVALID_PARAMS");
    }
    if (contents[0] !== "text") {
      unsupported = true;
      continue;
    }
    if (typeof part.text !== "string") {
      return a2aError("INVALID_PARAMS");
    }
    texts.push(part.text);
  }
  if (unsupported) {
    return a2aError("CONTENT_TYPE_NOT_SUPPORTED");
  }
  const text = texts.join("\n").trim();
  return text.length === 0 || text.length > maxLength ? a2aError("INVALID_PARAMS") : text;
};

const parseSendMessage = (params: Record<string, unknown>, maxMessageLength: number): A2aCallInputParse => {
  const parsed = sendMessageSchema.safeParse(params);
  if (!parsed.success) {
    return invalidParams();
  }
  if (parsed.data.configuration?.taskPushNotificationConfig !== undefined) {
    return { ok: false, error: a2aError("PUSH_NOTIFICATION_NOT_SUPPORTED") };
  }
  const text = readMessageText(parsed.data.message.parts, maxMessageLength);
  if (typeof text !== "string") {
    return { ok: false, error: text };
  }
  return {
    ok: true,
    input: {
      method: "SendMessage",
      params: {
        messageId: parsed.data.message.messageId,
        text,
        contextId: parsed.data.message.contextId,
        taskId: parsed.data.message.taskId,
        historyLength: parsed.data.configuration?.historyLength ?? null,
      },
    },
  };
};

/**
 * Each served method's params, validated before anything about the agent or the caller is read.
 * Unknown fields are ignored, as ProtoJSON readers do; `acceptedOutputModes` and
 * `returnImmediately` are accepted and change nothing (replies are `text/plain`, and `SendMessage`
 * returns when its turn finishes).
 */
export const parseCallParams = (
  method: A2aMethod,
  params: Record<string, unknown>,
  limits: { maxMessageLength: number },
): A2aCallInputParse => {
  switch (method) {
    case "SendMessage":
      return parseSendMessage(params, limits.maxMessageLength);
    case "GetTask": {
      const parsed = getTaskSchema.safeParse(params);
      return parsed.success ? { ok: true, input: { method, params: parsed.data } } : invalidParams();
    }
    case "CancelTask": {
      const parsed = cancelTaskSchema.safeParse(params);
      return parsed.success ? { ok: true, input: { method, params: parsed.data } } : invalidParams();
    }
    case "ListTasks": {
      const parsed = listTasksSchema.safeParse(params);
      if (!parsed.success) {
        return invalidParams();
      }
      const { status, ...rest } = parsed.data;
      return { ok: true, input: { method, params: { ...rest, state: status } } };
    }
  }
};
