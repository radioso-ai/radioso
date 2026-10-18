import { z } from "zod";

import { CHAT_MESSAGE_MAX_LENGTH } from "../../../../app/http/schemas/textInputLimits.js";
import type { CompletionsDialect } from "./dialects.js";

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
const lastUserIndex = (messages: readonly CompletionsMessage[]): number => {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    if (messages[index]?.role === "user") {
      return index;
    }
  }
  return -1;
};

const utteranceIn = (messages: readonly CompletionsMessage[]): string => {
  const lastUserMessage = messages[lastUserIndex(messages)];
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

/**
 * A replayed tool exchange rather than something said: a tool's result, or an assistant message
 * that only calls tools.
 */
const isToolExchange = (message: CompletionsMessage): boolean =>
  message.role === "tool"
  || (message.role === "assistant" && Array.isArray(message.tool_calls) && message.tool_calls.length > 0 && textOf(message.content).trim().length === 0);

/** The message said right before the newest user message, past any tool exchange replayed between them. */
const previousSaid = (messages: readonly CompletionsMessage[]): CompletionsMessage | undefined => {
  for (let index = lastUserIndex(messages) - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (message && !isToolExchange(message)) {
      return message;
    }
  }
  return undefined;
};

/**
 * What the caller heard of the agent's previous reply, when the dialect's runtime replays it cut
 * short: the assistant message said right before the newest user message (tool calls and results
 * replayed between them aside), ending in the dialect's suffix, without it. Undefined when that
 * reply was heard whole or the dialect reports nothing.
 */
export const heardUntilFor = (
  dialect: Pick<CompletionsDialect, "interruptedReplySuffix">,
  request: CompletionsRequest,
): string | undefined => {
  const suffix = dialect.interruptedReplySuffix;
  const previous = previousSaid(request.messages);
  if (!suffix || previous?.role !== "assistant") {
    return undefined;
  }
  const reply = textOf(previous.content).trimEnd();
  return reply.endsWith(suffix) ? reply.slice(0, -suffix.length).trimEnd() : undefined;
};
