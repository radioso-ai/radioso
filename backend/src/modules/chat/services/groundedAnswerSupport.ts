import type { CitationEvidence } from "../contracts/answerTypes.js";
import { AnswerPresentationService } from "./answerPresentationService.js";
import type { GroundedAnswerEnvelope } from "./groundedAnswerEnvelope.js";
import type { GroundingSummary } from "./groundingAssertions.js";
import { diagnoseImplicitCitationSupport } from "./implicitCitationDiagnostics.js";

const answerPresentation = new AnswerPresentationService();

/**
 * True when an `outcome=answer` reply carries no grounding of any kind — no valid
 * sourced anchor and no implicit overlap with a retrieved source — on substantive
 * prose.
 *
 * The anchor-only grounding verdict computes such a reply to `degraded`, which the
 * presenter delivers. That lets the grounded model answer a trivially-computable or
 * general-knowledge request from its own knowledge (e.g. "sqrt(5)") by emitting
 * `outcome=answer` with no citations and still ship the answer, sliding past the
 * scope guard. This is the backstop that recognizes an entirely unsupported answer
 * so the turn declines instead of delivering ungrounded content.
 *
 * It never fires on a decline (`no_support`/`out_of_scope`), on an answer that
 * carries any sourced claim, or on prose the implicit matcher ties back to a
 * retrieved source — so an answer whose content genuinely came from the sources
 * (the model merely omitted anchors) is still delivered. Only applicable when
 * retrieval returned contexts; a page-context answer has a grounding source not
 * represented here and must not be judged against an empty evidence set.
 */
export const isGroundedAnswerUnsupported = (input: {
  outcome: GroundedAnswerEnvelope["outcome"];
  grounding: GroundingSummary;
  answer: string;
  citationEvidence: readonly CitationEvidence[];
}): boolean => {
  if (
    input.outcome !== "answer"
    || input.grounding.verdict === "grounded"
    || input.grounding.sourcedClaimCount > 0
    || input.citationEvidence.length === 0
  ) {
    return false;
  }

  const { answerSegments } = answerPresentation.normalize({
    answer: input.answer,
    citations: [...input.citationEvidence],
  });
  const implicit = diagnoseImplicitCitationSupport(answerSegments, input.citationEvidence);
  return implicit.explicitlyAssertedCount === 0
    && implicit.implicitMatchCount === 0
    && implicit.eligibleSegmentCount > 0;
};
