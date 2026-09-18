import { describe, expect, it } from "vitest";

import { getEnv } from "../../src/app/config/env.js";

const base = {
  DATABASE_URL: "postgres://postgres:postgres@localhost:5432/radioso_test",
  SESSION_COOKIE_SECRET: "session-secret-long-enough",
};

describe("visitor request context configuration (spec 1277)", () => {
  it("leaves the edge-proof secret and geo header overrides unset by default", () => {
    const env = getEnv(base);
    expect(env.RADIOSO_EDGE_PROOF_SECRET).toBeUndefined();
    expect(env.VISITOR_GEO_COUNTRY_HEADER).toBeUndefined();
    expect(env.VISITOR_GEO_REGION_HEADER).toBeUndefined();
    expect(env.VISITOR_GEO_CITY_HEADER).toBeUndefined();
  });

  it("rejects an edge-proof secret shorter than 32 characters", () => {
    expect(() => getEnv({ ...base, RADIOSO_EDGE_PROOF_SECRET: "too-short" })).toThrow();
  });

  it("accepts a sufficiently long edge-proof secret", () => {
    const env = getEnv({ ...base, RADIOSO_EDGE_PROOF_SECRET: "a".repeat(32) });
    expect(env.RADIOSO_EDGE_PROOF_SECRET).toBe("a".repeat(32));
  });

  it("lower-cases geo header name overrides on read", () => {
    const env = getEnv({
      ...base,
      VISITOR_GEO_COUNTRY_HEADER: "X-Geo-Country",
      VISITOR_GEO_REGION_HEADER: "X-Geo-Region",
      VISITOR_GEO_CITY_HEADER: "X-Geo-City",
    });
    expect(env.VISITOR_GEO_COUNTRY_HEADER).toBe("x-geo-country");
    expect(env.VISITOR_GEO_REGION_HEADER).toBe("x-geo-region");
    expect(env.VISITOR_GEO_CITY_HEADER).toBe("x-geo-city");
  });
});
