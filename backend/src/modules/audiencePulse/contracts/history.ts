import type { MessageSource } from "@radioso/conversation-contract";

import type {
  AudiencePulseCoverage,
  AudiencePulseEvidence,
  AudiencePulseEvidenceReference,
  AudiencePulseWeeklyVolume,
} from "../domain/report.js";

/** Maximum source text exposed in either a refresh or saved-report response. */
export const AUDIENCE_PULSE_EVIDENCE_EXCERPT_MAX_CHARACTERS = 1_200;

export interface AudiencePulseSamplePolicy {
  maxQuestions: number;
  maxConversations: number;
  maxQuestionsPerConversation: number;
  maxExcerptCharacters: number;
}

export interface AudiencePulseHistorySnapshot {
  period: { start: Date; end: Date };
  coverage: AudiencePulseCoverage;
  weeklyVolume: AudiencePulseWeeklyVolume[];
  evidence: AudiencePulseEvidence[];
}

export interface AudiencePulsePromptEvidenceReference extends AudiencePulseEvidenceReference {
  evidenceId: string;
}

export interface AudiencePulseHydratedEvidence {
  evidenceId: string;
  conversationId: string;
  messageId: string;
  question: string;
}

/** A server-authorized, bounded history window for one representative source. */
export interface AudiencePulseEvidenceAnchor {
  conversationId: string;
  source: {
    messageId: string;
    role: "user";
    source: "customer";
    content: string;
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
  read(input: {
    workspaceId: string;
    analysisStart: Date;
    analysisEnd: Date;
    samplePolicy: AudiencePulseSamplePolicy;
  }): Promise<AudiencePulseHistorySnapshot>;
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

export type { AudiencePulseEvidence } from "../domain/report.js";
