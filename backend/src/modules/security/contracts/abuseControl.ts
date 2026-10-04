export interface AbuseControlPolicy {
  scope: string;
  subjectKey: string;
  limit: number;
  windowMs: number;
  blockMs?: number;
  now?: Date;
}

export interface AbuseControlEntry {
  scope: string;
  subjectKey: string;
  attemptCount: number;
  /** What the window before this one counted, once it has expired; 0 when nothing overlaps. */
  previousAttemptCount: number;
  windowStartedAt: Date;
  blockedUntil: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface AbuseControlConsumptionInput {
  scope: string;
  subjectKey: string;
  limit: number;
  windowMs: number;
  blockMs: number;
  now: Date;
}

export interface AbuseControlConsumption {
  entry: AbuseControlEntry;
  blocked: boolean;
  /** Sliding-window usage at `now`: the expiring window's count decays as the current one advances. */
  weightedAttemptCount: number;
}

export interface AbuseControlBatchConsumption {
  entries: AbuseControlConsumption[];
  rejected: AbuseControlConsumption | null;
}

/** Persistence contract owned by security; infrastructure implements it structurally. */
export interface AbuseControlRepositoryPort {
  find(scope: string, subjectKey: string): Promise<AbuseControlEntry | null>;
  save(input: {
    scope: string;
    subjectKey: string;
    attemptCount: number;
    windowStartedAt: Date;
    blockedUntil: Date | null;
  }): Promise<AbuseControlEntry>;
  consume(input: AbuseControlConsumptionInput): Promise<AbuseControlConsumption>;
  consumeBatch(inputs: readonly AbuseControlConsumptionInput[]): Promise<AbuseControlBatchConsumption>;
  deleteExpired(now: Date): Promise<void>;
}

/**
 * What a caller may still spend against one policy and when the budget refills. Travels back from
 * an admitted attempt and, as the `details` of the 429, out of a rejected one, so the HTTP layer
 * can state the same thing in headers either way.
 */
export interface AbuseControlDecision {
  limit: number;
  remaining: number;
  resetAtMs: number;
  retryAfterSeconds?: number;
}

/** Narrow port for callers that only spend budget against a policy. */
export interface AbuseControlPort {
  enforce(policy: AbuseControlPolicy): Promise<AbuseControlDecision>;
}

/** Narrow port for callers that must consume related budgets atomically. */
export interface AbuseControlBatchPort {
  enforceBatch(policies: readonly AbuseControlPolicy[]): Promise<AbuseControlDecision[]>;
}
