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

/** Narrow port for callers that only spend budget against a policy and ignore the resulting entry. */
export interface AbuseControlPort {
  enforce(policy: AbuseControlPolicy): Promise<unknown>;
}

/** Narrow port for callers that must consume related budgets atomically. */
export interface AbuseControlBatchPort {
  enforceBatch(policies: readonly AbuseControlPolicy[]): Promise<unknown>;
}
