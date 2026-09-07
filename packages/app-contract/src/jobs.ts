import { z } from "zod";

export const APP_JOB_ENVELOPE_VERSION = 1;

/**
 * The only thing a queue carries. Work state lives in `app_jobs`, so a wake-up
 * that arrives twice, late, or out of order still resolves to current truth and
 * no payload is ever readable from the broker.
 */
export const appJobWakeUpEnvelopeSchema = z
  .object({
    envelopeVersion: z.literal(APP_JOB_ENVELOPE_VERSION),
    appJobId: z.string().uuid(),
  })
  .strict();

export type AppJobWakeUpEnvelope = z.infer<typeof appJobWakeUpEnvelopeSchema>;
