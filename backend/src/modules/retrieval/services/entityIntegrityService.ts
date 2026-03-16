import type { RetrievedCandidate, RerankedCandidate } from "../domain/retrievalPipelineTypes.js";
import type { EntityQueryIntent } from "./entityQueryIntentService.js";
import { extractSubjectLabel, normalizeIdentityPhrase, subjectMatchesPhrase } from "./subjectIdentityService.js";

export interface EntityIntegrityResolution {
  contexts: RerankedCandidate[];
  ambiguityDetected: boolean;
  selectedSubjects: string[];
}

export class EntityIntegrityService {
  applyCandidateGuards(input: {
    candidates: RetrievedCandidate[];
    intent: EntityQueryIntent;
  }): RetrievedCandidate[] {
    if (input.intent.mode === "generic" || input.intent.mode === "comparison") {
      return input.candidates;
    }

    return [...input.candidates]
      .map((candidate) => {
        const subjectLabel = candidate.subjectLabel ?? extractSubjectLabel(candidate.retrievalText) ?? extractSubjectLabel(candidate.content);
        const adjustedScore = this.adjustedScore(candidate, subjectLabel, input.intent);

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
    intent: EntityQueryIntent;
    topK: number;
  }): EntityIntegrityResolution {
    const limited = input.contexts.slice(0, input.topK);
    const subjects = limited
      .map((context) => context.subjectLabel ?? extractSubjectLabel(context.retrievalText) ?? extractSubjectLabel(context.content))
      .filter((value): value is string => Boolean(value));
    const distinctSubjects = [...new Set(subjects.map((value) => normalizeIdentityPhrase(value)))];

    if (input.intent.mode === "generic" || input.intent.mode === "comparison") {
      return {
        contexts: limited,
        ambiguityDetected: false,
        selectedSubjects: distinctSubjects,
      };
    }

    const preferredSubject = this.findPreferredSubject(limited, input.intent);
    if (!preferredSubject) {
      return {
        contexts: limited,
        ambiguityDetected: distinctSubjects.length > 1,
        selectedSubjects: distinctSubjects,
      };
    }

    const filtered = limited.filter((context) => {
      const subjectLabel = context.subjectLabel ?? extractSubjectLabel(context.retrievalText) ?? extractSubjectLabel(context.content);

      if (!subjectLabel) {
        return input.intent.includePhrases.some((phrase) =>
          normalizeIdentityPhrase(`${context.title} ${context.retrievalText}`).includes(phrase),
        );
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
    intent: EntityQueryIntent,
  ): number {
    let score = candidate.similarity;

    if (subjectLabel && intent.includePhrases.some((phrase) => subjectMatchesPhrase(subjectLabel, phrase))) {
      score += 1;
    }

    if (subjectLabel && intent.excludePhrases.some((phrase) => subjectMatchesPhrase(subjectLabel, phrase))) {
      score -= 1;
    }

    if (
      subjectLabel &&
      intent.includePhrases.length > 0 &&
      !intent.includePhrases.some((phrase) => subjectMatchesPhrase(subjectLabel, phrase))
    ) {
      score -= 0.5;
    }

    return score;
  }

  private findPreferredSubject(contexts: RerankedCandidate[], intent: EntityQueryIntent): string | null {
    for (const context of contexts) {
      const subjectLabel = context.subjectLabel ?? extractSubjectLabel(context.retrievalText) ?? extractSubjectLabel(context.content);
      if (!subjectLabel) {
        continue;
      }

      const normalized = normalizeIdentityPhrase(subjectLabel);
      if (intent.includePhrases.some((phrase) => subjectMatchesPhrase(subjectLabel, phrase))) {
        return normalized;
      }
    }

    return null;
  }
}
