import { describe, expect, it } from "vitest";

import { ALERT_LEVELS, alertLevelRank, levelsCrossedUpward } from "./alertLevelOrder.js";

describe("alertLevelRank", () => {
  it("orders ok below every alertable level", () => {
    expect(alertLevelRank("ok")).toBe(0);
    expect(alertLevelRank("nearing_limit")).toBeLessThan(alertLevelRank("limit_reached"));
    expect(alertLevelRank("limit_reached")).toBeLessThan(alertLevelRank("grace_exhausted"));
  });
});

describe("levelsCrossedUpward", () => {
  it("is empty when the level does not change", () => {
    expect(levelsCrossedUpward("ok", "ok")).toEqual([]);
    expect(levelsCrossedUpward("grace_exhausted", "grace_exhausted")).toEqual([]);
  });

  it("is empty when the level moves downward (e.g. a release)", () => {
    expect(levelsCrossedUpward("limit_reached", "nearing_limit")).toEqual([]);
    expect(levelsCrossedUpward("grace_exhausted", "ok")).toEqual([]);
  });

  it("names the one level crossed by a single step", () => {
    expect(levelsCrossedUpward("ok", "nearing_limit")).toEqual(["nearing_limit"]);
    expect(levelsCrossedUpward("nearing_limit", "limit_reached")).toEqual(["limit_reached"]);
    expect(levelsCrossedUpward("limit_reached", "grace_exhausted")).toEqual(["grace_exhausted"]);
  });

  it("names every level crossed by a jump straight from ok to grace_exhausted", () => {
    expect(levelsCrossedUpward("ok", "grace_exhausted")).toEqual([...ALERT_LEVELS]);
  });
});
