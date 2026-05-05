import type { InternalClientConfig } from "../core/config.js";
import { normalizeError, RadiosoError } from "../core/errors.js";
import { requestStream } from "../core/http.js";
import type { AssistantChatRequest, ChatResponse, ChatStreamRequest } from "../generated/client.js";

export type RadiosoChatStreamEvent =
  | { type: "conversation"; conversationId: string }
  | { type: "chunk"; text: string }
  | {
      type: "suggestions";
      conversationId: string;
      suggestions: NonNullable<ChatResponse["suggestions"]>;
      conversationModeMetadata: ChatResponse["conversationModeMetadata"];
    }
  | ({ type: "done" } & ChatResponse)
  | { type: "error"; error: RadiosoError };

const parsePayload = (value: string): Record<string, unknown> => JSON.parse(value) as Record<string, unknown>;

const toLines = async function* (stream: ReadableStream<Uint8Array>): AsyncGenerator<string> {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  while (true) {
    const { done, value } = await reader.read();
    if (done) {
      break;
    }

    buffer += decoder.decode(value, { stream: true });

    let separatorIndex = buffer.indexOf("\n\n");
    while (separatorIndex >= 0) {
      const frame = buffer.slice(0, separatorIndex);
      buffer = buffer.slice(separatorIndex + 2);
      yield frame;
      separatorIndex = buffer.indexOf("\n\n");
    }
  }

  buffer += decoder.decode();
  if (buffer.trim()) {
    yield buffer;
  }
};

const parseFrame = (frame: string): RadiosoChatStreamEvent | null => {
  const lines = frame.split("\n");
  const eventLine = lines.find((line) => line.startsWith("event: "));
  const dataLine = lines.find((line) => line.startsWith("data: "));

  if (!eventLine || !dataLine) {
    return null;
  }

  const eventName = eventLine.slice("event: ".length).trim();
  const payload = parsePayload(dataLine.slice("data: ".length));

  if (eventName === "conversation" && typeof payload.conversationId === "string") {
    return { type: "conversation", conversationId: payload.conversationId };
  }

  if (eventName === "chunk" && typeof payload.text === "string") {
    return { type: "chunk", text: payload.text };
  }

  if (
    eventName === "suggestions" &&
    typeof payload.conversationId === "string" &&
    Array.isArray(payload.suggestions) &&
    typeof payload.conversationModeMetadata === "object" &&
    payload.conversationModeMetadata !== null
  ) {
    return {
      type: "suggestions",
      conversationId: payload.conversationId,
      suggestions: payload.suggestions as NonNullable<ChatResponse["suggestions"]>,
      conversationModeMetadata: payload.conversationModeMetadata as ChatResponse["conversationModeMetadata"],
    };
  }

  if (
    eventName === "done" &&
    typeof payload.conversationId === "string" &&
    typeof payload.answer === "string" &&
    typeof payload.route === "object" &&
    payload.route !== null &&
    typeof payload.conversationMode === "string" &&
    typeof payload.conversationModeMetadata === "object" &&
    payload.conversationModeMetadata !== null
  ) {
    return {
      type: "done",
      conversationId: payload.conversationId,
      route: payload.route,
      answer: payload.answer,
      citations: Array.isArray(payload.citations) ? payload.citations : undefined,
      answerSegments: Array.isArray(payload.answerSegments) ? payload.answerSegments : undefined,
      suggestions: Array.isArray(payload.suggestions) ? payload.suggestions : undefined,
      conversationMode: payload.conversationMode,
      conversationModeMetadata: payload.conversationModeMetadata,
      retrievalInfo: payload.retrievalInfo,
      retrievalTrace: payload.retrievalTrace,
    } as RadiosoChatStreamEvent;
  }

  return null;
};

export const streamChat = async function* (
  config: InternalClientConfig,
  request: ChatStreamRequest,
): AsyncGenerator<RadiosoChatStreamEvent> {
  try {
    const response = await requestStream(config, {
      method: "POST",
      path: "/api/v1/assistant/chat",
      headers: {
        Accept: "text/event-stream",
      },
      body: {
        ...request,
        startConversation: false,
        stream: true,
      } satisfies AssistantChatRequest,
    });

    if (!response.body) {
      yield {
        type: "error",
        error: new RadiosoError({
          code: "STREAM_ERROR",
          message: "Streaming response body was empty.",
        }),
      };
      return;
    }

    for await (const frame of toLines(response.body)) {
      const parsed = parseFrame(frame);
      if (parsed) {
        yield parsed;
      }
    }
  } catch (error) {
    yield {
      type: "error",
      error: normalizeError(error),
    };
  }
};
