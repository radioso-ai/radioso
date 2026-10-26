import { describe, expect, it } from "vitest";

import { getEnv } from "../../src/app/config/env.js";

const envWith = (PUBLIC_API_BASE_URL: string): NodeJS.ProcessEnv => ({
  NODE_ENV: "test",
  DATABASE_URL: "postgres://radioso:radioso@localhost:5432/radioso_test",
  SESSION_COOKIE_SECRET: "session-cookie-secret-value-long-enough",
  WORKSPACE_TOKEN_SECRET: "workspace-token-secret-value-long-enough",
  OPENAI_API_KEY: "sk-test",
  PUBLIC_API_BASE_URL,
});

describe("PUBLIC_API_BASE_URL", () => {
  it.each([
    ["https://api.example.com", "https://api.example.com"],
    ["https://api.example.com/", "https://api.example.com"],
    // The same value RADIOSO_PUBLIC_API_URL takes: the API's own path is dropped, so routes are not doubled.
    ["https://api.example.com/api/v1", "https://api.example.com"],
    ["https://api.example.com/api/v1/", "https://api.example.com"],
    // A deployment that serves the API under a prefix, such as the frontend's own proxy path, keeps it.
    ["https://app.example.com/backend", "https://app.example.com/backend"],
    ["https://app.example.com/backend/api/v1", "https://app.example.com/backend"],
  ])("reads %s as the base %s that API routes are appended to", (value, base) => {
    expect(getEnv(envWith(value)).PUBLIC_API_BASE_URL).toBe(base);
  });

  it("reads a blank value as unset", () => {
    expect(getEnv(envWith("")).PUBLIC_API_BASE_URL).toBeUndefined();
  });

  it.each(["https://api.example.com/?region=eu", "https://api.example.com/#api", "not a url"])("refuses %s", (value) => {
    expect(() => getEnv(envWith(value))).toThrow(/PUBLIC_API_BASE_URL/);
  });
});
