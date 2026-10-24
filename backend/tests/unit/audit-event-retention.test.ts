import { describe, expect, it } from "vitest";

import { AUDIT_EVENT_RETENTION_DAYS, auditEventRetentionCutoff } from "../../src/db/repositories/auditEventRepository.js";

const DAY_MS = 24 * 60 * 60 * 1_000;

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
});
