import { describe, expect, it } from "vitest";

import { getEnv } from "../../src/app/config/env.js";

const baseEnv = (overrides: Record<string, string> = {}): NodeJS.ProcessEnv => ({
  NODE_ENV: "test",
  DATABASE_URL: "postgres://radioso:radioso@localhost:5432/radioso_test",
  SESSION_COOKIE_SECRET: "session-cookie-secret-value-long-enough",
  WORKSPACE_TOKEN_SECRET: "workspace-token-secret-value-long-enough",
  OPENAI_API_KEY: "sk-test",
  ...overrides,
});

describe("ops event webhook env validation", () => {
  it("accepts the default configuration where no ops webhook is requested", () => {
    expect(() => getEnv(baseEnv())).not.toThrow();
  });

  it("rejects an ops_webhook sink with no destination", () => {
    expect(() => getEnv(baseEnv({
      PRODUCT_ANALYTICS_SINKS: "audit,ops_webhook",
      OPS_EVENT_WEBHOOK_SECRET: "ops-webhook-secret-long-enough",
    }))).toThrow(/OPS_EVENT_WEBHOOK_URL/);
  });

  it("rejects an ops_webhook sink with no signing secret", () => {
    expect(() => getEnv(baseEnv({
      ERROR_SINKS: "audit,ops_webhook",
      OPS_EVENT_WEBHOOK_URL: "https://ops.example/hook",
    }))).toThrow(/OPS_EVENT_WEBHOOK_SECRET/);
  });

  it("accepts a fully configured ops webhook", () => {
    expect(() => getEnv(baseEnv({
      PRODUCT_ANALYTICS_SINKS: "audit,ops_webhook",
      ERROR_SINKS: "audit,ops_webhook",
      OPS_EVENT_WEBHOOK_URL: "https://ops.example/hook",
      OPS_EVENT_WEBHOOK_SECRET: "ops-webhook-secret-long-enough",
      OPS_EVENT_WEBHOOK_EVENTS: "account.registered,chat.completed",
    }))).not.toThrow();
  });

  it("rejects an event allowlist naming an event the taxonomy does not define", () => {
    expect(() => getEnv(baseEnv({
      PRODUCT_ANALYTICS_SINKS: "audit,ops_webhook",
      OPS_EVENT_WEBHOOK_URL: "https://ops.example/hook",
      OPS_EVENT_WEBHOOK_SECRET: "ops-webhook-secret-long-enough",
      OPS_EVENT_WEBHOOK_EVENTS: "account.registered,chat.exploded",
    }))).toThrow(/chat\.exploded/);
  });

  it("rejects a non-HTTP ops webhook URL", () => {
    expect(() => getEnv(baseEnv({
      PRODUCT_ANALYTICS_SINKS: "audit,ops_webhook",
      OPS_EVENT_WEBHOOK_URL: "mailto:ops@example.com",
      OPS_EVENT_WEBHOOK_SECRET: "ops-webhook-secret-long-enough",
    }))).toThrow(/HTTP\(S\) URL/);
  });
});
