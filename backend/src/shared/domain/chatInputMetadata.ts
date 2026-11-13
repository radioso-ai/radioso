import { z } from "zod";

/**
 * How a visitor's chat message was entered: typed, a suggestion chip clicked, an intent started,
 * a card picked from a reply (`item_select`), or a calling agent's tool call. The one vocabulary
 * every surface that takes or keeps a message shares: the public chat, assistant chat and agent
 * turn probe request schemas, and the copy stored on a user message. `routine_invocation` is
 * recorded by chat for a routine invoked as a tool, and no client sends it.
 */
const USER_MESSAGE_INPUT_METHODS = ["typed", "suggestion_click", "intent_click", "item_select", "routine_invocation"] as const;

type UserMessageInputMethod = typeof USER_MESSAGE_INPUT_METHODS[number];

/**
 * The photos a message carries, as stored: what the visitor typed, apart from the readings the turn
 * text carries, and each photo's id with what the agent's model read in it (null when it could
 * not). The UIs render the typed text and the photos from it, so a reading never shows in the
 * visitor's own bubble.
 */
const messageImageInputSchema = z.object({
  typedText: z.string(),
  images: z.array(z.object({
    id: z.string().uuid(),
    reading: z.string().nullable(),
  })).min(1).max(3),
});

type MessageImageInput = z.infer<typeof messageImageInputSchema>;

const CLIENT_INPUT_METHODS = ["typed", "suggestion_click", "intent_click", "item_select"] as const satisfies readonly UserMessageInputMethod[];

/** The methods the agent turn probe takes: it runs on no stored reply, so it has no card to pick. */
const PROBE_INPUT_METHODS = ["typed", "suggestion_click", "intent_click"] as const satisfies readonly UserMessageInputMethod[];

/**
 * The card a visitor picked (`item_select`): the assistant message whose reply showed it, the
 * block on that message, and the item's key in the block. Ids only: the server reads the item
 * itself from the stored block.
 */
const itemSelectionSchema = z.object({
  messageId: z.string().uuid(),
  blockId: z.string().min(1).max(64),
  itemKey: z.string().min(1).max(128),
});

export type ItemSelection = z.infer<typeof itemSelectionSchema>;

export interface UserMessageInputMetadata {
  method: UserMessageInputMethod;
  suggestionSourceMessageId?: string;
  /** The id of the chip clicked (`suggestion_click`), such as a routine consent's `agree` or `decline`. */
  suggestionId?: string;
  intent?: {
    skillName: string;
    intentName?: string;
  };
  /** The card picked (`method: "item_select"`). */
  selection?: ItemSelection;
  /** The structured form of a calling agent's tool call (`method: "routine_invocation"`). */
  routine?: {
    toolName: string;
    input: Record<string, unknown>;
  };
  /**
   * The photos the message carries: what the visitor typed, and each photo's id with what the
   * agent's model read in it. `content` holds the same as the turn text the agent ran on.
   */
  imageInput?: MessageImageInput;
}

const MAX_SUGGESTION_ID_LENGTH = 200;

/**
 * A clicked chip's id, kept up to the length a chip id may have here and dropped past it. Authored
 * chip ids have no length limit, and a client sends the id of whichever chip was clicked, so a
 * longer one loses only its id rather than failing the click. The ids that decide anything, a
 * routine consent's `agree` and `decline`, are short.
 */
const suggestionIdSchema = z.preprocess(
  (value) => (typeof value === "string" && value.length > MAX_SUGGESTION_ID_LENGTH ? undefined : value),
  z.string().min(1).max(MAX_SUGGESTION_ID_LENGTH).optional(),
);

const clientIntentSchema = z.object({
  skillName: z.string().trim().min(1).max(120),
  intentName: z.string().trim().min(1).max(120).optional(),
});

const clientInputMetadataShape = z.object({
  method: z.enum(CLIENT_INPUT_METHODS),
  suggestionSourceMessageId: z.string().uuid().optional(),
  suggestionId: suggestionIdSchema,
  intent: clientIntentSchema.optional(),
  selection: itemSelectionSchema.optional(),
});

const requireMethodFields = (
  value: Omit<z.infer<typeof clientInputMetadataShape>, "method" | "selection"> & { method: string; selection?: ItemSelection },
  ctx: z.RefinementCtx,
): void => {
  if (value.method === "suggestion_click" && !value.suggestionSourceMessageId) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: "suggestionSourceMessageId is required for suggestion_click",
      path: ["suggestionSourceMessageId"],
    });
  }
  if (value.suggestionId !== undefined && value.method !== "suggestion_click") {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: "suggestionId is sent only with suggestion_click",
      path: ["suggestionId"],
    });
  }
  if (value.method === "intent_click" && !value.intent) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: "intent is required for intent_click",
      path: ["intent"],
    });
  }
  if ((value.method === "item_select") !== (value.selection !== undefined)) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: "selection is sent with item_select, and only with it",
      path: ["selection"],
    });
  }
};

/** The input metadata a chat client sends with a message. */
export const chatInputMetadataSchema = clientInputMetadataShape.superRefine(requireMethodFields);

/** {@link chatInputMetadataSchema} refusing unknown keys and a picked card, for the agent turn probe's tool input. */
export const strictChatInputMetadataSchema = clientInputMetadataShape
  .omit({ selection: true })
  .extend({ method: z.enum(PROBE_INPUT_METHODS), intent: clientIntentSchema.strict().optional() })
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

  const candidate = value as {
    method?: unknown;
    suggestionSourceMessageId?: unknown;
    suggestionId?: unknown;
    intent?: unknown;
    routine?: unknown;
    selection?: unknown;
    imageInput?: unknown;
  };
  if (typeof candidate.method !== "string" || !STORED_INPUT_METHODS.has(candidate.method)) {
    return undefined;
  }
  const intent = candidate.intent && typeof candidate.intent === "object" && !Array.isArray(candidate.intent)
    ? candidate.intent as { skillName?: unknown; intentName?: unknown }
    : null;
  const routine = candidate.routine && typeof candidate.routine === "object" && !Array.isArray(candidate.routine)
    ? candidate.routine as { toolName?: unknown; input?: unknown }
    : null;
  const imageInput = messageImageInputSchema.safeParse(candidate.imageInput);
  const selection = itemSelectionSchema.safeParse(candidate.selection);

  return {
    method: candidate.method as UserMessageInputMethod,
    suggestionSourceMessageId:
      typeof candidate.suggestionSourceMessageId === "string" && candidate.suggestionSourceMessageId.length > 0
        ? candidate.suggestionSourceMessageId
        : undefined,
    suggestionId:
      typeof candidate.suggestionId === "string" && candidate.suggestionId.length > 0 ? candidate.suggestionId : undefined,
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
    ...(selection.success ? { selection: selection.data } : {}),
    ...(imageInput.success ? { imageInput: imageInput.data } : {}),
  };
};
