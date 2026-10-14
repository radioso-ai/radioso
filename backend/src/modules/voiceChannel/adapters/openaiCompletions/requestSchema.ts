import { z } from "zod";

import { CHAT_MESSAGE_MAX_LENGTH } from "../../../../app/http/schemas/textInputLimits.js";

const contentPartSchema = z.object({ type: z.string(), text: z.unknown().optional() }).passthrough();

const messageSchema = z.object({
  role: z.string(),
  content: z.union([z.string(), z.array(contentPartSchema)]).nullish(),
}).passthrough();

type CompletionsMessage = z.infer<typeof messageSchema>;

const textOf = (content: CompletionsMessage["content"]): string => {
  if (typeof content === "string") {
    return content;
  }
  return (content ?? [])
    .flatMap((part) => (part.type === "text" && typeof part.text === "string" ? [part.text] : []))
    .join("\n");
};

/**
 * The caller's utterance is the last user message. The vendor replays the whole call on every
 * request; the conversation already holds that history, so the rest is ignored.
 */
const utteranceIn = (messages: readonly CompletionsMessage[]): string => {
  const lastUserMessage = [...messages].reverse().find((message) => message.role === "user");
  return lastUserMessage ? textOf(lastUserMessage.content).trim() : "";
};

/**
 * An OpenAI chat-completions request as voice runtimes send it. Fields Radioso has no use for
 * (sampling settings, the vendor's own tools) pass through untouched. The utterance is held to the
 * length of any other chat message.
 */
export const completionsRequestSchema = z.object({
  messages: z.array(messageSchema).min(1),
  stream: z.boolean().nullish(),
  model: z.string().nullish(),
  tools: z.array(z.unknown()).nullish(),
  elevenlabs_extra_body: z.record(z.unknown()).nullish(),
  metadata: z.record(z.unknown()).nullish(),
}).passthrough().superRefine((request, context) => {
  if (utteranceIn(request.messages).length > CHAT_MESSAGE_MAX_LENGTH) {
    context.addIssue({
      code: z.ZodIssueCode.too_big,
      type: "string",
      maximum: CHAT_MESSAGE_MAX_LENGTH,
      inclusive: true,
      path: ["messages"],
      message: `The utterance must be at most ${CHAT_MESSAGE_MAX_LENGTH} characters`,
    });
  }
});

type CompletionsRequest = z.infer<typeof completionsRequestSchema>;

export const utteranceOf = (request: CompletionsRequest): string | null => {
  const utterance = utteranceIn(request.messages);
  return utterance.length > 0 ? utterance : null;
};
