import type { InternalClientConfig } from "../core/config.js";
import { normalizeError, RadiosoError } from "../core/errors.js";
import { requestStream } from "../core/http.js";
import type { AssistantChatRequest, ChatResponse, ChatStreamRequest } from "../generated/client.js";

export interface RadiosoChatStreamCancelledEvent {
  type: "cancelled";
  conversationId: string;
  reason: "superseded";
  stage: "waiting" | "preparing" | "routing" | "rendering" | "persisting";
}

export type RadiosoChatStatusStage = "interpreting" | "searching" | "composing";

export interface RadiosoChatStreamStatusEvent {
  type: "status";
  stage: RadiosoChatStatusStage;
}

export type RadiosoChatStreamEvent =
  | RadiosoChatStreamStatusEvent
  | { type: "conversation"; conversationId: string }
  | { type: "chunk"; text: string }
  | RadiosoChatStreamCancelledEvent
  | {
      type: "suggestions";
      conversationId: string;
      suggestions: NonNullable<ChatResponse["suggestions"]>;
    }
  | ({ type: "done" } & ChatResponse)
  | { type: "error"; error: RadiosoError };

const parsePayload = (value: string): Record<string, unknown> => JSON.parse(value) as Record<string, unknown>;

const isCancellationStage = (value: unknown): value is RadiosoChatStreamCancelledEvent["stage"] =>
  value === "waiting" ||
  value === "preparing" ||
  value === "routing" ||
  value === "rendering" ||
  value === "persisting";

const isStatusStage = (value: unknown): value is RadiosoChatStatusStage =>
  value === "interpreting" || value === "searching" || value === "composing";

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

  if (eventName === "status" && isStatusStage(payload.stage)) {
    return { type: "status", stage: payload.stage };
  }

  if (eventName === "chunk" && typeof payload.text === "string") {
    return { type: "chunk", text: payload.text };
  }

  if (
    eventName === "cancelled" &&
    typeof payload.conversationId === "string" &&
    payload.reason === "superseded" &&
    isCancellationStage(payload.stage)
  ) {
    return {
      type: "cancelled",
      conversationId: payload.conversationId,
      reason: payload.reason,
      stage: payload.stage,
    };
  }

  if (
    eventName === "suggestions" &&
    typeof payload.conversationId === "string" &&
    Array.isArray(payload.suggestions)
  ) {
    return {
      type: "suggestions",
      conversationId: payload.conversationId,
      suggestions: payload.suggestions as NonNullable<ChatResponse["suggestions"]>,
    };
  }

  if (
    eventName === "done" &&
    typeof payload.conversationId === "string" &&
    typeof payload.answer === "string"
  ) {
    return {
      type: "done",
      conversationId: payload.conversationId,
      ...(typeof payload.assistantMessageId === "string" ? { assistantMessageId: payload.assistantMessageId } : {}),
      ...(typeof payload.agentId === "string" ? { agentId: payload.agentId } : {}),
      ...(typeof payload.agentName === "string" ? { agentName: payload.agentName } : {}),
      answer: payload.answer,
      ...(typeof payload.debug === "object" && payload.debug !== null ? { debug: payload.debug } : {}),
      ...(Array.isArray(payload.citations) ? { citations: payload.citations } : {}),
      ...(Array.isArray(payload.answerSegments) ? { answerSegments: payload.answerSegments } : {}),
      ...(Array.isArray(payload.suggestions) ? { suggestions: payload.suggestions } : {}),
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
        if (parsed.type === "cancelled") {
          return;
        }
      }
    }
  } catch (error) {
    yield {
      type: "error",
      error: normalizeError(error),
    };
  }
};
