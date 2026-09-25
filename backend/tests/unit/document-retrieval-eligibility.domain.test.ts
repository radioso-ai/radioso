import { describe, expect, it } from "vitest";

import { resolveRetrievalEligibility } from "../../src/modules/documents/public.js";

// This is the single reader for "re-enabling retrieval clears an already-elapsed expiry" — the
// ingestion service's write path and the operator copilot's document preview both call it, so a
// proposal card cannot promise an eligibility window Apply would not actually produce.
describe("resolveRetrievalEligibility", () => {
  const now = new Date("2026-06-01T00:00:00.000Z");
  const past = new Date("2020-01-01T00:00:00.000Z");
  const future = new Date("2030-01-01T00:00:00.000Z");

  it("keeps existing eligibility when nothing is requested", () => {
    expect(
      resolveRetrievalEligibility({ retrievalEnabled: true, retrievalExpiresAt: future }, {}, now),
    ).toEqual({ retrievalEnabled: true, retrievalExpiresAt: future });
  });

  it("clears an already-elapsed expiry when retrieval is switched on", () => {
    expect(
      resolveRetrievalEligibility(
        { retrievalEnabled: false, retrievalExpiresAt: past },
        { retrievalEnabled: true },
        now,
      ),
    ).toEqual({ retrievalEnabled: true, retrievalExpiresAt: null });
  });

  it("keeps a future expiry when retrieval is switched on", () => {
    expect(
      resolveRetrievalEligibility(
        { retrievalEnabled: false, retrievalExpiresAt: future },
        { retrievalEnabled: true },
        now,
      ),
    ).toEqual({ retrievalEnabled: true, retrievalExpiresAt: future });
  });

  it("does not clear an elapsed expiry when retrieval is left alone", () => {
    expect(
      resolveRetrievalEligibility(
        { retrievalEnabled: true, retrievalExpiresAt: past },
        {},
        now,
      ),
    ).toEqual({ retrievalEnabled: true, retrievalExpiresAt: past });
  });

  it("does not clear an elapsed expiry when retrieval is switched off", () => {
    expect(
      resolveRetrievalEligibility(
        { retrievalEnabled: true, retrievalExpiresAt: past },
        { retrievalEnabled: false },
        now,
      ),
    ).toEqual({ retrievalEnabled: false, retrievalExpiresAt: past });
  });

  it("honors an explicit expiry requested alongside re-enabling", () => {
    expect(
      resolveRetrievalEligibility(
        { retrievalEnabled: false, retrievalExpiresAt: null },
        { retrievalEnabled: true, retrievalExpiresAt: past },
        now,
      ),
    ).toEqual({ retrievalEnabled: true, retrievalExpiresAt: null });
  });

  it("clears an expiry requested to land exactly at now", () => {
    expect(
      resolveRetrievalEligibility(
        { retrievalEnabled: false, retrievalExpiresAt: null },
        { retrievalEnabled: true, retrievalExpiresAt: now },
        now,
      ),
    ).toEqual({ retrievalEnabled: true, retrievalExpiresAt: null });
  });

  it("treats an explicit null expiry request as clearing it, independent of enablement", () => {
    expect(
      resolveRetrievalEligibility(
        { retrievalEnabled: true, retrievalExpiresAt: future },
        { retrievalExpiresAt: null },
        now,
      ),
    ).toEqual({ retrievalEnabled: true, retrievalExpiresAt: null });
  });

  it("defaults now to the current time when omitted", () => {
    const result = resolveRetrievalEligibility(
      { retrievalEnabled: false, retrievalExpiresAt: past },
      { retrievalEnabled: true },
    );
    expect(result).toEqual({ retrievalEnabled: true, retrievalExpiresAt: null });
  });
});
