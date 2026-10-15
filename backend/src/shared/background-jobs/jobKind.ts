import type { z } from "zod";

import type {
  BackgroundJobContext,
  BackgroundJobHandlerRegistration,
  BackgroundJobKind,
  BackgroundJobPolicy,
  BackgroundJobRequest,
} from "./types.js";

const DEFAULT_POLICY: BackgroundJobPolicy = {
  maxAttempts: 5,
  leaseSeconds: 300,
  retryBaseDelaySeconds: 30,
};

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
} & Partial<BackgroundJobPolicy>): BackgroundJobKind<TPayload> => {
  if (!KIND_PATTERN.test(definition.kind) || definition.kind.length > 128) {
    throw new Error(`Invalid background job kind "${definition.kind}"`);
  }
  const policy: BackgroundJobPolicy = {
    maxAttempts: definition.maxAttempts ?? DEFAULT_POLICY.maxAttempts,
    leaseSeconds: definition.leaseSeconds ?? DEFAULT_POLICY.leaseSeconds,
    retryBaseDelaySeconds: definition.retryBaseDelaySeconds ?? DEFAULT_POLICY.retryBaseDelaySeconds,
  };
  if (!Number.isInteger(policy.maxAttempts) || policy.maxAttempts < 1) {
    throw new Error(`Background job kind "${definition.kind}" needs at least one attempt`);
  }
  if (!(policy.leaseSeconds > 0) || !(policy.retryBaseDelaySeconds > 0)) {
    throw new Error(`Background job kind "${definition.kind}" needs a positive lease and retry delay`);
  }
  return { kind: definition.kind, payload: definition.payload, policy };
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
  ...(options.idempotencyKey === undefined ? {} : { idempotencyKey: options.idempotencyKey }),
  ...(options.runAfter === undefined ? {} : { runAfter: options.runAfter }),
});

/** Registers the function that runs one kind. The runtime parses each stored payload before calling it. */
export const backgroundJobHandler = <TPayload>(
  job: BackgroundJobKind<TPayload>,
  handle: (payload: TPayload, context: BackgroundJobContext) => Promise<void>,
): BackgroundJobHandlerRegistration => ({
  kind: job.kind,
  policy: job.policy,
  async run(payload, context) {
    const parsed = job.payload.safeParse(payload);
    if (!parsed.success) {
      throw new InvalidBackgroundJobPayloadError(job.kind);
    }
    await handle(parsed.data, context);
  },
});
