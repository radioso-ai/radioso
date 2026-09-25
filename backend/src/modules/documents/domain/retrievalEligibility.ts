/** A document's retrieval eligibility: whether it is searchable, and when that lapses. */
interface RetrievalEligibility {
  retrievalEnabled: boolean;
  retrievalExpiresAt: Date | null;
}

/** The subset of a document's current state this rule reads. */
type RetrievalEligibilitySource = RetrievalEligibility;

/** What a caller is asking to change. Fields left `undefined` keep the existing value. */
interface RetrievalEligibilityRequest {
  retrievalEnabled?: boolean;
  retrievalExpiresAt?: Date | null;
}

/**
 * Resolves a document's next retrieval eligibility from its current state and a requested change.
 *
 * Re-enabling retrieval (`retrievalEnabled: true`) clears an already-elapsed `retrievalExpiresAt`
 * rather than carrying it forward: the "auto-exclude after a date, unless the operator re-enables
 * it" contract means a passed expiry must not immediately re-exclude a document someone just
 * switched back on. This is the single reader for that rule — the ingestion service's write path
 * and the operator copilot's document preview both call it, so a proposal card cannot promise an
 * eligibility window Apply would not actually produce.
 */
export const resolveRetrievalEligibility = (
  existing: RetrievalEligibilitySource,
  request: RetrievalEligibilityRequest,
  now: Date = new Date(),
): RetrievalEligibility => {
  const retrievalEnabled = request.retrievalEnabled ?? existing.retrievalEnabled;
  const requested = request.retrievalExpiresAt !== undefined ? request.retrievalExpiresAt : existing.retrievalExpiresAt;
  const clearsElapsedExpiry = request.retrievalEnabled === true && requested !== null && requested.getTime() <= now.getTime();
  return { retrievalEnabled, retrievalExpiresAt: clearsElapsedExpiry ? null : requested };
};
