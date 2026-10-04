import { z } from "zod";

import { CHAT_MESSAGE_MAX_LENGTH } from "./textInputLimits.js";

/**
 * A calling agent's tool call: the exposed routine's tool name and the slot values
 * to prefill. The shape is validated here; the values are validated against the
 * tool's own schema by the chat module's turn-input resolver, so both agent-facing
 * doors reject a bad call the same way before any turn state exists.
 */
export const routineInvocationRequestSchema = z.object({
  toolName: z.string().trim().min(1).max(63),
  input: z.record(z.unknown()).refine(
    (input) => JSON.stringify(input).length <= CHAT_MESSAGE_MAX_LENGTH,
    { message: `Routine input must serialize to at most ${CHAT_MESSAGE_MAX_LENGTH} characters` },
  ),
}).strict();
