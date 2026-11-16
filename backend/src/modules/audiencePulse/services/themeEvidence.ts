import { isShortfallStatus, type AudiencePulseAnswerStatus } from "../domain/answerStatus.js";
import type { AudiencePulseEvidence, AudiencePulseStoredTheme } from "../domain/report.js";
import type { AudiencePulseHydratedEvidence, AudiencePulseHydratedReport } from "../contracts.js";

type AudiencePulseThemeResponse = AudiencePulseHydratedReport["themes"][number];
type AudiencePulseEvidenceResponse = AudiencePulseThemeResponse["evidence"][number];

/**
 * What a fresh report shows of each question it just read: the words a person reads, and how many
 * photos came with them. The census and the models keep the full question (the readings of any
 * photos included); the report never does.
 */
export const createHydratedEvidence = (evidence: AudiencePulseEvidence[]): Map<string, AudiencePulseHydratedEvidence> =>
  new Map(evidence.map((item) => [item.id, {
    evidenceId: item.id,
    conversationId: item.reference.conversationId,
    messageId: item.reference.messageId,
    question: item.displayQuestion ?? item.question,
    questionPhotoCount: item.questionPhotoCount ?? 0,
  }]));

const normalizeQuestionForDisplay = (question: string): string => question
  .trim()
  .replace(/\s+/gu, " ");

const questionDisplayKey = (question: string): string => normalizeQuestionForDisplay(question).toLowerCase();

/**
 * Merges repeated occurrences of a question into one example, but only within one
 * answer status and one photo count: a question answered twice and unanswered once shows
 * as two examples, and the same words sent with different photos are different questions
 * to the person reading them. Shortfalls lead, keeping the stored order otherwise.
 */
export const hydrateThemeEvidence = (
  evidenceIds: string[],
  resolve: (evidenceId: string) => AudiencePulseHydratedEvidence,
  statusOf: (evidenceId: string) => AudiencePulseAnswerStatus | undefined,
  coverageByEvidenceId?: AudiencePulseStoredTheme["coverageByEvidenceId"],
): Pick<AudiencePulseThemeResponse, "distinctQuestionCount" | "evidence"> => {
  const occurrences = new Map<string, AudiencePulseEvidenceResponse>();
  const distinctQuestions = new Set<string>();
  for (const evidenceId of evidenceIds) {
    const source = resolve(evidenceId);
    const question = normalizeQuestionForDisplay(source.question);
    const questionPhotoCount = source.questionPhotoCount ?? 0;
    const status = statusOf(evidenceId);
    const questionKey = `${questionDisplayKey(question)}\u0000${questionPhotoCount}`;
    distinctQuestions.add(questionKey);
    const key = `${questionKey}\u0000${status ?? ""}`;
    const existing = occurrences.get(key);
    if (existing) {
      existing.occurrenceCount += 1;
      continue;
    }
    occurrences.set(key, {
      reference: source.evidenceId,
      conversationId: source.conversationId,
      messageId: source.messageId,
      question,
      questionPhotoCount,
      occurrenceCount: 1,
      ...(coverageByEvidenceId?.[source.evidenceId] ? { answerCoverage: coverageByEvidenceId[source.evidenceId] } : {}),
      ...(status ? { answerStatus: status } : {}),
    });
  }
  const shortfallsFirst = (example: AudiencePulseEvidenceResponse): number =>
    example.answerStatus && isShortfallStatus(example.answerStatus) ? 0 : 1;
  return {
    distinctQuestionCount: distinctQuestions.size,
    evidence: [...occurrences.values()].sort((left, right) => shortfallsFirst(left) - shortfallsFirst(right)),
  };
};
