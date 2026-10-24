import { describe, expect, it } from "vitest";

import { AUDIT_EVENT_RETENTION_DAYS, auditEventRetentionCutoff } from "../../src/db/repositories/auditEventRepository.js";

const HOUR_MS = 60 * 60 * 1_000;
const DAY_MS = 24 * HOUR_MS;

describe("audit event retention window", () => {
  it("keeps audit events for 365 days", () => {
    expect(AUDIT_EVENT_RETENTION_DAYS).toBe(365);
  });

  it("puts the cutoff exactly the window before the given time", () => {
    const now = new Date("2026-10-19T12:00:00.000Z");

    expect(auditEventRetentionCutoff(now).getTime()).toBe(now.getTime() - AUDIT_EVENT_RETENTION_DAYS * DAY_MS);
  });

  it("moves the cutoff forward as the clock advances, by the same amount", () => {
    const first = auditEventRetentionCutoff(new Date("2026-10-19T12:00:00.000Z"));
    const later = auditEventRetentionCutoff(new Date("2026-10-20T12:00:00.000Z"));

    expect(later.getTime() - first.getTime()).toBe(DAY_MS);
  });

  it("keeps an event just inside the window and would delete one just outside it", () => {
    const now = new Date("2026-10-19T12:00:00.000Z");
    const cutoff = auditEventRetentionCutoff(now);
    const keptAt = new Date(now.getTime() - (364 * DAY_MS + 23 * HOUR_MS));
    const deletedAt = new Date(now.getTime() - (365 * DAY_MS + 1 * HOUR_MS));

    // `enforce` compares with `<`, so an event at exactly the cutoff is kept, not deleted.
    expect(keptAt.getTime()).toBeGreaterThanOrEqual(cutoff.getTime());
    expect(deletedAt.getTime()).toBeLessThan(cutoff.getTime());
  });
});
