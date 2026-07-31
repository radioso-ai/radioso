import { describe, expect, it } from "vitest";

import {
  QUALITY_DISMISSED_REASONS,
  QUALITY_RESOLVED_REASONS,
  validateQualityTriageUpdate,
} from "../../src/modules/quality/domain/resolution.js";

describe("validateQualityTriageUpdate", () => {
  it.each(QUALITY_RESOLVED_REASONS)(
    "accepts resolved reason %s",
    (reason) => {
      expect(validateQualityTriageUpdate({
        state: "resolved",
        expectedVersion: 2,
        resolution: { reason, note: reason === "other" ? "A distinct cause" : undefined },
      })).toEqual({
        state: "resolved",
        expectedVersion: 2,
        resolution: {
          reason,
          note: reason === "other" ? "A distinct cause" : null,
        },
        legacyReason: null,
      });
    },
  );

  it.each(QUALITY_DISMISSED_REASONS)(
    "accepts dismissed reason %s",
    (reason) => {
      expect(validateQualityTriageUpdate({
        state: "dismissed",
        expectedVersion: 0,
        resolution: { reason, note: reason === "other" ? "Not represented above" : undefined },
      }).resolution?.reason).toBe(reason);
    },
  );

  it("trims notes and rejects other without a non-blank note", () => {
    expect(validateQualityTriageUpdate({
      state: "resolved",
      expectedVersion: 0,
      resolution: { reason: "knowledge_gap", note: "  Updated source  " },
    }).resolution?.note).toBe("Updated source");

    expect(() => validateQualityTriageUpdate({
      state: "resolved",
      expectedVersion: 0,
      resolution: { reason: "other", note: "   " },
    })).toThrow(/note/i);
  });

  it("rejects the wrong terminal-state vocabulary and overlong notes", () => {
    expect(() => validateQualityTriageUpdate({
      state: "resolved",
      expectedVersion: 0,
      resolution: { reason: "expected_behavior" },
    })).toThrow(/resolved/i);

    expect(() => validateQualityTriageUpdate({
      state: "dismissed",
      expectedVersion: 0,
      resolution: { reason: "knowledge_gap" },
    })).toThrow(/dismissed/i);

    expect(() => validateQualityTriageUpdate({
      state: "resolved",
      expectedVersion: 0,
      resolution: { reason: "knowledge_gap", note: "x".repeat(501) },
    })).toThrow(/500/);
  });

  it("rejects structured resolution for active states", () => {
    expect(() => validateQualityTriageUpdate({
      state: "open",
      expectedVersion: 1,
      resolution: { reason: "knowledge_gap" },
    })).toThrow(/active/i);
  });

  it.each(["resolved", "dismissed"] as const)(
    "accepts %s without a structured resolution",
    (state) => {
      expect(validateQualityTriageUpdate({
        state,
        expectedVersion: 0,
      })).toEqual({
        state,
        expectedVersion: 0,
        resolution: null,
        legacyReason: null,
      });
    },
  );

  it("still accepts other with a trimmed note", () => {
    expect(validateQualityTriageUpdate({
      state: "resolved",
      expectedVersion: 0,
      resolution: { reason: "other", note: "  A distinct cause  " },
    }).resolution).toEqual({
      reason: "other",
      note: "A distinct cause",
    });
  });

  it("preserves the deprecated legacy reason without classifying it", () => {
    expect(validateQualityTriageUpdate({
      state: "resolved",
      expectedVersion: 0,
      legacyReason: "  Fixed customer wording  ",
    })).toEqual({
      state: "resolved",
      expectedVersion: 0,
      resolution: null,
      legacyReason: "Fixed customer wording",
    });
  });

  it("requires a non-negative integer expected version", () => {
    for (const expectedVersion of [-1, 1.5, Number.NaN]) {
      expect(() => validateQualityTriageUpdate({
        state: "acknowledged",
        expectedVersion,
      })).toThrow(/version/i);
    }
  });
});
