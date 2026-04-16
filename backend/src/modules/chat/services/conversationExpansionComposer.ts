import type { AnswerSegment, ChatCitation, CitationEvidence, PresentedAnswer } from "./answerPresentationService.js";
import type { ConversationExpansionPlan } from "./conversationExpansionPlanner.js";

export class ConversationExpansionComposer {
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

    const heading = input.plan.style === "focused" ? "Focused next:" : "Explore further:";
    const baseSegments = input.baseAnswerSegments && input.baseAnswerSegments.length > 0
      ? [...input.baseAnswerSegments]
      : [{ text: input.baseAnswer }];
    const citations = [...(input.visibleCitations ?? [])];
    const combinedSegments: AnswerSegment[] = [...baseSegments, { text: `\n\n${heading}\n` }];

    for (let index = 0; index < input.plan.suggestions.length; index += 1) {
      const suggestion = input.plan.suggestions[index]!;
      const citationEvidence = input.citationEvidence[suggestion.resultNumber - 1];
      const trailingNewline = index < input.plan.suggestions.length - 1 || input.plan.followUpQuestion ? "\n" : "";

      if (!citationEvidence) {
        combinedSegments.push({
          text: `- ${suggestion.title}: ${suggestion.excerpt}${trailingNewline}`,
        });
        continue;
      }

      let citationIndex = citations.findIndex((citation) => citation.documentId === citationEvidence.documentId);
      if (citationIndex < 0) {
        citations.push({
          documentId: citationEvidence.documentId,
          chunkId: citationEvidence.chunkId,
          title: citationEvidence.title,
        });
        citationIndex = citations.length - 1;
      }

      combinedSegments.push({
        text: `- ${suggestion.title}: ${suggestion.excerpt}${trailingNewline}`,
        citationIndices: [citationIndex],
      });
    }

    if (input.plan.followUpQuestion) {
      combinedSegments.push({ text: input.plan.followUpQuestion });
    }

    const combinedAnswer = combinedSegments.map((segment) => segment.text).join("");

    return {
      answer: combinedAnswer,
      citations: input.citationDisplayEnabled ? citations : undefined,
      answerSegments: input.citationDisplayEnabled ? combinedSegments : undefined,
      expansionApplied: true,
      expansionKind: input.plan.style,
      suggestionCount: input.plan.suggestions.length,
      followUpQuestionApplied: Boolean(input.plan.followUpQuestion),
    };
  }
}
