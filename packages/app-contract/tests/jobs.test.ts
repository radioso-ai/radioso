import { describe, expect, it } from "vitest";

import { APP_JOB_ENVELOPE_VERSION, appJobWakeUpEnvelopeSchema } from "../src/index.js";

const appJobId = "9c8d7e6f-1111-4222-8333-444455556666";

describe("App Job wake-up envelope", () => {
  it("carries the envelope version and the job id and nothing else", () => {
    expect(APP_JOB_ENVELOPE_VERSION).toBe(1);
    expect(appJobWakeUpEnvelopeSchema.parse({ envelopeVersion: 1, appJobId })).toEqual({
      envelopeVersion: 1,
      appJobId,
    });
  });

  it("rejects any extra key", () => {
    const parsed = appJobWakeUpEnvelopeSchema.safeParse({
      envelopeVersion: 1,
      appJobId,
      installationId: "1d2e3f40-1111-4222-8333-444455556666",
    });
    expect(parsed.success).toBe(false);
  });

  it("rejects an envelope version other than 1", () => {
    expect(appJobWakeUpEnvelopeSchema.safeParse({ envelopeVersion: 2, appJobId }).success).toBe(false);
  });

  it("rejects a job id that is not an identifier", () => {
    expect(appJobWakeUpEnvelopeSchema.safeParse({ envelopeVersion: 1, appJobId: "not-a-uuid" }).success).toBe(false);
  });
});
