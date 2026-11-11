import { givenLinkPolicy, type UnwrappedLinkReason } from "../../../shared/text/givenLinkTargets.js";
import {
  guardMarkdownLinks,
  MarkdownLinkGuardStream,
  type LinkDestinationPolicy,
} from "../../../shared/text/markdownLinkGuard.js";
import type { AnswerSegment } from "../contracts/answerTypes.js";

/** The text an answer call sent its model: everything the model could have read an address in. */
interface AnswerPromptText {
  readonly systemPrompt: string;
  readonly prompt: string;
}

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
 * Keeps an answer's links to the addresses its model was sent. A link to any other
 * address, a `#` fragment, a relative path, or a page title becomes its plain text, so a
 * visitor is never handed an address nobody gave the model.
 *
 * The prompt text is the allow-list: the Results with their `Source:` lines and their own
 * text, the admitted page, the operator's instructions and directives, and the conversation
 * history all reach the model through it, so an address the model was given is in it by
 * construction. The guard reads it as text and never learns which part an address came from.
 *
 * Both entry points read the answer as the visitor does, citation markers already removed:
 * the stream after the citation sanitizer, the finished answer after the presenter. One
 * grammar over the same text is what makes the joined stream equal the finished answer.
 */
export class AnswerLinkGuard {
  private readonly policy: LinkDestinationPolicy<UnwrappedLinkReason>;

  constructor(sent: AnswerPromptText) {
    this.policy = givenLinkPolicy([sent.systemPrompt, sent.prompt]);
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

  /** Guards streamed answer text whose citation markers were already removed. */
  stream(): MarkdownLinkGuardStream<UnwrappedLinkReason> {
    return new MarkdownLinkGuardStream(this.policy);
  }
}
