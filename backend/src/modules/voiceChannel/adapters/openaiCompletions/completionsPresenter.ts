import type { VoiceTurnEvent } from "../../domain.js";

/** The identity every chunk of one completion repeats. */
export interface CompletionIdentity {
  id: string;
  /** Unix seconds. */
  created: number;
  model: string;
}

type ChunkDelta = { role?: "assistant"; content?: string };

const SSE_DONE_FRAME = "data: [DONE]\n\n";

/** Ends a stream that failed after its first frame. Generic on purpose: no transcript, no internals. */
export const COMPLETION_ERROR_FRAME = `data: ${JSON.stringify({
  error: { message: "The agent could not finish this reply.", type: "server_error" },
})}\n\n`;

const chunkFrame = (identity: CompletionIdentity, delta: ChunkDelta, finishReason: "stop" | null): string =>
  `data: ${JSON.stringify({
    id: identity.id,
    object: "chat.completion.chunk",
    created: identity.created,
    model: identity.model,
    choices: [{ index: 0, delta, finish_reason: finishReason }],
  })}\n\n`;

/**
 * Renders a turn's events as `chat.completion.chunk` SSE frames, one call per event. The first
 * content chunk carries the assistant role; the outcome closes the completion with `stop` and
 * `[DONE]`.
 */
export const createCompletionChunkRenderer = (identity: CompletionIdentity): (event: VoiceTurnEvent) => string[] => {
  let roleSent = false;
  const opening = (): ChunkDelta => {
    if (roleSent) return {};
    roleSent = true;
    return { role: "assistant" };
  };

  return (event) => {
    switch (event.type) {
      case "conversation":
        return [];
      case "speech":
        return event.text.length > 0 ? [chunkFrame(identity, { ...opening(), content: event.text }, null)] : [];
      case "outcome": {
        const roleFrame = roleSent ? [] : [chunkFrame(identity, { ...opening(), content: "" }, null)];
        return [...roleFrame, chunkFrame(identity, {}, "stop"), SSE_DONE_FRAME];
      }
    }
  };
};

interface ChatCompletion {
  id: string;
  object: "chat.completion";
  created: number;
  model: string;
  choices: [{ index: 0; message: { role: "assistant"; content: string }; finish_reason: "stop" }];
}

/** Renders a whole turn as one `chat.completion` object, for a request with `stream: false`. */
export const renderCompletion = (identity: CompletionIdentity, events: readonly VoiceTurnEvent[]): ChatCompletion => ({
  id: identity.id,
  object: "chat.completion",
  created: identity.created,
  model: identity.model,
  choices: [{
    index: 0,
    message: {
      role: "assistant",
      content: events.map((event) => (event.type === "speech" ? event.text : "")).join(""),
    },
    finish_reason: "stop",
  }],
});
