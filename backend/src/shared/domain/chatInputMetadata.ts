import { z } from "zod";

/**
 * How a visitor's chat message was entered: typed, a suggestion chip clicked, an intent started,
 * or a calling agent's tool call. The one vocabulary every surface that takes or keeps a message
 * shares: the public chat, assistant chat and agent turn probe request schemas, and the copy
 * stored on a user message. `routine_invocation` is recorded by chat for a routine invoked as a
 * tool, and no client sends it.
 */
const USER_MESSAGE_INPUT_METHODS = ["typed", "suggestion_click", "intent_click", "routine_invocation"] as const;

type UserMessageInputMethod = typeof USER_MESSAGE_INPUT_METHODS[number];

const CLIENT_INPUT_METHODS = ["typed", "suggestion_click", "intent_click"] as const satisfies readonly UserMessageInputMethod[];

export interface UserMessageInputMetadata {
  method: UserMessageInputMethod;
  suggestionSourceMessageId?: string;
  intent?: {
    skillName: string;
    intentName?: string;
  };
  /** The structured form of a calling agent's tool call (`method: "routine_invocation"`). */
  routine?: {
    toolName: string;
    input: Record<string, unknown>;
  };
}

const clientIntentSchema = z.object({
  skillName: z.string().trim().min(1).max(120),
  intentName: z.string().trim().min(1).max(120).optional(),
});

const clientInputMetadataShape = z.object({
  method: z.enum(CLIENT_INPUT_METHODS),
  suggestionSourceMessageId: z.string().uuid().optional(),
  intent: clientIntentSchema.optional(),
});

const requireMethodFields = (
  value: z.infer<typeof clientInputMetadataShape>,
  ctx: z.RefinementCtx,
): void => {
  if (value.method === "suggestion_click" && !value.suggestionSourceMessageId) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: "suggestionSourceMessageId is required for suggestion_click",
      path: ["suggestionSourceMessageId"],
    });
  }
  if (value.method === "intent_click" && !value.intent) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: "intent is required for intent_click",
      path: ["intent"],
    });
  }
};

/** The input metadata a chat client sends with a message. */
export const chatInputMetadataSchema = clientInputMetadataShape.superRefine(requireMethodFields);

/** {@link chatInputMetadataSchema} refusing unknown keys, for a tool input a model writes. */
export const strictChatInputMetadataSchema = clientInputMetadataShape
  .extend({ intent: clientIntentSchema.strict().optional() })
  .strict()
  .superRefine(requireMethodFields);

const STORED_INPUT_METHODS: ReadonlySet<string> = new Set<string>(USER_MESSAGE_INPUT_METHODS);

/**
 * The input metadata kept on a stored user message, read back field by field: a field that is
 * not well formed is dropped, and an unknown method reads as no input metadata at all.
 */
export const parseStoredInputMetadata = (value: unknown): UserMessageInputMetadata | undefined => {
  if (!value || typeof value !== "object") {
    return undefined;
  }

  const candidate = value as { method?: unknown; suggestionSourceMessageId?: unknown; intent?: unknown; routine?: unknown };
  if (typeof candidate.method !== "string" || !STORED_INPUT_METHODS.has(candidate.method)) {
    return undefined;
  }
  const intent = candidate.intent && typeof candidate.intent === "object" && !Array.isArray(candidate.intent)
    ? candidate.intent as { skillName?: unknown; intentName?: unknown }
    : null;
  const routine = candidate.routine && typeof candidate.routine === "object" && !Array.isArray(candidate.routine)
    ? candidate.routine as { toolName?: unknown; input?: unknown }
    : null;

  return {
    method: candidate.method as UserMessageInputMethod,
    suggestionSourceMessageId:
      typeof candidate.suggestionSourceMessageId === "string" && candidate.suggestionSourceMessageId.length > 0
        ? candidate.suggestionSourceMessageId
        : undefined,
    intent: typeof intent?.skillName === "string" && intent.skillName.length > 0
      ? {
          skillName: intent.skillName,
          intentName: typeof intent.intentName === "string" && intent.intentName.length > 0 ? intent.intentName : undefined,
        }
      : undefined,
    routine: typeof routine?.toolName === "string" && routine.toolName.length > 0
      ? {
          toolName: routine.toolName,
          input: routine.input && typeof routine.input === "object" && !Array.isArray(routine.input)
            ? routine.input as Record<string, unknown>
            : {},
        }
      : undefined,
  };
};
