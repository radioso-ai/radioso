import type {
  ConversationMessage,
  ConversationModelGateway,
  ConversationModelRequest,
} from "@radioso/conversation-contract";

import type { ChatGateway, ChatGatewayInput, ChatGatewayUsageContext } from "../../contracts/chatGateway.js";
import { BlankChatAnswerError, isBlankChatAnswerError } from "../chatAnswerErrors.js";
import { CHAT_BEHAVIOR } from "../../../../shared/domain/behaviorConfig.js";
import type { LlmCapabilityResolveInput } from "../../../../shared/infra/llm/workspaceContext.js";

/**
 * The host gateway a routine generates through. It always completes; it streams only when
 * it has `streamAnswer`.
 */
export type RoutineChatGateway = Pick<ChatGateway, "answer"> & Partial<Pick<ChatGateway, "streamAnswer">>;

type StreamingRoutineChatGateway = Pick<ChatGateway, "answer" | "streamAnswer">;

const canStream = (gateway: RoutineChatGateway): gateway is StreamingRoutineChatGateway =>
  typeof gateway.streamAnswer === "function";

/** The per-turn billing + model-resolution context a routine LLM call needs. */
interface RoutineModelTurnContext {
  workspaceContext: LlmCapabilityResolveInput;
  usageContext: ChatGatewayUsageContext;
  signal?: AbortSignal;
}

/**
 * Renders the conversation transcript the routine selector/renderer pass as a single
 * prompt string. The host chat gateway is prompt-based (it ignores the structured
 * `query`/`history` fields), so the transcript must live in `prompt`. Roles are
 * structural labels, not product vocabulary.
 */
const serializeTranscript = (messages: ConversationMessage[]): string =>
  messages.map((message) => `${message.role}: ${message.content}`).join("\n");

const lastUserContent = (messages: ConversationMessage[]): string => {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    if (messages[index].role === "user") {
      return messages[index].content;
    }
  }
  return "";
};

const isRoutineActivationCall = (metadata: Record<string, unknown> | undefined): boolean =>
  metadata?.routineActivation === true;

const routineActivationUsageContext = (usageContext: ChatGatewayUsageContext): ChatGatewayUsageContext => ({
  ...usageContext,
  operation: "routine_activation",
  attemptKey: `${usageContext.attemptKey}:routine_activation`,
});

/**
 * `usage_events.idempotency_key` is unique, and it is built from `attemptKey` among other
 * fields, so every call in a turn sharing one attemptKey means only the first survives
 * `ON CONFLICT DO NOTHING` (#1378). The first call keeps the turn's attemptKey unchanged —
 * single-call turns and existing dashboards are unaffected — and each later call gets its
 * own, ordered by call order.
 */
const withCallOrdinal = (usageContext: ChatGatewayUsageContext, ordinal: number): ChatGatewayUsageContext =>
  ordinal === 1 ? usageContext : { ...usageContext, attemptKey: `${usageContext.attemptKey}:${ordinal}` };

/** The retry of a call whose answer came back blank, metered under that call's own attempt. */
const blankRetryRequest = (request: ChatGatewayInput): ChatGatewayInput => ({
  ...request,
  usageContext: { ...request.usageContext, attemptKey: `${request.usageContext.attemptKey}:blank_retry` },
});

/** Streams one completion, holding leading whitespace until text follows it; returns whether any text came. */
async function* streamUnlessBlank(
  host: StreamingRoutineChatGateway,
  request: ChatGatewayInput,
): AsyncGenerator<string, boolean> {
  let leadingWhitespace = "";
  let started = false;
  for await (const delta of host.streamAnswer(request)) {
    if (started) {
      yield delta;
      continue;
    }
    leadingWhitespace += delta;
    if (leadingWhitespace.trim()) {
      started = true;
      yield leadingWhitespace;
    }
  }
  return started;
}

/** Streams a completion, retrying it once, under its blank-retry usage attempt, when it comes back blank. */
async function* streamRetryingBlank(
  host: StreamingRoutineChatGateway,
  request: ChatGatewayInput,
): AsyncGenerator<string> {
  if (yield* streamUnlessBlank(host, request)) {
    return;
  }
  if (!(yield* streamUnlessBlank(host, blankRetryRequest(request)))) {
    throw new BlankChatAnswerError();
  }
}

/**
 * Adapts the host {@link ChatGateway} to the engine's {@link ConversationModelGateway}
 * for routine progression. Built per turn (it carries that turn's usage + workspace
 * context, which are not on the engine's `TurnContext`), it lets the routine next-step
 * selector and step renderer generate through the same workspace/usage-accounted model
 * as normal chat answers, whole or streamed. Generation stays LLM-owned; this only bridges
 * the shapes.
 */
export class RoutineChatModelGateway implements ConversationModelGateway {
  // Assigned in call order, at call start, so the ordinal is deterministic regardless of
  // when each call settles.
  private callCount = 0;

  constructor(
    private readonly chatGateway: RoutineChatGateway,
    private readonly turn: RoutineModelTurnContext,
  ) {}

  /**
   * The same request as a completion, streamed; undefined when the host gateway cannot
   * stream. A blank answer is retried once under the same usage attempts a completion's
   * retry uses, so a turn is metered alike whichever way its reply is generated. Leading
   * whitespace is held until text follows it, so a blank attempt shows nothing; a retry
   * still blank fails as a completion's does.
   */
  get stream(): ((input: ConversationModelRequest) => AsyncIterable<string>) | undefined {
    const host = this.chatGateway;
    // The usage attempt is assigned when the stream is asked for, in call order, not when it
    // is first read.
    return canStream(host) ? (input) => streamRetryingBlank(host, this.nextRequest(input)) : undefined;
  }

  async complete(input: ConversationModelRequest): Promise<{ text: string }> {
    const request = this.nextRequest(input);
    try {
      return { text: await this.chatGateway.answer(request) };
    } catch (error) {
      // The model occasionally returns an empty completion for a routine prompt, and one
      // blank call used to fail the whole turn. Retry once, under its own usage attempt so
      // the failed call and the retry are both accounted for.
      if (!isBlankChatAnswerError(error)) {
        throw error;
      }
      return { text: await this.chatGateway.answer(blankRetryRequest(request)) };
    }
  }

  /** The host request for the turn's next model call, metered under that call's own usage attempt. */
  private nextRequest(input: ConversationModelRequest): ChatGatewayInput {
    this.callCount += 1;
    const routineActivation = isRoutineActivationCall(input.metadata);
    const baseUsageContext = routineActivation
      ? routineActivationUsageContext(this.turn.usageContext)
      : this.turn.usageContext;
    return {
      query: lastUserContent(input.messages),
      history: [],
      prompt: serializeTranscript(input.messages),
      systemPrompt: input.systemPrompt,
      workspaceContext: this.turn.workspaceContext,
      usageContext: withCallOrdinal(baseUsageContext, this.callCount),
      ...(routineActivation ? { generation: CHAT_BEHAVIOR.intentRouting } : {}),
      ...(this.turn.signal ? { signal: this.turn.signal } : {}),
    };
  }
}
