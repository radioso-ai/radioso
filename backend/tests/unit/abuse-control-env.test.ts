import { describe, expect, it } from "vitest";

import { getEnv } from "../../src/app/config/env.js";

const baseEnv = {
  NODE_ENV: "test",
  PORT: "8080",
  DATABASE_URL: "postgres://test:test@localhost:5432/test",
  SESSION_COOKIE_SECRET: "0123456789abcdef0123456789abcdef",
};

describe("abuse-control Redis environment", () => {
  it("keeps Redis disabled by default and applies the command timeout default", () => {
    const env = getEnv(baseEnv);

    expect(env.ABUSE_CONTROL_REDIS_URL).toBeUndefined();
    expect(env.ABUSE_CONTROL_REDIS_COMMAND_TIMEOUT_MS).toBe(1_000);
  });

  it("accepts redis and rediss URLs", () => {
    expect(getEnv({ ...baseEnv, ABUSE_CONTROL_REDIS_URL: "redis://localhost:6379" }).ABUSE_CONTROL_REDIS_URL)
      .toBe("redis://localhost:6379");
    expect(getEnv({ ...baseEnv, ABUSE_CONTROL_REDIS_URL: "rediss://cache.example.com:6380" }).ABUSE_CONTROL_REDIS_URL)
      .toBe("rediss://cache.example.com:6380");
  });

  it("rejects a non-Redis URL", () => {
    expect(() => getEnv({ ...baseEnv, ABUSE_CONTROL_REDIS_URL: "https://cache.example.com" }))
      .toThrow(/ABUSE_CONTROL_REDIS_URL/u);
  });
});
