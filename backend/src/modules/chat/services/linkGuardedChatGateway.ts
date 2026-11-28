import type { MetricsRegistry } from "../../../shared/observability/metrics/metricsRegistry.js";
import type { ChatGateway, ChatGatewayInput } from "../contracts/chatGateway.js";
import { AnswerLinkGuard } from "./answerLinkGuard.js";
import { BlankChatAnswerError } from "./chatAnswerErrors.js";
import { RetrievalAnswerMetrics, type AnswerLinkPath } from "./retrievalAnswerMetrics.js";

/**
 * A {@link ChatGateway} that keeps the visitor-facing text it completes to the addresses its
 * own input holds. It guards only a call that says its completion is read as written
 * (`writesVisitorText`): a routine step's reply, a handoff message. Every other completion is
 * something else's input, such as a router's JSON or a structured envelope, and passes
 * through byte for byte.
 *
 * It knows the gateway port and the link guard, nothing about routines: a caller marks what a
 * visitor reads, and the allow-list is exactly what that call sent its model. An address the
 * input does not hold is removed from the text, as it is from every other answer a visitor
 * reads. A completion that was only such an address comes back blank, which the caller's
 * blank handling already treats as a failed attempt.
 */
export class LinkGuardedChatGateway implements ChatGateway {
  private readonly counters: RetrievalAnswerMetrics;

  constructor(
    private readonly inner: ChatGateway,
    private readonly path: AnswerLinkPath,
    metrics?: Pick<MetricsRegistry, "incrementCounter"> | null,
  ) {
    this.counters = new RetrievalAnswerMetrics(metrics);
  }

  async answer(input: ChatGatewayInput): Promise<string> {
    const completion = await this.inner.answer(input);
    if (!input.writesVisitorText) {
      return completion;
    }
    const guard = new AnswerLinkGuard();
    guard.sendsAnswer(input);
    const { presented, unwrapped } = guard.present({ answer: completion });
    this.counters.unwrappedLinks(unwrapped, false, this.path);
    if (completion.trim() && !presented.answer.trim()) {
      throw new BlankChatAnswerError();
    }
    return presented.answer;
  }

  async *streamAnswer(input: ChatGatewayInput): AsyncIterable<string> {
    if (!input.writesVisitorText) {
      yield* this.inner.streamAnswer(input);
      return;
    }
    const guard = new AnswerLinkGuard();
    guard.sendsAnswer(input);
    const guarded = guard.stream();
    for await (const delta of this.inner.streamAnswer(input)) {
      const released = guarded.push(delta);
      if (released) {
        yield released;
      }
    }
    const tail = guarded.flush();
    this.counters.unwrappedLinks(guarded.unwrapped, true, this.path);
    if (tail) {
      yield tail;
    }
  }
}
