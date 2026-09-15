export interface UsageLimitReservation {
  commit(): Promise<void>;
  release(): Promise<void>;
}

/** What an answer reservation is, for metering. Callers declare it; the EE policy prices it. */
export type AnswerUsageKind =
  | "conversation_reply" // a reply in a customer conversation; metered per block of replies
  | "standalone_answer" // one-shot retrieval/MCP answer; each call is its own conversation
  | "greeting" // widget greeting on open; free on the conversation meter
  | "copilot_turn" // Ray turn or Ray probe
  | "test_run" // dashboard test chat, workbench replay, eval replay, test execution
  | "pulse_report"; // Audience Pulse report

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
    /** Attribution only (logs/audit). Pricing comes from `usage`. */
    surface: string;
    usage: AnswerUsageKind;
    /** Customer conversations are metered in blocks of replies; pass the id so
     *  the second reply of a conversation is not charged like the first. */
    conversationId?: string | null;
  }): Promise<UsageLimitReservation>;
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
