import { readFile } from "node:fs/promises";

import { describe, expect, it } from "vitest";
import YAML from "yaml";
import { getEnv } from "../../src/app/config/env.js";

describe("runtime configuration", () => {
  it("defines explicit API and worker backend scripts", async () => {
    const packageJson = JSON.parse(await readFile(new URL("../../package.json", import.meta.url), "utf8")) as {
      scripts: Record<string, string>;
    };

    expect(packageJson.scripts["dev:http"]).toBeTruthy();
    expect(packageJson.scripts["dev:worker"]).toBeTruthy();
    expect(packageJson.scripts["dev:worker-server"]).toBeTruthy();
    expect(packageJson.scripts["start:http"]).toBeTruthy();
    expect(packageJson.scripts["start:worker"]).toBeTruthy();
    expect(packageJson.scripts["start:worker-server"]).toBeTruthy();
  });

  it("defines a dedicated backend-worker service in local and compose orchestration", async () => {
    const devCompose = YAML.parse(await readFile(new URL("../../../infra/docker-compose.dev.yml", import.meta.url), "utf8")) as {
      services?: Record<string, unknown>;
    };
    const prodCompose = YAML.parse(await readFile(new URL("../../../infra/docker-compose.yml", import.meta.url), "utf8")) as {
      services?: Record<string, unknown>;
    };

    expect(devCompose.services?.["backend-worker"]).toBeTruthy();
    expect(prodCompose.services?.["backend-worker"]).toBeTruthy();
    expect((devCompose.services?.["backend-worker"] as { depends_on?: Record<string, { condition?: string }> })?.depends_on?.backend?.condition).toBe("service_healthy");
    expect((prodCompose.services?.["backend-worker"] as { depends_on?: Record<string, { condition?: string }> })?.depends_on?.backend?.condition).toBe("service_healthy");
  });

  it("provides default observability configuration without extra vendor settings", () => {
    const env = getEnv({
      NODE_ENV: "test",
      DATABASE_URL: "postgres://test:test@localhost:5432/test",
      OPENAI_API_KEY: "test-key",
      OPENAI_CHAT_MODEL: "gpt-5.2",
      OPENAI_VECTOR_MODEL: "text-embedding-3-small",
      LLM_PROVIDER: "openai",
      SESSION_COOKIE_SECRET: "0123456789abcdef0123456789abcdef",
    });

    expect(env.OBSERVABILITY_ENABLED).toBe(true);
    expect(env.OBSERVABILITY_SERVICE_NAME).toBe("radioso-api");
    expect(env.METRICS_ENABLED).toBe(false);
    expect(env.METRICS_PATH).toBe("/metrics");
    expect(env.OTEL_ENABLED).toBe(false);
    expect(env.PRODUCT_ANALYTICS_SINKS).toBe("audit");
    expect(env.INCIDENT_SINKS).toBe("audit");
  });

  it("requires PostHog credentials when the adapter is enabled", () => {
    expect(() => getEnv({
      NODE_ENV: "test",
      DATABASE_URL: "postgres://test:test@localhost:5432/test",
      OPENAI_API_KEY: "test-key",
      OPENAI_CHAT_MODEL: "gpt-5.2",
      OPENAI_VECTOR_MODEL: "text-embedding-3-small",
      LLM_PROVIDER: "openai",
      SESSION_COOKIE_SECRET: "0123456789abcdef0123456789abcdef",
      PRODUCT_ANALYTICS_SINKS: "audit,posthog",
    })).toThrow(/POSTHOG_/);
  });

  it("requires a Sentry DSN when the adapter is enabled", () => {
    expect(() => getEnv({
      NODE_ENV: "test",
      DATABASE_URL: "postgres://test:test@localhost:5432/test",
      OPENAI_API_KEY: "test-key",
      OPENAI_CHAT_MODEL: "gpt-5.2",
      OPENAI_VECTOR_MODEL: "text-embedding-3-small",
      LLM_PROVIDER: "openai",
      SESSION_COOKIE_SECRET: "0123456789abcdef0123456789abcdef",
      INCIDENT_SINKS: "audit,sentry",
    })).toThrow(/SENTRY_DSN/);
  });

  it("accepts explicitly configured optional exporters", () => {
    const env = getEnv({
      NODE_ENV: "test",
      DATABASE_URL: "postgres://test:test@localhost:5432/test",
      OPENAI_API_KEY: "test-key",
      OPENAI_CHAT_MODEL: "gpt-5.2",
      OPENAI_VECTOR_MODEL: "text-embedding-3-small",
      LLM_PROVIDER: "openai",
      SESSION_COOKIE_SECRET: "0123456789abcdef0123456789abcdef",
      PRODUCT_ANALYTICS_SINKS: "audit,posthog",
      POSTHOG_HOST: "https://app.posthog.com",
      POSTHOG_API_KEY: "posthog-test-key",
      INCIDENT_SINKS: "audit,sentry",
      SENTRY_DSN: "https://public@example.ingest.sentry.io/123456",
    });

    expect(env.PRODUCT_ANALYTICS_SINKS).toBe("audit,posthog");
    expect(env.POSTHOG_HOST).toBe("https://app.posthog.com");
    expect(env.INCIDENT_SINKS).toBe("audit,sentry");
    expect(env.SENTRY_DSN).toBe("https://public@example.ingest.sentry.io/123456");
  });
});
