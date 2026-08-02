import {
  MAX_CONTENT_PLAN_CLAIM_BATCH,
  MAX_CONTENT_PLAN_SOURCE_HYDRATION,
} from "../contracts/persistence.js";

export const CONTENT_PLAN_WORKER_POLICY_V1 = Object.freeze({
  version: 1 as const,
  assignmentVersion: 1,
  embeddingBatchSize: MAX_CONTENT_PLAN_SOURCE_HYDRATION,
  estimatedEmbeddingBatchSpendMicros: 5_000,
  leaseMs: 60_000,
  maxAttempts: 5,
  nearestTopicLimit: 8,
  representativeObservationLimit: 8,
  retentionBatchSize: MAX_CONTENT_PLAN_CLAIM_BATCH,
  retentionDays: 60,
  failedGenerationRetentionDays: 60,
  supersededGenerationRetentionDays: 90,
  retryBaseDelayMs: 5_000,
  retryMaxDelayMs: 5 * 60_000,
});

export interface ContentPlanWorkerOptions {
  assignmentVersion: number;
  embeddingBatchSize: number;
  estimatedEmbeddingBatchSpendMicros: number;
  leaseMs: number;
  maxAttempts: number;
  nearestTopicLimit: number;
  representativeObservationLimit: number;
  retentionBatchSize: number;
  retentionDays: number;
  failedGenerationRetentionDays: number;
  supersededGenerationRetentionDays: number;
  retryBaseDelayMs: number;
  retryMaxDelayMs: number;
}

export type ContentPlanWorkerOptionsInput = Partial<ContentPlanWorkerOptions>;

export const resolveContentPlanWorkerOptions = (
  input: ContentPlanWorkerOptionsInput = {},
): ContentPlanWorkerOptions => {
  const options: ContentPlanWorkerOptions = {
    assignmentVersion: input.assignmentVersion ?? CONTENT_PLAN_WORKER_POLICY_V1.assignmentVersion,
    embeddingBatchSize: input.embeddingBatchSize ?? CONTENT_PLAN_WORKER_POLICY_V1.embeddingBatchSize,
    estimatedEmbeddingBatchSpendMicros:
      input.estimatedEmbeddingBatchSpendMicros
      ?? CONTENT_PLAN_WORKER_POLICY_V1.estimatedEmbeddingBatchSpendMicros,
    leaseMs: input.leaseMs ?? CONTENT_PLAN_WORKER_POLICY_V1.leaseMs,
    maxAttempts: input.maxAttempts ?? CONTENT_PLAN_WORKER_POLICY_V1.maxAttempts,
    nearestTopicLimit: input.nearestTopicLimit ?? CONTENT_PLAN_WORKER_POLICY_V1.nearestTopicLimit,
    representativeObservationLimit:
      input.representativeObservationLimit
      ?? CONTENT_PLAN_WORKER_POLICY_V1.representativeObservationLimit,
    retentionBatchSize: input.retentionBatchSize ?? CONTENT_PLAN_WORKER_POLICY_V1.retentionBatchSize,
    retentionDays: input.retentionDays ?? CONTENT_PLAN_WORKER_POLICY_V1.retentionDays,
    failedGenerationRetentionDays:
      input.failedGenerationRetentionDays
      ?? CONTENT_PLAN_WORKER_POLICY_V1.failedGenerationRetentionDays,
    supersededGenerationRetentionDays:
      input.supersededGenerationRetentionDays
      ?? CONTENT_PLAN_WORKER_POLICY_V1.supersededGenerationRetentionDays,
    retryBaseDelayMs: input.retryBaseDelayMs ?? CONTENT_PLAN_WORKER_POLICY_V1.retryBaseDelayMs,
    retryMaxDelayMs: input.retryMaxDelayMs ?? CONTENT_PLAN_WORKER_POLICY_V1.retryMaxDelayMs,
  };

  assertIntegerInRange("assignmentVersion", options.assignmentVersion, 1, Number.MAX_SAFE_INTEGER);
  assertIntegerInRange(
    "embeddingBatchSize",
    options.embeddingBatchSize,
    1,
    MAX_CONTENT_PLAN_SOURCE_HYDRATION,
  );
  assertIntegerInRange(
    "estimatedEmbeddingBatchSpendMicros",
    options.estimatedEmbeddingBatchSpendMicros,
    0,
    Number.MAX_SAFE_INTEGER,
  );
  assertIntegerInRange("leaseMs", options.leaseMs, 1, 60 * 60_000);
  assertIntegerInRange("maxAttempts", options.maxAttempts, 1, 100);
  assertIntegerInRange("nearestTopicLimit", options.nearestTopicLimit, 1, 100);
  assertIntegerInRange("representativeObservationLimit", options.representativeObservationLimit, 1, 8);
  assertIntegerInRange("retentionBatchSize", options.retentionBatchSize, 1, MAX_CONTENT_PLAN_CLAIM_BATCH);
  assertIntegerInRange("retentionDays", options.retentionDays, 1, 365);
  assertIntegerInRange(
    "failedGenerationRetentionDays",
    options.failedGenerationRetentionDays,
    options.retentionDays,
    365,
  );
  assertIntegerInRange(
    "supersededGenerationRetentionDays",
    options.supersededGenerationRetentionDays,
    90,
    365,
  );
  assertIntegerInRange("retryBaseDelayMs", options.retryBaseDelayMs, 1, 24 * 60 * 60_000);
  assertIntegerInRange(
    "retryMaxDelayMs",
    options.retryMaxDelayMs,
    options.retryBaseDelayMs,
    7 * 24 * 60 * 60_000,
  );
  return options;
};

const assertIntegerInRange = (
  name: string,
  value: number,
  minimum: number,
  maximum: number,
): void => {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw new Error(`Content planning worker ${name} must be between ${minimum} and ${maximum}`);
  }
};

export const contentPlanRetryAvailableAt = (input: {
  attemptCount: number;
  now: Date;
  options: Pick<ContentPlanWorkerOptions, "retryBaseDelayMs" | "retryMaxDelayMs">;
}): Date => {
  const exponent = Math.max(0, Math.min(30, input.attemptCount - 1));
  const delayMs = Math.min(
    input.options.retryMaxDelayMs,
    input.options.retryBaseDelayMs * (2 ** exponent),
  );
  return new Date(input.now.getTime() + delayMs);
};

export const isContentPlanClaimActive = (input: {
  claimToken: string | null;
  claimExpiresAt: Date | null;
}, now: Date): boolean =>
  typeof input.claimToken === "string"
  && input.claimToken.length > 0
  && input.claimExpiresAt !== null
  && input.claimExpiresAt.getTime() > now.getTime();

export const isValidContentPlanVector = (
  vector: readonly number[] | null,
  dimensions: number | null,
): vector is readonly number[] =>
  vector !== null
  && dimensions !== null
  && Number.isInteger(dimensions)
  && dimensions > 0
  && vector.length === dimensions
  && vector.every(Number.isFinite)
  && vector.some((value) => value !== 0);
