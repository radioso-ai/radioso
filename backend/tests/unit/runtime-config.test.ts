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

  it("uses the watch-oriented backend dev image and bind mounts in docker compose development", async () => {
    const devCompose = YAML.parse(await readFile(new URL("../../../infra/docker-compose.dev.yml", import.meta.url), "utf8")) as {
      services?: Record<string, {
        build?: { dockerfile?: string };
        command?: string[] | string;
        volumes?: string[];
      }>;
    };

    const backend = devCompose.services?.backend;
    const worker = devCompose.services?.["backend-worker"];

    expect(backend?.build?.dockerfile).toBe("infra/backend.dev.Dockerfile");
    expect(worker?.build?.dockerfile).toBe("infra/backend.dev.Dockerfile");
    expect(backend?.command).toEqual(["backend-dev-entrypoint.sh", "dev:http"]);
    expect(worker?.command).toEqual(["backend-dev-entrypoint.sh", "dev:worker"]);
    expect(backend?.volumes).toEqual(expect.arrayContaining([
      "../backend:/app/backend",
      "../packages:/app/packages",
      "radioso_backend_node_modules:/app/backend/node_modules",
    ]));
    expect(worker?.volumes).toEqual(expect.arrayContaining([
      "../backend:/app/backend",
      "../packages:/app/packages",
      "radioso_backend_node_modules:/app/backend/node_modules",
    ]));
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
    expect(env.OBSERVABILITY_ENVIRONMENT).toBe("test");
    expect(env.METRICS_ENABLED).toBe(false);
    expect(env.METRICS_PATH).toBe("/metrics");
    expect(env.METRICS_AUTH_TOKEN).toBeUndefined();
    expect(env.OTEL_ENABLED).toBe(false);
    expect(env.PRODUCT_ANALYTICS_SINKS).toBe("audit");
    expect(env.INCIDENT_SINKS).toBe("audit");
  });

  it("requires a metrics auth token when metrics exposure is enabled", () => {
    expect(() => getEnv({
      NODE_ENV: "test",
      DATABASE_URL: "postgres://test:test@localhost:5432/test",
      OPENAI_API_KEY: "test-key",
      OPENAI_CHAT_MODEL: "gpt-5.2",
      OPENAI_VECTOR_MODEL: "text-embedding-3-small",
      LLM_PROVIDER: "openai",
      SESSION_COOKIE_SECRET: "0123456789abcdef0123456789abcdef",
      METRICS_ENABLED: "true",
    })).toThrow(/METRICS_AUTH_TOKEN/);
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

  it("pins environment-aware observability identity and cloud runtime URLs for the Cloud Run API and worker services", async () => {
    const computeTf = await readFile(new URL("../../../infra/terraform/compute.tf", import.meta.url), "utf8");
    const githubActionsTf = await readFile(new URL("../../../infra/terraform/github_actions.tf", import.meta.url), "utf8");
    const terraformMain = await readFile(new URL("../../../infra/terraform/main.tf", import.meta.url), "utf8");
    const stagingEnv = await readFile(new URL("../../../infra/terraform/environments/staging/main.tf", import.meta.url), "utf8");
    const liveEnv = await readFile(new URL("../../../infra/terraform/environments/live/main.tf", import.meta.url), "utf8");

    expect(computeTf).toContain('name  = "OBSERVABILITY_ENVIRONMENT"');
    expect(computeTf).toContain('value = var.environment');
    expect(computeTf).toContain('name  = "OBSERVABILITY_SERVICE_NAME"');
    expect(computeTf).toContain('value = "radioso-api"');
    expect(computeTf).toContain('value = "radioso-worker"');
    expect(computeTf).toContain('name  = "APP_BASE_URL"');
    expect(computeTf).toContain('name  = "PUBLIC_CHAT_BASE_URL"');
    expect(computeTf).toContain('name  = "WORKER_TASKS_SERVICE_URL"');
    expect(computeTf).toContain('name  = "MAIL_DRIVER"');
    expect(computeTf).toContain('name  = "AUTH_SKIP_EMAIL_VERIFICATION"');
    expect(computeTf).toContain('ignore_changes = [');
    expect(computeTf).toContain('client_version,');
    expect(computeTf).toContain('template[0].containers[0].image,');
    expect(githubActionsTf).toContain('roles/run.admin');
    expect(githubActionsTf).toContain('roles/artifactregistry.writer');
    expect(githubActionsTf).toContain('https://token.actions.githubusercontent.com');
    expect(terraformMain).toContain('worker_tasks_service_url = coalesce(var.worker_tasks_service_url_override, "https://example.invalid")');
    expect(terraformMain).toContain('resource_name_prefix         = "${local.service_name}-${var.environment}"');
    expect(githubActionsTf).toContain("assertion.ref == 'refs/heads/main'");
    expect(stagingEnv).toContain("mail_driver                           = var.mail_driver");
    expect(liveEnv).toContain("mail_driver                           = var.mail_driver");
    expect(stagingEnv).toMatch(/environment\s+= "staging"/);
    expect(liveEnv).toMatch(/environment\s+= "live"/);
  });

  it("defaults worker entrypoints to the worker observability service name", async () => {
    const workerEntry = await readFile(new URL("../../src/documentWorker.ts", import.meta.url), "utf8");
    const workerServerEntry = await readFile(new URL("../../src/documentWorkerServer.ts", import.meta.url), "utf8");

    expect(workerEntry).toContain('OBSERVABILITY_SERVICE_NAME: "radioso-worker"');
    expect(workerServerEntry).toContain('OBSERVABILITY_SERVICE_NAME: "radioso-worker"');
  });
});
