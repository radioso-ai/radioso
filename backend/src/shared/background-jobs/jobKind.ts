import type { z } from "zod";

import type {
  BackgroundJobContext,
  BackgroundJobDeadLetterContext,
  BackgroundJobDuplicateKeyMode,
  BackgroundJobHandlerRegistration,
  BackgroundJobKind,
  BackgroundJobPolicy,
  BackgroundJobRequest,
} from "./types.js";

/**
 * The longest deadline a kind may declare. A worker drain claims a job only while that job's
 * deadline still fits in what is left of the drain's budget.
 */
export const BACKGROUND_JOB_MAX_TIMEOUT_SECONDS = 240;

/**
 * How long one worker drain request may spend admitting jobs. Strictly longer than the longest
 * deadline, so a kind at that deadline still fits after the request spent a few seconds arriving;
 * the worker's 300 s request timeout leaves 30 s above it for the claim, completion, and
 * dead-letter writes.
 */
export const BACKGROUND_JOB_DRAIN_BUDGET_SECONDS = 270;

const DEFAULT_POLICY: BackgroundJobPolicy = {
  maxAttempts: 5,
  leaseSeconds: 180,
  timeoutSeconds: 120,
  retryBaseDelaySeconds: 30,
};

const DUPLICATE_KEY_MODES: readonly BackgroundJobDuplicateKeyMode[] = ["ignore", "rerun"];

/** Kind names are stored and used as a metric label, so they stay short dotted identifiers. */
const KIND_PATTERN = /^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)*$/;

/**
 * Thrown by a handler for a failure no retry can fix (the subject is gone, the input can never
 * succeed). The runtime dead-letters the job on the spot instead of spending its retry budget.
 */
export class NonRetryableBackgroundJobError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "NonRetryableBackgroundJobError";
  }
}

/** A stored payload that no longer matches its kind's schema. Retrying cannot repair it. */
class InvalidBackgroundJobPayloadError extends NonRetryableBackgroundJobError {
  constructor(kind: string) {
    super(`Stored payload does not match the ${kind} schema`);
    this.name = "InvalidBackgroundJobPayloadError";
  }
}

export const defineBackgroundJob = <TPayload>(definition: {
  kind: string;
  payload: z.ZodType<TPayload>;
  onDuplicateKey: BackgroundJobDuplicateKeyMode;
} & Partial<BackgroundJobPolicy>): BackgroundJobKind<TPayload> => {
  if (!KIND_PATTERN.test(definition.kind) || definition.kind.length > 128) {
    throw new Error(`Invalid background job kind "${definition.kind}"`);
  }
  if (!DUPLICATE_KEY_MODES.includes(definition.onDuplicateKey)) {
    throw new Error(`Background job kind "${definition.kind}" needs onDuplicateKey "ignore" or "rerun"`);
  }
  const policy: BackgroundJobPolicy = {
    maxAttempts: definition.maxAttempts ?? DEFAULT_POLICY.maxAttempts,
    leaseSeconds: definition.leaseSeconds ?? DEFAULT_POLICY.leaseSeconds,
    timeoutSeconds: definition.timeoutSeconds ?? DEFAULT_POLICY.timeoutSeconds,
    retryBaseDelaySeconds: definition.retryBaseDelaySeconds ?? DEFAULT_POLICY.retryBaseDelaySeconds,
  };
  if (!Number.isInteger(policy.maxAttempts) || policy.maxAttempts < 1) {
    throw new Error(`Background job kind "${definition.kind}" needs at least one attempt`);
  }
  if (!(policy.timeoutSeconds > 0) || !(policy.retryBaseDelaySeconds > 0)) {
    throw new Error(`Background job kind "${definition.kind}" needs a positive deadline and retry delay`);
  }
  if (!(policy.timeoutSeconds < policy.leaseSeconds)) {
    throw new Error(`Background job kind "${definition.kind}" needs a deadline shorter than its lease`);
  }
  if (policy.timeoutSeconds > BACKGROUND_JOB_MAX_TIMEOUT_SECONDS) {
    throw new Error(
      `Background job kind "${definition.kind}" has a deadline longer than one worker drain holds ` +
        `(${BACKGROUND_JOB_MAX_TIMEOUT_SECONDS} s)`,
    );
  }
  return { kind: definition.kind, payload: definition.payload, onDuplicateKey: definition.onDuplicateKey, policy };
};

/**
 * Builds the request an enqueue writes. The payload is checked against the kind's schema here, so
 * a malformed job fails in the producer that built it rather than in a worker later.
 */
export const backgroundJobRequest = <TPayload>(
  job: BackgroundJobKind<TPayload>,
  payload: TPayload,
  options: { idempotencyKey?: string; runAfter?: Date } = {},
): BackgroundJobRequest => ({
  kind: job.kind,
  payload: job.payload.parse(payload),
  onDuplicateKey: job.onDuplicateKey,
  ...(options.idempotencyKey === undefined ? {} : { idempotencyKey: options.idempotencyKey }),
  ...(options.runAfter === undefined ? {} : { runAfter: options.runAfter }),
});

/**
 * Registers the function that runs one kind. The runtime parses each stored payload before calling
 * it. `onDeadLetter` runs once when a job of the kind is dead-lettered, for any reason: its last
 * attempt failed or passed its deadline, it failed for good, its stored payload no longer parses
 * (the hook then gets `null`), or its attempts ran out on crashed workers. Keep it to a quick write
 * through `context.transaction`.
 */
export const backgroundJobHandler = <TPayload>(
  job: BackgroundJobKind<TPayload>,
  handle: (payload: TPayload, context: BackgroundJobContext) => Promise<void>,
  options: {
    onDeadLetter?: (payload: TPayload | null, context: BackgroundJobDeadLetterContext) => Promise<void>;
  } = {},
): BackgroundJobHandlerRegistration => {
  const onDeadLetter = options.onDeadLetter;
  return {
    kind: job.kind,
    policy: job.policy,
    async run(payload, context) {
      const parsed = job.payload.safeParse(payload);
      if (!parsed.success) {
        throw new InvalidBackgroundJobPayloadError(job.kind);
      }
      await handle(parsed.data, context);
    },
    ...(onDeadLetter
      ? {
          onDeadLetter: async (payload: unknown, context: BackgroundJobDeadLetterContext) => {
            const parsed = job.payload.safeParse(payload);
            await onDeadLetter(parsed.success ? parsed.data : null, context);
          },
        }
      : {}),
  };
};
