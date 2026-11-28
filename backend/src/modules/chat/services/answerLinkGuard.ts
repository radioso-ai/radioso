import { givenLinkPolicy, type UnwrappedLinkReason } from "../../../shared/text/givenLinkTargets.js";
import {
  guardMarkdownLinks,
  MarkdownLinkGuardStream,
  type LinkDestinationPolicy,
} from "../../../shared/text/markdownLinkGuard.js";
import type { AnswerSegment } from "../contracts/answerTypes.js";
import type { ChatGatewayInput } from "../contracts/chatGateway.js";
import { groundedMissPrompt, type FallbackReplyInput } from "./fallbackReplyComposer.js";

/** What a visitor reads of a presented answer: its text, and the segments a surface may render one by one. */
interface VisibleAnswer {
  readonly answer: string;
  readonly answerSegments?: AnswerSegment[];
}

/** One segment for a whole answer, carrying every citation its segments carried. */
const wholeAnswerSegment = (text: string, segments: readonly AnswerSegment[]): AnswerSegment => {
  const citationIndices = [...new Set(segments.flatMap((segment) => segment.citationIndices ?? []))];
  return citationIndices.length > 0 ? { text, citationIndices } : { text };
};

/**
 * Keeps an answer's links to the addresses its models were sent. A link to any other
 * address, a `#` fragment, a relative path, or a page title becomes its plain text, so a
 * visitor is never handed an address nobody gave a model.
 *
 * The allow-list is exactly what the turn's model calls were sent, recorded at each call
 * site as the input passes through `sendsAnswer` or `sendsDecline`: a gateway call's system
 * prompt, prompt, and history, and a focused decline's prompt. The Results with their
 * `Source:` lines and text, the admitted page, the instructions and directives, and the
 * conversation reach the model only that way. The guard reads them as text and never learns
 * which part an address came from.
 *
 * Both entry points read the answer as the visitor does, citation markers already removed:
 * the stream after the citation sanitizer, the finished answer after the presenter. One
 * grammar over the same text is what makes the joined stream equal the finished answer.
 */
export class AnswerLinkGuard {
  private readonly sent: string[] = [];
  private policy: LinkDestinationPolicy<UnwrappedLinkReason> = givenLinkPolicy([]);

  /** Records what a gateway call sends its model, and passes the input on unchanged. */
  sendsAnswer<Input extends ChatGatewayInput>(input: Input): Input {
    this.allow([input.systemPrompt ?? "", input.prompt, ...input.history.map((message) => message.content)]);
    return input;
  }

  /** Records what a focused decline sends its model, and passes the input on unchanged. */
  sendsDecline(input: FallbackReplyInput): FallbackReplyInput {
    const sent = groundedMissPrompt(input);
    this.allow([sent.systemPrompt, sent.prompt]);
    return input;
  }

  private allow(texts: readonly string[]): void {
    this.sent.push(...texts);
    this.policy = givenLinkPolicy(this.sent);
  }

  /**
   * Guards a presented answer. Each segment is guarded on its own, as each is rendered on its
   * own; segments whose guarded text no longer joins to the guarded answer become one.
   */
  present<Presented extends VisibleAnswer>(
    presented: Presented,
  ): { presented: Presented; unwrapped: readonly UnwrappedLinkReason[] } {
    const answer = guardMarkdownLinks(presented.answer, this.policy);
    const segments = presented.answerSegments?.map((segment) => ({
      ...segment,
      text: guardMarkdownLinks(segment.text, this.policy).text,
    }));
    const answerSegments = segments && segments.map((segment) => segment.text).join("") !== answer.text
      ? [wholeAnswerSegment(answer.text, segments)]
      : segments;
    return {
      presented: { ...presented, answer: answer.text, ...(answerSegments ? { answerSegments } : {}) },
      unwrapped: answer.unwrapped,
    };
  }

  /**
   * Guards streamed answer text whose citation markers were already removed, against
   * everything recorded by the time each link is checked.
   */
  stream(): MarkdownLinkGuardStream<UnwrappedLinkReason> {
    return new MarkdownLinkGuardStream((destination) => this.policy(destination));
  }
}
