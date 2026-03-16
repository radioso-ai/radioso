import { describe, expect, it } from "vitest";

import type { RetrievedCandidate } from "../../src/modules/retrieval/domain/retrievalPipelineTypes.js";
import { SubjectConvergenceService } from "../../src/modules/retrieval/services/subjectConvergenceService.js";
import { SubjectContinuityService } from "../../src/modules/retrieval/services/subjectContinuityService.js";

const candidate = (input: {
  chunkId: string;
  subjectLabel?: string | null;
  similarity?: number;
}): RetrievedCandidate => ({
  chunkId: input.chunkId,
  documentId: `doc-${input.chunkId}`,
  title: `Title ${input.chunkId}`,
  content: input.subjectLabel ? `Subject: ${input.subjectLabel}\nBody` : "Body",
  searchText: input.subjectLabel ? `Subject: ${input.subjectLabel}\nBody` : "Body",
  similarity: input.similarity ?? 0.8,
  retrievalSources: ["semantic_original"],
  retrievalText: input.subjectLabel ? `Subject: ${input.subjectLabel}\nBody` : "Body",
  semanticScore: input.similarity ?? 0.8,
  lexicalScore: 0,
  attributeMatchScore: 0,
  subjectLabel: input.subjectLabel ?? null,
});

describe("subject continuity", () => {
  it("converges on one normalized subject identity", () => {
    const service = new SubjectConvergenceService();

    const result = service.evaluate({
      candidates: [
        candidate({ chunkId: "1", subjectLabel: "Narayani", similarity: 0.92 }),
        candidate({ chunkId: "2", subjectLabel: "Narayani Anaya", similarity: 0.87 }),
        candidate({ chunkId: "3", subjectLabel: "Premi", similarity: 0.41 }),
      ],
      comparative: false,
    });

    expect(result.winningSubject?.canonicalLabel).toBe("Narayani");
    expect(result.winningSubject?.normalizedKey).toBe("narayani");
    expect(result.supportCount).toBe(2);
    expect(result.isAmbiguous).toBe(false);
  });

  it("marks split evidence as ambiguous", () => {
    const service = new SubjectConvergenceService();

    const result = service.evaluate({
      candidates: [
        candidate({ chunkId: "1", subjectLabel: "Narayani", similarity: 0.83 }),
        candidate({ chunkId: "2", subjectLabel: "Premi", similarity: 0.81 }),
      ],
      comparative: false,
    });

    expect(result.winningSubject).toBeNull();
    expect(result.isAmbiguous).toBe(true);
  });

  it("replaces a carried subject when raw retrieval converges on a different explicit subject", () => {
    const continuity = new SubjectContinuityService();

    const result = continuity.decide({
      previous: {
        resolvedSubject: {
          canonicalLabel: "Narayani",
          normalizedKey: "narayani",
          aliases: [],
        },
        resolutionOutcome: "reused",
        resolutionConfidence: 0.95,
        resolutionSourceTurnId: "turn-1",
        resolutionEvidence: {
          winningSubject: {
            canonicalLabel: "Narayani",
            normalizedKey: "narayani",
            aliases: [],
          },
          runnerUpSubject: null,
          supportCount: 2,
          scoreMass: 1.9,
          runnerUpScoreMass: 0,
          winnerMargin: 1.9,
          agreementAcrossPaths: true,
          isComparative: false,
          isAmbiguous: false,
        },
        stateVersion: 1,
      },
      raw: {
        winningSubject: {
          canonicalLabel: "Premi",
          normalizedKey: "premi",
          aliases: [],
        },
        runnerUpSubject: null,
        supportCount: 2,
        scoreMass: 1.8,
        runnerUpScoreMass: 0,
        winnerMargin: 1.8,
        agreementAcrossPaths: false,
        isComparative: false,
        isAmbiguous: false,
      },
      biased: {
        winningSubject: {
          canonicalLabel: "Narayani",
          normalizedKey: "narayani",
          aliases: [],
        },
        runnerUpSubject: null,
        supportCount: 2,
        scoreMass: 1.7,
        runnerUpScoreMass: 0,
        winnerMargin: 1.7,
        agreementAcrossPaths: false,
        isComparative: false,
        isAmbiguous: false,
      },
      explicitCurrentSubject: {
        canonicalLabel: "Premi",
        normalizedKey: "premi",
        aliases: [],
      },
      selfContained: true,
      turnId: "turn-2",
    });

    expect(result.resolutionOutcome).toBe("replaced");
    expect(result.resolvedSubject?.normalizedKey).toBe("premi");
  });
});
