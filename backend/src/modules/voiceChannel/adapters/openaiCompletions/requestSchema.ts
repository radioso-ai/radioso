import { z } from "zod";

import { CHAT_MESSAGE_MAX_LENGTH } from "../../../../app/http/schemas/textInputLimits.js";
import type { CompletionsDialect } from "./dialects.js";

const contentPartSchema = z.object({ type: z.string(), text: z.unknown().optional() }).passthrough();

const messageSchema = z.object({
  role: z.string(),
  content: z.union([z.string(), z.array(contentPartSchema)]).nullish(),
}).passthrough();

/** One message of the call the runtime replays; fields Radioso does not name (`tool_calls`, `tool_call_id`) pass through. */
export type CompletionsMessage = z.infer<typeof messageSchema>;

/** A message's text: a string, or its `text` content parts joined. */
export const textOf = (content: CompletionsMessage["content"]): string => {
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

/**
 * The runtime's request right after it ran a tool the reply called: the newest message is that
 * tool's result, so the newest user message is one an earlier request already answered.
 */
export const isToolResultFollowUp = (request: CompletionsRequest): boolean => request.messages.at(-1)?.role === "tool";

export const utteranceOf = (request: CompletionsRequest): string | null => {
  const utterance = utteranceIn(request.messages);
  return utterance.length > 0 ? utterance : null;
};

/** Text with nothing to hear: whitespace and zero-width spaces, such as a dialect's keep-alive deltas. */
const SILENT_TEXT = /^[\s\u200B]*$/u;

/** Whether `text` has nothing to hear, as a runtime receiving it would find: a flush, a keep-alive, padding. */
export const isSilentText = (text: string): boolean => SILENT_TEXT.test(text);

/**
 * A replayed message that says nothing: a tool's result, an assistant message that only calls
 * tools, or one that holds only keep-alive whitespace (ElevenLabs replays a reply that sent its
 * keep-alive before a tool call as such a message; probe, 2026-10-18).
 */
const isToolExchange = (message: CompletionsMessage): boolean =>
  message.role === "tool"
  || (message.role === "assistant" && isSilentText(textOf(message.content)));

/** The message said right before the newest user message, past any tool exchange or keep-alive replayed between them. */
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
