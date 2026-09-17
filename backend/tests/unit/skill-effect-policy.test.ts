import { describe, expect, it } from "vitest";

import { resolveSkillEffectPolicy } from "../../src/shared/domain/turnExecutionMode.js";

describe("resolveSkillEffectPolicy", () => {
  it("is always allowed for a live turn, ignoring any requested policy", () => {
    expect(resolveSkillEffectPolicy("live")).toBe("allowed");
    expect(resolveSkillEffectPolicy("live", "suppressed")).toBe("allowed");
    expect(resolveSkillEffectPolicy("live", "allowed")).toBe("allowed");
  });

  it("treats an undefined execution mode the same as live", () => {
    expect(resolveSkillEffectPolicy(undefined)).toBe("allowed");
    expect(resolveSkillEffectPolicy(undefined, "suppressed")).toBe("allowed");
  });

  it("defaults a safe-test turn to suppressed when nothing is explicitly requested", () => {
    expect(resolveSkillEffectPolicy("safe_test")).toBe("suppressed");
    expect(resolveSkillEffectPolicy("safe_test", undefined)).toBe("suppressed");
  });

  it("honors an explicit allowed request in safe-test mode", () => {
    expect(resolveSkillEffectPolicy("safe_test", "allowed")).toBe("allowed");
  });

  it("honors an explicit suppressed request in safe-test mode", () => {
    expect(resolveSkillEffectPolicy("safe_test", "suppressed")).toBe("suppressed");
  });
});
