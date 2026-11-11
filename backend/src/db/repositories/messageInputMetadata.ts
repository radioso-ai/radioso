import {
  VISITOR_IMAGE_INPUT_METADATA_KEY,
  visitorImageInputSchema,
  type VisitorImageInput,
} from "../../modules/visitorImages/public.js";

export type UserMessageInputMethod = "typed" | "suggestion_click" | "intent_click" | "routine_invocation";

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
  /**
   * The photos the message carries: what the visitor typed, and each photo's id with what the
   * agent's model read in it. `content` holds the same as the turn text the agent ran on.
   */
  imageInput?: VisitorImageInput;
}

const USER_MESSAGE_INPUT_METHODS: ReadonlySet<string> = new Set<UserMessageInputMethod>([
  "typed",
  "suggestion_click",
  "intent_click",
  "routine_invocation",
]);

const asObject = (value: unknown): Record<string, unknown> | null =>
  value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;

/**
 * A user message's input metadata as readers see it: the known keys only, each read defensively,
 * so a malformed one is dropped rather than the whole record.
 */
export const mapUserMessageInputMetadata = (value: unknown): UserMessageInputMetadata | undefined => {
  const candidate = asObject(value);
  if (!candidate || typeof candidate.method !== "string" || !USER_MESSAGE_INPUT_METHODS.has(candidate.method)) {
    return undefined;
  }
  const intent = asObject(candidate.intent);
  const routine = asObject(candidate.routine);
  const imageInput = visitorImageInputSchema.safeParse(candidate[VISITOR_IMAGE_INPUT_METADATA_KEY]);

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
          input: asObject(routine.input) ?? {},
        }
      : undefined,
    ...(imageInput.success ? { imageInput: imageInput.data } : {}),
  };
};
