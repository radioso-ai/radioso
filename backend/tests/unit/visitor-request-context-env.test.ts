import { describe, expect, it } from "vitest";

import { getEnv } from "../../src/app/config/env.js";

const base = {
  DATABASE_URL: "postgres://postgres:postgres@localhost:5432/radioso_test",
  SESSION_COOKIE_SECRET: "session-secret-long-enough",
};

describe("visitor request context configuration (spec 1277)", () => {
  it("leaves the edge-proof secret unset by default", () => {
    const env = getEnv(base);
    expect(env.RADIOSO_EDGE_PROOF_SECRET).toBeUndefined();
  });

  it("rejects an edge-proof secret shorter than 32 characters", () => {
    expect(() => getEnv({ ...base, RADIOSO_EDGE_PROOF_SECRET: "too-short" })).toThrow();
  });

  it("accepts a sufficiently long edge-proof secret", () => {
    const env = getEnv({ ...base, RADIOSO_EDGE_PROOF_SECRET: "a".repeat(32) });
    expect(env.RADIOSO_EDGE_PROOF_SECRET).toBe("a".repeat(32));
  });
});
