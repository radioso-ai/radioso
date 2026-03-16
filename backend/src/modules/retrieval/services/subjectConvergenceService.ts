import type {
  RetrievedCandidate,
  SubjectConvergenceMetrics,
  SubjectReference,
} from "../domain/retrievalPipelineTypes.js";
import { normalizeIdentityPhrase } from "./subjectIdentityService.js";

const toReference = (label: string, aliases: string[] = []): SubjectReference => ({
  canonicalLabel: label,
  normalizedKey: normalizeIdentityPhrase(label),
  aliases,
});

export class SubjectConvergenceService {
  evaluate(input: {
    candidates: Array<Pick<RetrievedCandidate, "subjectLabel" | "similarity">>;
    comparative: boolean;
  }): SubjectConvergenceMetrics {
    const groups = new Map<string, { reference: SubjectReference; supportCount: number; scoreMass: number }>();

    for (const candidate of input.candidates) {
      if (!candidate.subjectLabel) {
        continue;
      }
      const normalizedKey = normalizeIdentityPhrase(candidate.subjectLabel);
      if (!normalizedKey) {
        continue;
      }
      const existingKey =
        [...groups.keys()].find((key) => key.includes(normalizedKey) || normalizedKey.includes(key)) ?? normalizedKey;
      const existing = groups.get(existingKey);
      if (existing) {
        existing.supportCount += 1;
        existing.scoreMass += candidate.similarity;
        if (!existing.reference.aliases.includes(candidate.subjectLabel)) {
          existing.reference.aliases.push(candidate.subjectLabel);
        }
        if (candidate.subjectLabel.length < existing.reference.canonicalLabel.length) {
          existing.reference.canonicalLabel = candidate.subjectLabel;
          existing.reference.normalizedKey = normalizeIdentityPhrase(candidate.subjectLabel);
        }
        continue;
      }
      groups.set(existingKey, {
        reference: toReference(candidate.subjectLabel),
        supportCount: 1,
        scoreMass: candidate.similarity,
      });
    }

    const ranked = [...groups.values()].sort((left, right) => {
      if (right.scoreMass !== left.scoreMass) {
        return right.scoreMass - left.scoreMass;
      }
      return right.supportCount - left.supportCount;
    });

    const winner = ranked[0];
    const runnerUp = ranked[1];
    const winnerMargin = winner ? winner.scoreMass - (runnerUp?.scoreMass ?? 0) : 0;
    const ambiguous =
      input.comparative ||
      !winner ||
      (Boolean(runnerUp) && winnerMargin < 0.2 && winner.supportCount === runnerUp.supportCount);

    return {
      winningSubject: !ambiguous && winner ? winner.reference : null,
      runnerUpSubject: runnerUp?.reference ?? null,
      supportCount: winner?.supportCount ?? 0,
      scoreMass: winner?.scoreMass ?? 0,
      runnerUpScoreMass: runnerUp?.scoreMass ?? 0,
      winnerMargin,
      agreementAcrossPaths: false,
      isComparative: input.comparative,
      isAmbiguous: ambiguous,
    };
  }
}
