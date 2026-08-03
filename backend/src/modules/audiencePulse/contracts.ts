import { z } from "zod";

import type { ModelInferencePipeline } from "../../shared/infra/llm/modelInferencePipeline.js";
import type { ModelCallUsageContext } from "../../shared/domain/modelCallUsageContext.js";
import type {
  AudiencePulseStoredReport,
  AudiencePulseWeeklyVolume,
} from "./domain/report.js";
import { AUDIENCE_PULSE_EVIDENCE_EXCERPT_MAX_CHARACTERS } from "./contracts/history.js";
import type {
  AudiencePulseEvidenceAnchor,
  AudiencePulsePromptEvidenceReference,
  AudiencePulseSamplePolicy,
} from "./contracts/history.js";

export type { AudiencePulseEvidence } from "./domain/report.js";
export {
  AUDIENCE_PULSE_EVIDENCE_EXCERPT_MAX_CHARACTERS,
  type AudiencePulseHistorySnapshot,
  type AudiencePulseHistorySource,
  type AudiencePulseEvidenceAnchor,
  type AudiencePulseHydratedEvidence,
  type AudiencePulsePromptEvidenceReference,
  type AudiencePulseSamplePolicy,
} from "./contracts/history.js";

export const AUDIENCE_PULSE_ANALYSIS_DAYS = 30;
export const AUDIENCE_PULSE_SAMPLE_MAX_QUESTIONS = 80;
export const AUDIENCE_PULSE_SAMPLE_MAX_CONVERSATIONS = 60;
export const AUDIENCE_PULSE_SAMPLE_MAX_QUESTIONS_PER_CONVERSATION = 3;
export const AUDIENCE_PULSE_SAMPLE_MAX_EXCERPT_CHARACTERS = 32_000;

export const DEFAULT_AUDIENCE_PULSE_SAMPLE_POLICY: AudiencePulseSamplePolicy = {
  maxQuestions: AUDIENCE_PULSE_SAMPLE_MAX_QUESTIONS,
  maxConversations: AUDIENCE_PULSE_SAMPLE_MAX_CONVERSATIONS,
  maxQuestionsPerConversation: AUDIENCE_PULSE_SAMPLE_MAX_QUESTIONS_PER_CONVERSATION,
  maxExcerptCharacters: AUDIENCE_PULSE_SAMPLE_MAX_EXCERPT_CHARACTERS,
};

export interface AudiencePulseSnapshotRecord {
  workspaceId: string;
  revision: string;
  period: { start: Date; end: Date };
  generatedAt: Date;
  report: AudiencePulseStoredReport;
  promptEvidenceRefs: AudiencePulsePromptEvidenceReference[];
}

export interface AudiencePulseSnapshotStore {
  find(workspaceId: string): Promise<AudiencePulseSnapshotRecord | null>;
  replace(input: Omit<AudiencePulseSnapshotRecord, "revision">): Promise<AudiencePulseSnapshotRecord>;
  invalidate(input: { workspaceId: string; expectedRevision: string }): Promise<boolean>;
}

export interface AudiencePulseRunLease {
  release(): Promise<void>;
}

export interface AudiencePulseRunGate {
  tryAcquire(workspaceId: string): Promise<AudiencePulseRunLease | null>;
}

export interface AudiencePulseInferenceFactory {
  create(input: {
    workspaceContext: { workspaceId: string; accountId?: string | null };
    modelCallContext: ModelCallUsageContext;
  }): Promise<ModelInferencePipeline>;
}

export interface AudiencePulseAuditPort {
  record(input: {
    accountId?: string | null;
    workspaceId?: string | null;
    eventType: string;
    eventStatus: "success" | "failure";
    metadata?: Record<string, unknown>;
  }): Promise<void>;
}

const dateTime = z.string().datetime();
const groundingSchema = z.object({
  grounded: z.number().int().min(0),
  degraded: z.number().int().min(0),
  noSupport: z.number().int().min(0),
  unknown: z.number().int().min(0),
  contentGapEligible: z.number().int().min(0),
});

export const audiencePulseReportResponseSchema = z.object({
  period: z.object({ start: dateTime, end: dateTime }),
  generatedAt: dateTime,
  coverage: z.object({
    populationSize: z.number().int().min(0),
    sampleSize: z.number().int().min(0),
    sampled: z.boolean(),
  }),
  weeklyVolume: z.array(z.object({
    weekStart: dateTime,
    visitorQuestionCount: z.number().int().min(0),
    conversationCount: z.number().int().min(0),
  })),
  summary: z.string(),
  unclassifiedQuestionCount: z.number().int().min(0),
  themes: z.array(z.object({
    id: z.string(),
    title: z.string(),
    description: z.string(),
    sampleCount: z.number().int().min(0),
    distinctQuestionCount: z.number().int().min(0),
    weeklyPulse: z.array(z.object({ weekStart: dateTime, count: z.number().int().min(0) })),
    grounding: groundingSchema,
    evidence: z.array(z.object({
      reference: z.string(),
      conversationId: z.string().uuid(),
      messageId: z.string().uuid(),
      question: z.string().max(AUDIENCE_PULSE_EVIDENCE_EXCERPT_MAX_CHARACTERS),
      occurrenceCount: z.number().int().min(1),
    })),
  })),
  contentGaps: z.array(z.object({
    themeId: z.string(),
    eligibleEvidenceCount: z.number().int().min(0),
    distinctConversationCount: z.number().int().min(0),
  })),
  recommendations: z.array(z.object({
    id: z.string(),
    themeId: z.string(),
    title: z.string(),
    rationale: z.string(),
    questions: z.array(z.string()),
    evidenceReferences: z.array(z.string()),
    startDraft: z.object({ title: z.string(), questions: z.array(z.string()) }),
  })),
  caveats: z.array(z.string()),
});

export type AudiencePulseHydratedReport = z.infer<typeof audiencePulseReportResponseSchema>;

export type AudiencePulseReadResult =
  | { kind: "not_generated" }
  | { kind: "completed"; report: AudiencePulseHydratedReport };

export type AudiencePulseRefreshResult =
  | { kind: "no_traffic"; period: { start: string; end: string }; weeklyVolume: AudiencePulseWeeklyVolume[] }
  | { kind: "unavailable"; reason: "provider" | "validation" | "cancelled" }
  | { kind: "busy" }
  | { kind: "usage_limited" }
  | { kind: "completed"; report: AudiencePulseHydratedReport };

export const audiencePulseReadInputSchema = z.object({
  accountId: z.string().uuid(),
  userId: z.string().uuid(),
  workspaceId: z.string().uuid(),
}).strict();

export const audiencePulseRefreshInputSchema = audiencePulseReadInputSchema.extend({
  signal: z.instanceof(AbortSignal).optional(),
}).strict();

export const audiencePulseEvidenceAnchorRequestSchema = z.object({
  conversationId: z.string().uuid(),
  messageId: z.string().uuid(),
}).strict();

export const audiencePulseEvidenceAnchorInputSchema = audiencePulseReadInputSchema.extend(
  audiencePulseEvidenceAnchorRequestSchema.shape,
).strict();

export interface AudiencePulsePort {
  read(input: z.infer<typeof audiencePulseReadInputSchema>): Promise<AudiencePulseReadResult>;
  refresh(input: z.infer<typeof audiencePulseRefreshInputSchema>): Promise<AudiencePulseRefreshResult>;
  readEvidenceAnchor(
    input: z.infer<typeof audiencePulseEvidenceAnchorInputSchema>,
  ): Promise<AudiencePulseEvidenceAnchor | null>;
}
