import { describe, expect, it } from "vitest";

import {
  capToSupportedMode,
  effectiveEngagementMode,
  type EngagementMode,
} from "../../../src/modules/emailChannel/mailboxes/effectiveMode.js";

const MODES: readonly EngagementMode[] = ["operator_only", "draft", "auto"];

describe("effectiveEngagementMode", () => {
  it.each([
    ["operator_only", "operator_only", "operator_only"],
    ["operator_only", "draft", "operator_only"],
    ["operator_only", "auto", "operator_only"],
    ["draft", "operator_only", "operator_only"],
    ["draft", "draft", "draft"],
    ["draft", "auto", "draft"],
    ["auto", "operator_only", "operator_only"],
    ["auto", "draft", "draft"],
    ["auto", "auto", "auto"],
  ] as const)("accepted %s and current %s act as %s", (accepted, current, expected) => {
    expect(effectiveEngagementMode(
      { mode: accepted, enabled: true },
      { mode: current, enabled: true },
    )).toEqual({ mode: expected, enabled: true });
  });

  it("is symmetric: neither policy can raise the other's autonomy", () => {
    for (const a of MODES) {
      for (const b of MODES) {
        expect(effectiveEngagementMode({ mode: a, enabled: true }, { mode: b, enabled: true }))
          .toEqual(effectiveEngagementMode({ mode: b, enabled: true }, { mode: a, enabled: true }));
      }
    }
  });

  it("is enabled only when both the accepted and the current policy are enabled", () => {
    const cases = [
      [true, true, true],
      [true, false, false],
      [false, true, false],
      [false, false, false],
    ] as const;
    for (const [acceptedEnabled, currentEnabled, expected] of cases) {
      expect(effectiveEngagementMode(
        { mode: "auto", enabled: acceptedEnabled },
        { mode: "auto", enabled: currentEnabled },
      ).enabled).toBe(expected);
    }
  });

  it("keeps the lower mode when the mailbox is disabled", () => {
    expect(effectiveEngagementMode(
      { mode: "draft", enabled: true },
      { mode: "auto", enabled: false },
    )).toEqual({ mode: "draft", enabled: false });
  });
});

describe("capToSupportedMode", () => {
  it.each([
    [["operator_only"], "auto", "operator_only"],
    [["operator_only"], "draft", "operator_only"],
    [["operator_only", "draft"], "auto", "draft"],
    [["operator_only", "draft"], "draft", "draft"],
    [["operator_only", "draft", "auto"], "auto", "auto"],
    [["operator_only", "auto"], "draft", "operator_only"],
    [["operator_only", "draft", "auto"], "operator_only", "operator_only"],
    [[], "auto", "operator_only"],
  ] as const)("supported %j caps %s at %s", (supported, mode, expected) => {
    expect(capToSupportedMode(mode, supported)).toBe(expected);
  });

  it("never raises autonomy", () => {
    for (const mode of MODES) {
      expect(effectiveEngagementMode({ mode, enabled: true }, { mode: capToSupportedMode(mode, MODES), enabled: true }).mode).toBe(mode);
    }
  });
});
