export interface UsageLimitReservation {
  commit(): Promise<void>;
  release(): Promise<void>;
}

export interface AnswerUsageReservation extends UsageLimitReservation {
  /**
   * Present when this reservation charged a per-conversation-block surface
   * without yet knowing the conversation id — turn 1 of a brand-new
   * conversation, reserved before `chatSessionPreparer.prepare()` has created
   * the conversation row. Call once the real id is known so the next reply's
   * block bookkeeping continues from this charge instead of re-opening (and
   * re-charging) block 1.
   */
  confirmConversationId?(conversationId: string): Promise<void>;
}

export interface IndexedStorageReservationInput {
  accountId?: string | null;
  workspaceId: string;
  contentSizeBytes: number;
  sourceKind?: string;
  externalDocumentId?: string | null;
}

export interface MonthlyIndexedContentReservationInput {
  accountId?: string | null;
  workspaceId: string;
  contentSizeBytes: number;
  sourceKind?: string;
  externalDocumentId?: string | null;
}

export interface UsageLimitPolicy {
  reserveAnswer(input: {
    accountId?: string | null;
    workspaceId: string;
    surface: string;
    /** Customer conversations are metered in blocks of replies; pass the id so
     *  the second reply of a conversation is not charged like the first. */
    conversationId?: string | null;
  }): Promise<AnswerUsageReservation>;
  reserveDocument(input: {
    accountId?: string | null;
    workspaceId: string;
    sourceKind: string;
    externalDocumentId?: string | null;
  }): Promise<UsageLimitReservation>;
  reserveIndexedStorage(input: IndexedStorageReservationInput): Promise<UsageLimitReservation>;
  reserveMonthlyIndexedContent(input: MonthlyIndexedContentReservationInput): Promise<UsageLimitReservation>;
}

/**
 * Stable error code emitted by usage-limit enforcement (EE) when a tier cap is
 * reached. Recognised structurally so OSS code can react to quota exhaustion
 * without depending on the EE module that throws it.
 */
export const USAGE_LIMIT_EXCEEDED_CODE = "usage_limit_exceeded";

export const isUsageLimitExceededError = (
  error: unknown,
): error is { code: string; statusCode?: number; message?: string } =>
  Boolean(
    error &&
      typeof error === "object" &&
      "code" in error &&
      (error as { code?: unknown }).code === USAGE_LIMIT_EXCEEDED_CODE,
  );

const noopReservation: UsageLimitReservation = {
  async commit() {},
  async release() {},
};

export class NoopUsageLimitPolicy implements UsageLimitPolicy {
  async reserveAnswer(): Promise<UsageLimitReservation> {
    return noopReservation;
  }

  async reserveDocument(): Promise<UsageLimitReservation> {
    return noopReservation;
  }

  async reserveIndexedStorage(_input: IndexedStorageReservationInput): Promise<UsageLimitReservation> {
    return noopReservation;
  }

  async reserveMonthlyIndexedContent(_input: MonthlyIndexedContentReservationInput): Promise<UsageLimitReservation> {
    return noopReservation;
  }
}
