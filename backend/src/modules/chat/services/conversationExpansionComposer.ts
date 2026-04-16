import {
  AnswerPresentationService,
  type AnswerSegment,
  type ChatCitation,
  type CitationEvidence,
  type PresentedAnswer,
} from "./answerPresentationService.js";
import type { ConversationExpansionPlan } from "./conversationExpansionPlanner.js";

const resolveResultNumber = (
  citation: ChatCitation,
  citationEvidence: CitationEvidence[],
): number | null => {
  const index = citationEvidence.findIndex((candidate) => candidate.chunkId === citation.chunkId);
  return index >= 0 ? index + 1 : null;
};

const renderAnchoredBaseAnswer = (
  baseAnswer: string,
  baseAnswerSegments: AnswerSegment[] | undefined,
  visibleCitations: ChatCitation[],
  citationEvidence: CitationEvidence[],
): string => {
  if (!baseAnswerSegments || baseAnswerSegments.length === 0) {
    return baseAnswer;
  }

  return baseAnswerSegments.map((segment) => {
    const anchors = (segment.citationIndices ?? [])
      .map((index) => visibleCitations[index])
      .map((citation) => (citation ? resolveResultNumber(citation, citationEvidence) : null))
      .filter((resultNumber): resultNumber is number => typeof resultNumber === "number")
      .map((resultNumber) => `[[${resultNumber}]]`)
      .join("");

    return `${segment.text}${anchors}`;
  }).join("");
};

export class ConversationExpansionComposer {
  private readonly answerPresentationService = new AnswerPresentationService();

  compose(input: {
    baseAnswer: string;
    baseAnswerSegments?: AnswerSegment[];
    visibleCitations?: ChatCitation[];
    citationEvidence: CitationEvidence[];
    citationDisplayEnabled: boolean;
    plan: ConversationExpansionPlan;
  }): PresentedAnswer & {
    expansionApplied: boolean;
    expansionKind: "none" | "focused" | "expansive";
    suggestionCount: number;
    followUpQuestionApplied: boolean;
  } {
    if (!input.plan.applied || input.plan.suggestions.length === 0) {
      return {
        answer: input.baseAnswer,
        citations: input.visibleCitations,
        answerSegments: input.baseAnswerSegments,
        expansionApplied: false,
        expansionKind: "none",
        suggestionCount: 0,
        followUpQuestionApplied: false,
      };
    }

    const baseAnswer = renderAnchoredBaseAnswer(
      input.baseAnswer,
      input.baseAnswerSegments,
      input.visibleCitations ?? [],
      input.citationEvidence,
    );

    const heading = input.plan.style === "focused" ? "Focused next:" : "Explore further:";
    const suggestionLines = input.plan.suggestions.map((suggestion) =>
      `- ${suggestion.title}: ${suggestion.excerpt}[[${suggestion.resultNumber}]]`,
    );
    const followUpLine = input.plan.followUpQuestion ? `\n${input.plan.followUpQuestion}` : "";
    const combinedAnswer = `${baseAnswer}\n\n${heading}\n${suggestionLines.join("\n")}${followUpLine}`;
    const presented = this.answerPresentationService.present({
      answer: combinedAnswer,
      citations: input.citationEvidence,
      citationDisplayEnabled: input.citationDisplayEnabled,
    });

    return {
      ...presented,
      expansionApplied: true,
      expansionKind: input.plan.style,
      suggestionCount: input.plan.suggestions.length,
      followUpQuestionApplied: Boolean(input.plan.followUpQuestion),
    };
  }
}
