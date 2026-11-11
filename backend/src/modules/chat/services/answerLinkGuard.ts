import { GivenLinkTargets, type UnwrappedLinkReason } from "../../../shared/text/givenLinkTargets.js";
import {
  guardMarkdownLinks,
  MarkdownLinkGuardStream,
  type GuardedMarkdown,
} from "../../../shared/text/markdownLinkGuard.js";
import { findCitationAnchorSyntax } from "./citationAnchorSyntax.js";
import { canonicalizeUnsourcedMarkers } from "./unsourcedMarkerCanonicalization.js";

/** The text an answer call sent its model: everything the model could have read an address in. */
interface AnswerPromptText {
  readonly systemPrompt: string;
  readonly prompt: string;
}

export type GuardedAnswer = GuardedMarkdown<UnwrappedLinkReason>;

/**
 * Keeps an answer's links to the addresses its model was sent. A link to any other
 * address, a `#` fragment, a relative path, or a page title becomes its plain text, so a
 * visitor is never handed an address nobody gave the model.
 *
 * The prompt text is the allow-list: the Results with their `Source:` lines and their own
 * text, the admitted page, the operator's instructions and directives, and the conversation
 * history all reach the model through it, so an address the model was given is in it by
 * construction. The guard reads it as text and never learns which part an address came from.
 */
export class AnswerLinkGuard {
  private readonly targets: GivenLinkTargets;

  constructor(sent: AnswerPromptText) {
    this.targets = new GivenLinkTargets([sent.systemPrompt, sent.prompt]);
  }

  /**
   * Guards a finished answer that still carries its citation markers. The markers are
   * opaque to the guard, so they survive inside an unwrapped link's text and are never read
   * as link text themselves; a single-bracket `[?]` is read as the marker it stands for.
   */
  apply(answer: string): GuardedAnswer {
    const canonical = canonicalizeUnsourcedMarkers(answer);
    return guardMarkdownLinks(canonical, this.policy, {
      ignoredRanges: findCitationAnchorSyntax(canonical, { endsAnswer: true }),
    });
  }

  /** Guards streamed answer text whose citation markers were already removed. */
  stream(): MarkdownLinkGuardStream<UnwrappedLinkReason> {
    return new MarkdownLinkGuardStream(this.policy);
  }

  private readonly policy = (destination: string) => this.targets.verdictFor(destination);
}
