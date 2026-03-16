import type { RetrievedCandidate, RerankedCandidate } from "../domain/retrievalPipelineTypes.js";
import type { MessageRecord } from "../../../db/repositories/messageRepository.js";
import { extractSubjectLabel, normalizeIdentityPhrase } from "./subjectIdentityService.js";

export interface EntityIntegrityResolution {
  contexts: RerankedCandidate[];
  ambiguityDetected: boolean;
  selectedSubjects: string[];
}

export class EntityIntegrityService {
  applyCandidateGuards(input: {
    candidates: RetrievedCandidate[];
    query: string;
    history: MessageRecord[];
  }): RetrievedCandidate[] {
    return [...input.candidates]
      .map((candidate) => {
        const subjectLabel = candidate.subjectLabel ?? extractSubjectLabel(candidate.retrievalText) ?? extractSubjectLabel(candidate.content);
        const adjustedScore = this.adjustedScore(candidate, subjectLabel, input);

        return {
          ...candidate,
          subjectLabel,
          similarity: adjustedScore,
          semanticScore: adjustedScore,
        };
      })
      .sort((left, right) => right.similarity - left.similarity);
  }

  resolveContexts(input: {
    contexts: RerankedCandidate[];
    query: string;
    history: MessageRecord[];
    topK: number;
  }): EntityIntegrityResolution {
    const limited = input.contexts.slice(0, input.topK);
    const subjects = limited
      .map((context) => context.subjectLabel ?? extractSubjectLabel(context.retrievalText) ?? extractSubjectLabel(context.content))
      .filter((value): value is string => Boolean(value));
    const distinctSubjects = [...new Set(subjects.map((value) => normalizeIdentityPhrase(value)))];
    const queryMatchedSubjects = distinctSubjects.filter((subject) =>
      this.collectFocusTexts(input.query, input.history).some((text) => text.includes(subject)),
    );

    if (queryMatchedSubjects.length > 1) {
      return {
        contexts: limited,
        ambiguityDetected: distinctSubjects.length > queryMatchedSubjects.length,
        selectedSubjects: queryMatchedSubjects,
      };
    }

    const preferredSubject = this.findPreferredSubject(limited, input);
    if (!preferredSubject) {
      return {
        contexts: limited,
        ambiguityDetected: distinctSubjects.length > 1,
        selectedSubjects: distinctSubjects.length > 1 ? [] : distinctSubjects,
      };
    }

    const filtered = limited.filter((context) => {
      const subjectLabel = context.subjectLabel ?? extractSubjectLabel(context.retrievalText) ?? extractSubjectLabel(context.content);

      if (!subjectLabel) {
        return false;
      }

      return normalizeIdentityPhrase(subjectLabel) === preferredSubject;
    });

    return {
      contexts: filtered.length > 0 ? filtered : limited,
      ambiguityDetected: distinctSubjects.length > 1,
      selectedSubjects: preferredSubject ? [preferredSubject] : distinctSubjects,
    };
  }

  private adjustedScore(
    candidate: RetrievedCandidate,
    subjectLabel: string | null,
    input: {
      query: string;
      history: MessageRecord[];
    },
  ): number {
    let score = candidate.similarity;
    const focusTexts = this.collectFocusTexts(input.query, input.history);

    if (subjectLabel && focusTexts.some((text) => text.includes(normalizeIdentityPhrase(subjectLabel)))) {
      score += 1;
    }

    return score;
  }

  private findPreferredSubject(
    contexts: RerankedCandidate[],
    input: {
      query: string;
      history: MessageRecord[];
    },
  ): string | null {
    const focusTexts = this.collectFocusTexts(input.query, input.history);

    for (const context of contexts) {
      const subjectLabel = context.subjectLabel ?? extractSubjectLabel(context.retrievalText) ?? extractSubjectLabel(context.content);
      if (!subjectLabel) {
        continue;
      }

      const normalized = normalizeIdentityPhrase(subjectLabel);
      if (focusTexts.some((text) => text.includes(normalized))) {
        return normalized;
      }
    }

    return null;
  }

  private collectFocusTexts(query: string, history: MessageRecord[]): string[] {
    const latestUserMessages = history
      .filter((message) => message.role === "user")
      .slice(-2)
      .map((message) => normalizeIdentityPhrase(message.content))
      .filter(Boolean);

    return [normalizeIdentityPhrase(query), ...latestUserMessages].filter(Boolean);
  }
}
