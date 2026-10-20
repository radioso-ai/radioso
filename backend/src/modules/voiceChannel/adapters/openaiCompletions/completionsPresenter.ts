import type { VoiceTurnEvent } from "../../domain.js";

/** The identity every chunk of one completion repeats. */
export interface CompletionIdentity {
  id: string;
  /** Unix seconds. */
  created: number;
  model: string;
}

/** One OpenAI tool call, as a chunk's delta carries it whole and a completion's message lists it. */
interface ToolCall {
  id: string;
  type: "function";
  function: { name: string; arguments: string };
}

type ChunkDelta = { role?: "assistant"; content?: string; tool_calls?: Array<ToolCall & { index: number }> };

type FinishReason = "stop" | "tool_calls";

/** How the dialect's runtime names the tool that switches the call's language, and its arguments. */
interface LanguageSwitchRendering {
  tool: string;
  argument: string;
  reasonArgument: string;
}

type SwitchLanguageEvent = Extract<VoiceTurnEvent, { type: "switchLanguage" }>;

/** The switch as a call of the runtime's tool: the switch's id, and its reason and language as arguments. */
const switchToolCall = (event: SwitchLanguageEvent, rendering: LanguageSwitchRendering): ToolCall => ({
  id: event.switchId,
  type: "function",
  function: { name: rendering.tool, arguments: JSON.stringify({ [rendering.reasonArgument]: event.reason, [rendering.argument]: event.language }) },
});

const SSE_DONE_FRAME = "data: [DONE]\n\n";

/** Ends a stream that failed after its first frame. Generic on purpose: no transcript, no internals. */
export const COMPLETION_ERROR_FRAME = `data: ${JSON.stringify({
  error: { message: "The agent could not finish this reply.", type: "server_error" },
})}\n\n`;

const chunkFrame = (identity: CompletionIdentity, delta: ChunkDelta, finishReason: FinishReason | null): string =>
  `data: ${JSON.stringify({
    id: identity.id,
    object: "chat.completion.chunk",
    created: identity.created,
    model: identity.model,
    choices: [{ index: 0, delta, finish_reason: finishReason }],
  })}\n\n`;

/** What the stream renders: the turn's events, and a wire-only keep-alive the route sends during silence. */
type CompletionStreamEvent = VoiceTurnEvent | { type: "keep_alive"; delta: string };

interface ChunkRendering {
  /** Sent after each bridge line and speech piece when the dialect's runtime needs it to speak them. */
  sentenceFlushDelta?: string;
  /** The dialect's runtime offers a tool that switches the call's language. */
  languageSwitch?: LanguageSwitchRendering;
}

/**
 * Renders a turn's events as `chat.completion.chunk` SSE frames, one call per event. Bridge lines
 * and speech pieces are content deltas alike; the first carries the assistant role. The outcome
 * closes the completion with `stop` and `[DONE]`. A switch of the call's language is one tool-call
 * delta, and the outcome after it closes the completion with `tool_calls`: the turn carries nothing
 * else, since a runtime given text beside the call speaks it twice.
 */
export const createCompletionChunkRenderer = (
  identity: CompletionIdentity,
  rendering: ChunkRendering = {},
): (event: CompletionStreamEvent) => string[] => {
  let roleSent = false;
  const opening = (): ChunkDelta => {
    if (roleSent) return {};
    roleSent = true;
    return { role: "assistant" };
  };
  const flush = rendering.sentenceFlushDelta
    ? [chunkFrame(identity, { content: rendering.sentenceFlushDelta }, null)]
    : [];

  const roleFrame = (): string[] => (roleSent ? [] : [chunkFrame(identity, { ...opening(), content: "" }, null)]);
  let switched = false;

  return (event) => {
    switch (event.type) {
      case "conversation":
        return [];
      case "keep_alive":
        return [...roleFrame(), chunkFrame(identity, { content: event.delta }, null)];
      case "bridge":
      case "speech":
        return event.text.length > 0 ? [chunkFrame(identity, { ...opening(), content: event.text }, null), ...flush] : [];
      case "switchLanguage":
        if (!rendering.languageSwitch) return [];
        switched = true;
        return [chunkFrame(identity, { ...opening(), tool_calls: [{ index: 0, ...switchToolCall(event, rendering.languageSwitch) }] }, null)];
      case "outcome":
        return switched
          ? [chunkFrame(identity, {}, "tool_calls"), SSE_DONE_FRAME]
          : [...roleFrame(), chunkFrame(identity, {}, "stop"), SSE_DONE_FRAME];
    }
  };
};

type CompletionChoice =
  | { index: 0; message: { role: "assistant"; content: string }; finish_reason: "stop" }
  | { index: 0; message: { role: "assistant"; content: null; tool_calls: ToolCall[] }; finish_reason: "tool_calls" };

interface ChatCompletion {
  id: string;
  object: "chat.completion";
  created: number;
  model: string;
  choices: [CompletionChoice];
}

/**
 * Renders a whole turn as one `chat.completion` object, for a request with `stream: false`. Only
 * the speech is the reply; a bridge line covers a wait, which only a stream has. A switch of the
 * call's language is the message's one tool call, with no content.
 */
export const renderCompletion = (
  identity: CompletionIdentity,
  events: readonly VoiceTurnEvent[],
  rendering: Pick<ChunkRendering, "languageSwitch"> = {},
): ChatCompletion => {
  const switching = events.find((event): event is SwitchLanguageEvent => event.type === "switchLanguage");
  const choice: CompletionChoice = switching && rendering.languageSwitch
    ? {
        index: 0,
        message: { role: "assistant", content: null, tool_calls: [switchToolCall(switching, rendering.languageSwitch)] },
        finish_reason: "tool_calls",
      }
    : {
        index: 0,
        message: { role: "assistant", content: events.map((event) => (event.type === "speech" ? event.text : "")).join("") },
        finish_reason: "stop",
      };
  return { id: identity.id, object: "chat.completion", created: identity.created, model: identity.model, choices: [choice] };
};
