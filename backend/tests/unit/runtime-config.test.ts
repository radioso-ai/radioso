import { readFile } from "node:fs/promises";

import { describe, expect, it } from "vitest";
import YAML from "yaml";
import { getEnv } from "../../src/app/config/env.js";

const baseEnv = {
  NODE_ENV: "test",
  DATABASE_URL: "postgres://test:test@localhost:5432/test",
  OPENAI_API_KEY: "test-key",
  OPENAI_CHAT_MODEL: "gpt-5.2",
  OPENAI_VECTOR_MODEL: "text-embedding-3-small",
  LLM_PROVIDER: "openai",
  SESSION_COOKIE_SECRET: "0123456789abcdef0123456789abcdef",
} as const;

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
    const devCompose = YAML.parse(await readFile(new URL("../../../docker-compose.dev.yml", import.meta.url), "utf8")) as {
      services?: Record<string, unknown>;
    };
    const prodCompose = YAML.parse(await readFile(new URL("../../../docker-compose.yml", import.meta.url), "utf8")) as {
      services?: Record<string, unknown>;
    };

    expect(devCompose.services?.["backend-worker"]).toBeTruthy();
    expect(prodCompose.services?.["backend-worker"]).toBeTruthy();
    expect((devCompose.services?.["backend-worker"] as { depends_on?: Record<string, { condition?: string }> })?.depends_on?.backend?.condition).toBe("service_healthy");
    expect((prodCompose.services?.["backend-worker"] as { depends_on?: Record<string, { condition?: string }> })?.depends_on?.backend?.condition).toBe("service_healthy");
  });

  it("uses the watch-oriented backend dev image and bind mounts in docker compose development", async () => {
    const devCompose = YAML.parse(await readFile(new URL("../../../docker-compose.dev.yml", import.meta.url), "utf8")) as {
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
      "./backend:/app/backend",
      "./packages:/app/packages",
      "radioso_backend_node_modules:/app/backend/node_modules",
    ]));
    expect(worker?.volumes).toEqual(expect.arrayContaining([
      "./backend:/app/backend",
      "./packages:/app/packages",
      "radioso_backend_node_modules:/app/backend/node_modules",
    ]));
  });

  it("provides default observability configuration without extra vendor settings", () => {
    const env = getEnv({
      ...baseEnv,
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
      ...baseEnv,
      METRICS_ENABLED: "true",
    })).toThrow(/METRICS_AUTH_TOKEN/);
  });

  it("requires PostHog credentials when the adapter is enabled", () => {
    expect(() => getEnv({
      ...baseEnv,
      PRODUCT_ANALYTICS_SINKS: "audit,posthog",
    })).toThrow(/POSTHOG_/);
  });

  it("requires a Sentry DSN when the adapter is enabled", () => {
    expect(() => getEnv({
      ...baseEnv,
      INCIDENT_SINKS: "audit,sentry",
    })).toThrow(/SENTRY_DSN/);
  });

  it("accepts explicitly configured optional exporters", () => {
    const env = getEnv({
      ...baseEnv,
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

  it("keeps no-op worker dispatch as the default without AMQP settings", () => {
    const env = getEnv({
      ...baseEnv,
    });

    expect(env.WORKER_DISPATCH_DRIVER).toBe("noop");
    expect(env.WORKER_AMQP_URL).toBeUndefined();
    expect(env.WORKER_AMQP_QUEUE_NAME).toBeUndefined();
    expect(env.WORKER_AMQP_PREFETCH).toBe(1);
  });

  it("requires AMQP broker settings when AMQP worker dispatch is enabled", () => {
    expect(() => getEnv({
      ...baseEnv,
      WORKER_DISPATCH_DRIVER: "amqp",
    })).toThrow(/WORKER_AMQP_URL/);

    expect(() => getEnv({
      ...baseEnv,
      WORKER_DISPATCH_DRIVER: "amqp",
      WORKER_AMQP_URL: "amqp://localhost:5672",
    })).toThrow(/WORKER_AMQP_QUEUE_NAME/);
  });

  it("accepts AMQP worker dispatch settings", () => {
    const env = getEnv({
      ...baseEnv,
      WORKER_DISPATCH_DRIVER: "amqp",
      WORKER_AMQP_URL: "amqp://localhost:5672",
      WORKER_AMQP_QUEUE_NAME: "radioso-document-jobs",
      WORKER_AMQP_PREFETCH: "3",
    });

    expect(env.WORKER_DISPATCH_DRIVER).toBe("amqp");
    expect(env.WORKER_AMQP_URL).toBe("amqp://localhost:5672");
    expect(env.WORKER_AMQP_QUEUE_NAME).toBe("radioso-document-jobs");
    expect(env.WORKER_AMQP_PREFETCH).toBe(3);
  });

  it("documents AMQP worker dispatch settings in the example environment", async () => {
    const example = await readFile(new URL("../../../.env.example", import.meta.url), "utf8");

    expect(example).toContain("WORKER_DISPATCH_DRIVER=noop");
    expect(example).toContain("WORKER_AMQP_URL=");
    expect(example).toContain("WORKER_AMQP_QUEUE_NAME=");
    expect(example).toContain("WORKER_AMQP_PREFETCH=1");
    expect(example).not.toContain("MAIL_DRIVER=");
    expect(example).not.toContain("RESEND_MAIL_API_KEY=");
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
    expect(computeTf).toContain('name  = "PUBLIC_CHAT_BASE_URL"');
    expect(computeTf).toContain('name  = "WORKER_TASKS_SERVICE_URL"');
    expect(computeTf).not.toContain('name  = "MAIL_DRIVER"');
    expect(computeTf).not.toContain('name = "RESEND_MAIL_API_KEY"');
    expect(computeTf).not.toContain('name  = "AUTH_SKIP_EMAIL_VERIFICATION"');
    expect(computeTf).toContain('ignore_changes = [');
    expect(computeTf).toContain('client_version,');
    expect(computeTf).toContain('template[0].containers[0].image,');
    expect(githubActionsTf).toContain('roles/run.admin');
    expect(githubActionsTf).toContain('roles/artifactregistry.writer');
    expect(githubActionsTf).toContain('https://token.actions.githubusercontent.com');
    expect(terraformMain).toContain('worker_tasks_service_url = coalesce(var.worker_tasks_service_url_override, "https://example.invalid")');
    expect(terraformMain).toContain('resource_name_prefix         = "${local.service_name}-${var.environment}"');
    expect(githubActionsTf).toContain("assertion.ref == 'refs/heads/main'");
    expect(stagingEnv).not.toContain("mail_driver");
    expect(stagingEnv).not.toContain("resend_mail_api_key");
    expect(liveEnv).not.toContain("mail_driver");
    expect(liveEnv).not.toContain("resend_mail_api_key");
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
