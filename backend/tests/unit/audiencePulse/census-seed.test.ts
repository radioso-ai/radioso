import { describe, expect, it } from "vitest";

import { deriveCensusSeed } from "../../../src/modules/audiencePulse/domain/censusSeed.js";

describe("deriveCensusSeed (T020)", () => {
  const base = {
    workspaceId: "11111111-1111-1111-1111-111111111111",
    windowStart: new Date("2026-07-01T00:00:00.000Z"),
    windowEnd: new Date("2026-07-31T00:00:00.000Z"),
    facetIds: ["b", "a", "c"],
  };

  it("is stable across repeated calls with the same input", () => {
    expect(deriveCensusSeed(base)).toBe(deriveCensusSeed(base));
  });

  it("does not depend on the order facet ids are supplied in", () => {
    expect(deriveCensusSeed(base)).toBe(deriveCensusSeed({ ...base, facetIds: ["c", "a", "b"] }));
  });

  it("changes when the facet id set changes", () => {
    expect(deriveCensusSeed(base))
      .not.toBe(deriveCensusSeed({ ...base, facetIds: ["a", "b", "c", "d"] }));
  });

  it("changes when a facet id is removed", () => {
    expect(deriveCensusSeed(base))
      .not.toBe(deriveCensusSeed({ ...base, facetIds: ["a", "b"] }));
  });

  it("changes when the workspace differs", () => {
    expect(deriveCensusSeed(base))
      .not.toBe(deriveCensusSeed({ ...base, workspaceId: "22222222-2222-2222-2222-222222222222" }));
  });

  it("changes when the window start differs", () => {
    expect(deriveCensusSeed(base))
      .not.toBe(deriveCensusSeed({ ...base, windowStart: new Date("2026-06-01T00:00:00.000Z") }));
  });

  it("changes when the window end differs", () => {
    expect(deriveCensusSeed(base))
      .not.toBe(deriveCensusSeed({ ...base, windowEnd: new Date("2026-08-01T00:00:00.000Z") }));
  });

  it("returns a non-empty string suitable as a @radioso/census seed", () => {
    const seed = deriveCensusSeed({ ...base, facetIds: [] });
    expect(typeof seed).toBe("string");
    expect(seed.length).toBeGreaterThan(0);
  });
});
