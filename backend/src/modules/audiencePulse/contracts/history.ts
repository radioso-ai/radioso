import type { MessageSource } from "@radioso/conversation-contract";

import type {
  AudiencePulseCoverage,
  AudiencePulseEvidence,
  AudiencePulseEvidenceReference,
  AudiencePulseWeeklyVolume,
} from "../domain/report.js";

/** Maximum source text exposed in either a refresh or saved-report response. */
export const AUDIENCE_PULSE_EVIDENCE_EXCERPT_MAX_CHARACTERS = 1_200;

export interface AudiencePulseHistorySnapshot {
  period: { start: Date; end: Date };
  coverage: AudiencePulseCoverage;
  weeklyVolume: AudiencePulseWeeklyVolume[];
  evidence: AudiencePulseEvidence[];
}

/**
 * What happened to one question, with no word of it: the facts every Audience Pulse count reads.
 * The same fields an `AudiencePulseEvidence` carries, so one counting rule serves both.
 */
export type AudiencePulseQuestionOutcome = Pick<
  AudiencePulseEvidence,
  "grounding" | "answerCoverage" | "legacyCoverage" | "contentGapEligible"
> & {
  reference: Pick<AudiencePulseEvidenceReference, "conversationId">;
};

export interface AudiencePulsePromptEvidenceReference extends AudiencePulseEvidenceReference {
  evidenceId: string;
}

export interface AudiencePulseHydratedEvidence {
  evidenceId: string;
  conversationId: string;
  messageId: string;
  /** What a person reads of the question: for a message with photos, the words typed beside them. */
  question: string;
  /** The photos the question's message carried; absent reads as none. */
  questionPhotoCount?: number;
}

/** A server-authorized, bounded history window for one representative source. */
export interface AudiencePulseEvidenceAnchor {
  conversationId: string;
  source: {
    messageId: string;
    role: "user";
    source: "customer";
    /** The words the visitor typed; for a message with photos, never the readings of them. */
    content: string;
    /** The photos the message carried. */
    photoCount: number;
    createdAt: string;
  };
  nextAssistant: {
    messageId: string;
    role: "assistant";
    source: MessageSource;
    content: string;
    createdAt: string;
  } | null;
}

/** Chat owns eligibility, answer pairing, and reauthorization behind this read port. */
export interface AudiencePulseHistorySource {
  /**
   * Every eligible question in the window (spec 956 FR-003): no sample policy, no
   * cap. `evidence.length` always equals `coverage.populationSize`, and
   * `coverage.sampled` is always `false` -- the census clusters the full window, not
   * a sample of it.
   */
  read(input: {
    workspaceId: string;
    analysisStart: Date;
    analysisEnd: Date;
  }): Promise<AudiencePulseHistorySnapshot>;
  /**
   * Every eligible question id in the window. Applies the same eligibility rule
   * `read()` uses (visitor-role, customer/null source, excluding operator test
   * channels) but returns ids only, no content or grounding classification -- the
   * topic census (`censusService.ts`) reads this directly rather than through
   * `read()`'s heavier evidence hydration. `messageIds.length` is the exact,
   * SQL-computed population count — the denominator the dashboard shows.
   */
  listEligibleQuestionIds(input: {
    workspaceId: string;
    analysisStart: Date;
    analysisEnd: Date;
  }): Promise<string[]>;
  /**
   * The same eligibility and per-question classification `read()` applies, over another window,
   * as one text-free outcome per question; an assessment carries its verdict, never the request
   * it restates. A refresh reads the 30 days before its own window this way to compare against.
   */
  readPeriodOutcomes(input: {
    workspaceId: string;
    analysisStart: Date;
    analysisEnd: Date;
    signal?: AbortSignal;
  }): Promise<AudiencePulseQuestionOutcome[]>;
  rehydrate(input: {
    workspaceId: string;
    references: AudiencePulsePromptEvidenceReference[];
  }): Promise<Map<string, AudiencePulseHydratedEvidence>>;
  readEvidenceAnchor(input: {
    workspaceId: string;
    conversationId: string;
    messageId: string;
  }): Promise<AudiencePulseEvidenceAnchor | null>;
}

export type { AudiencePulseEvidence, AudiencePulseWeeklyVolume } from "../domain/report.js";
