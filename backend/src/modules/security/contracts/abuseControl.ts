export interface AbuseControlPolicy {
  scope: string;
  subjectKey: string;
  limit: number;
  windowMs: number;
  blockMs?: number;
  now?: Date;
}

/** Narrow port for callers that only spend budget against a policy and ignore the resulting entry. */
export interface AbuseControlPort {
  enforce(policy: AbuseControlPolicy): Promise<unknown>;
}
