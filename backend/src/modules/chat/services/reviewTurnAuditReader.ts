import type { AuditEventRecord, AuditEventRepositoryPort } from "../../../db/repositories/auditEventRepository.js";
import { GROUNDING_VERDICTS, type GroundingVerdict } from "../../../shared/domain/groundingDiagnostic.js";
import { ASSISTANT_TURN_OUTCOME, type AssistantTurnOutcome } from "./assistantTurnOutcomeTypes.js";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ANSWER_OUTCOMES: readonly string[] = Object.values(ASSISTANT_TURN_OUTCOME);

/** Which review turn to read: the one that answered `requestMessageId`, recorded by `recordedBy`. */
interface ReviewTurnAuditRequest {
  conversationId: string;
  /** The customer message the review turn answered. */
  requestMessageId: string;
  /** A review of the same message recorded after this is a later turn's, not the one asked for. */
  recordedBy: Date;
}

/** How a review turn went, as its audit records it: an id and codes, never its text. */
export interface ReviewTurnAuditRecord {
  turnId: string;
  answerOutcome: AssistantTurnOutcome | null;
  groundingVerdict: GroundingVerdict | null;
}

const codeOf = <TCode extends string>(value: unknown, codes: readonly string[]): TCode | null =>
  typeof value === "string" && codes.includes(value) ? (value as TCode) : null;

const isReviewOf = (event: AuditEventRecord, request: ReviewTurnAuditRequest): boolean =>
  event.eventStatus === "success"
  && event.metadata.executionMode === "review"
  && event.metadata.requestMessageId === request.requestMessageId
  && event.createdAt.getTime() <= request.recordedBy.getTime();

// Each field is read by name and checked against its kind, so whatever else an older audit row
// carries (answer text, citations, retrieval traces) never leaves this reader.
const toRecord = (event: AuditEventRecord): ReviewTurnAuditRecord | null => {
  const { turnId, answerOutcome, groundingVerdict } = event.metadata;
  if (typeof turnId !== "string" || !UUID.test(turnId)) return null;
  return {
    turnId,
    answerOutcome: codeOf<AssistantTurnOutcome>(answerOutcome, ANSWER_OUTCOMES),
    groundingVerdict: codeOf<GroundingVerdict>(groundingVerdict, GROUNDING_VERDICTS),
  };
};

/**
 * Reads review turns back from their `chat.answer` audit records, which a review completion keys on
 * the message it answered (`requestMessageId`) and the turn (`turnId`). A held reply's reasoning
 * comes from here: a review writes no message row, so its audit record is the turn's only record.
 */
export class ReviewTurnAuditReader {
  constructor(private readonly audit: Pick<AuditEventRepositoryPort, "listChatAnswerEventsByConversationId">) {}

  /** One answer per request, in order; null where no review record of that message is readable. */
  async find(workspaceId: string, requests: readonly ReviewTurnAuditRequest[]): Promise<(ReviewTurnAuditRecord | null)[]> {
    const conversationIds = [...new Set(requests.map((request) => request.conversationId))];
    const eventsByConversation = new Map(await Promise.all(conversationIds.map(async (conversationId) =>
      [conversationId, await this.audit.listChatAnswerEventsByConversationId(workspaceId, conversationId)] as const)));
    return requests.map((request) => {
      const reviews = (eventsByConversation.get(request.conversationId) ?? []).filter((event) => isReviewOf(event, request));
      const newest = reviews.reduce<AuditEventRecord | null>(
        (latest, event) => (latest === null || event.createdAt.getTime() >= latest.createdAt.getTime() ? event : latest),
        null,
      );
      return newest ? toRecord(newest) : null;
    });
  }
}
