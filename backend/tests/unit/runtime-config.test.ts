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
    expect(packageJson.scripts["dev:crawler-worker"]).toBeTruthy();
    expect(packageJson.scripts["dev:crawler-worker-server"]).toBeTruthy();
    expect(packageJson.scripts["start:http"]).toBeTruthy();
    expect(packageJson.scripts["start:worker"]).toBeTruthy();
    expect(packageJson.scripts["start:worker-server"]).toBeTruthy();
    expect(packageJson.scripts["start:crawler-worker"]).toBeTruthy();
    expect(packageJson.scripts["start:crawler-worker-server"]).toBeTruthy();
  });

  it("keeps crawler dependency installation out of normal backend build and dev scripts", async () => {
    const packageJson = JSON.parse(await readFile(new URL("../../package.json", import.meta.url), "utf8")) as {
      scripts: Record<string, string>;
    };

    const normalScripts = Object.entries(packageJson.scripts).filter(([name]) =>
      name === "build" || name === "build:crawler" || name.startsWith("predev:"),
    );

    expect(packageJson.scripts["install:crawler"]).toContain("pnpm --dir ../packages/crawler install --frozen-lockfile");
    for (const [name, script] of normalScripts) {
      expect(script, `${name} should not install crawler dependencies`).not.toContain("pnpm --dir ../packages/crawler install --frozen-lockfile");
    }
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

    // Crawler runs in its own process so a long crawl cannot starve embedding
    // work; both compose files must declare the dedicated service.
    expect(devCompose.services?.["backend-crawler-worker"]).toBeTruthy();
    expect(prodCompose.services?.["backend-crawler-worker"]).toBeTruthy();
    expect((devCompose.services?.["backend-crawler-worker"] as { command?: string[] | string })?.command).toEqual([
      "backend-dev-entrypoint.sh",
      "dev:crawler-worker",
    ]);
    expect((prodCompose.services?.["backend-crawler-worker"] as { command?: string[] | string })?.command).toEqual([
      "node",
      "./dist/src/crawlerWorker.js",
    ]);

    expect((prodCompose.services?.postgres as { ports?: string[] })?.ports).toEqual([
      "127.0.0.1:${RADIOSO_POSTGRES_PORT:-5432}:5432",
    ]);
  });

  it("uses isolated dependency volumes with source-only development binds", async () => {
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
    expect((backend as { environment?: Record<string, string> })?.environment?.AUTH_AUTO_VERIFY_EMAIL).toBe("true");
    expect(worker?.command).toEqual(["backend-dev-entrypoint.sh", "dev:worker"]);
    const expectedDevelopmentVolumes = [
      "./backend/src:/app/backend/src",
      "./backend/prompts:/app/backend/prompts",
      "./packages/conversation-engine/src:/app/packages/conversation-engine/src",
      "radioso_backend_node_modules:/app/backend/node_modules",
    ];
    for (const service of [backend, worker]) {
      expect(service?.volumes).toEqual(expect.arrayContaining(expectedDevelopmentVolumes));
      expect(service?.volumes).not.toContain("./backend:/app/backend");
      expect(service?.volumes).not.toContain("./packages:/app/packages");
    }
  });

  it("enables development-only email auto-verification in the Enterprise dev runtime", async () => {
    const runtime = await readFile(new URL("../../../scripts/run-ee-dev.mjs", import.meta.url), "utf8");

    expect(runtime).toMatch(/const enterpriseBackendEnv = \{[\s\S]*NODE_ENV: "development",[\s\S]*AUTH_AUTO_VERIFY_EMAIL: "true"/);
  });

  it("keeps backend dev dependency installation aligned with backend workspace imports", async () => {
    const dockerfile = await readFile(new URL("../../../infra/backend.dev.Dockerfile", import.meta.url), "utf8");
    const entrypoint = await readFile(new URL("../../../infra/backend.dev.entrypoint.sh", import.meta.url), "utf8");

    for (const manifest of [
      "packages/conversation-contract/package.json",
      "packages/conversation-engine/package.json",
      "packages/conversation-defaults/package.json",
      "packages/conversation-tools/package.json",
      "packages/connector-api/package.json",
      "packages/crawler/package.json",
      "packages/document-parser/package.json",
      "packages/mcp-source-proof/package.json",
      "packages/radioso-mcp-server/package.json",
      "packages/skill-contract/package.json",
      "packages/usage-contract/package.json",
    ]) {
      expect(dockerfile).toContain(`COPY ${manifest}`);
    }

    expect(entrypoint).toContain("backend_modules_ready");
    expect(entrypoint).toContain("module_is_ready_from");
    expect(entrypoint).toContain("zod/package.json");
    expect(dockerfile).toContain("COPY packages/conversation-defaults ./packages/conversation-defaults");
    expect(dockerfile).toContain("COPY packages/mcp-source-proof ./packages/mcp-source-proof");
    expect(dockerfile).toContain("@radioso/conversation-defaults...");
    expect(entrypoint).toContain("backend/node_modules/@radioso/conversation-engine");
    expect(entrypoint).toContain("backend/node_modules/@radioso/conversation-defaults");
    expect(entrypoint).toContain("backend/node_modules/@radioso/conversation-tools");
    expect(entrypoint).toContain("packages/conversation-defaults/node_modules/@radioso/conversation-contract/package.json");
    expect(entrypoint).toContain("@radioso/conversation-defaults...");
    expect(entrypoint).toContain("@radioso/conversation-tools...");
  });

  it("keeps backend deploy image packaging aligned with backend workspace imports", async () => {
    const dockerfile = await readFile(new URL("../../../infra/backend.Dockerfile", import.meta.url), "utf8");
    const workflow = await readFile(new URL("../../../.github/workflows/deploy-staging.yml", import.meta.url), "utf8");
    const sharedDeployWorkflow = await readFile(
      new URL("../../../.github/workflows/_deploy-cloud-run.yml", import.meta.url),
      "utf8",
    );

    for (const expected of [
      "COPY packages/conversation-tools/package.json ./packages/conversation-tools/package.json",
      "COPY packages/conversation-tools ./packages/conversation-tools",
      "COPY --chown=node:node --from=build /app/packages/conversation-tools/dist ./packages/conversation-tools/dist",
      "COPY packages/mcp-source-proof/package.json ./packages/mcp-source-proof/package.json",
      "COPY packages/mcp-source-proof ./packages/mcp-source-proof",
      "COPY --chown=node:node --from=build /app/packages/mcp-source-proof/dist ./packages/mcp-source-proof/dist",
      "@radioso/conversation-tools...",
    ]) {
      expect(dockerfile).toContain(expected);
    }

    expect(workflow).toContain("packages/conversation-tools/**");
    expect(workflow).toContain("packages/mcp-source-proof/**");
    expect(workflow).toContain("packages/radioso-mcp-server/**");
    expect(workflow).toContain("mcp_service: radioso-staging-mcp");
    expect(sharedDeployWorkflow).toContain('--build-arg RADIOSO_EDITION="${RADIOSO_EDITION}"');
    expect(sharedDeployWorkflow).toContain("mcp_service:");
    expect(sharedDeployWorkflow).toContain('default: ""');
    expect(sharedDeployWorkflow).toContain("MCP_SERVICE: ${{ inputs.mcp_service }}");
    expect(sharedDeployWorkflow).toContain("Deploy MCP service if configured");
    expect(sharedDeployWorkflow).toContain('gcloud run services describe "${MCP_SERVICE}"');
    expect(sharedDeployWorkflow).toContain('gcloud run services update "${MCP_SERVICE}" --image "${BACKEND_IMAGE}"');
    expect(sharedDeployWorkflow).toContain('echo "mcp_url=disabled"');
    expect(sharedDeployWorkflow.match(/--update-env-vars "RADIOSO_EDITION=\$\{RADIOSO_EDITION\}"/g)).toHaveLength(4);
    expect(sharedDeployWorkflow).toContain(
      '--update-env-vars "RADIOSO_EDITION=${RADIOSO_EDITION},NEXT_PUBLIC_RADIOSO_EDITION=${RADIOSO_EDITION}"',
    );
  });

  it("clears incomplete frontend Next dev caches with missing manifests or vendor chunks", async () => {
    const entrypoint = await readFile(new URL("../../../infra/frontend.dev.entrypoint.sh", import.meta.url), "utf8");

    expect(entrypoint).toContain("next_cache_has_missing_dev_manifest");
    expect(entrypoint).toContain("frontend/.next/dev/routes-manifest.json");
    expect(entrypoint).toContain("frontend/.next/dev/server/middleware-manifest.json");
    expect(entrypoint).toContain("find frontend/.next/dev/server/app");
    expect(entrypoint).toContain("vendor-chunks/[^\",]+");
    expect(entrypoint).toContain("missing server/$missing_vendor_chunk.js");
    expect(entrypoint).toContain("Restarting frontend Next.js dev server after incomplete cache.");
  });

  it("runs CI buckets for infra changes instead of silently skipping them", async () => {
    const workflow = await readFile(new URL("../../../.github/workflows/ci.yml", import.meta.url), "utf8");
    const localCi = await readFile(new URL("../../../scripts/local-ci-checks.sh", import.meta.url), "utf8");

    for (const script of [workflow, localCi]) {
      expect(script).toMatch(
        /\.github\/workflows\/\*\|infra\/\*\|\.dockerignore\|\*\/\.dockerignore\|Dockerfile\|\*\/Dockerfile\|\*\.Dockerfile\)[\s\S]+mark_all[\s\S]+;;/,
      );
    }
  });

  it("provides default observability configuration without extra vendor settings", () => {
    const env = getEnv({
      ...baseEnv,
    });

    expect(env.TRUST_PROXY_HOPS).toBe(0);
    expect(env.OBSERVABILITY_ENABLED).toBe(true);
    expect(env.OBSERVABILITY_SERVICE_NAME).toBe("radioso-api");
    expect(env.OBSERVABILITY_ENVIRONMENT).toBe("test");
    expect(env.METRICS_ENABLED).toBe(false);
    expect(env.METRICS_PATH).toBe("/metrics");
    expect(env.METRICS_AUTH_TOKEN).toBeUndefined();
    expect(env.OTEL_ENABLED).toBe(false);
    expect(env.OTEL_EXPORTER_OTLP_ENDPOINT).toBeUndefined();
    expect(env.OTEL_TRACES_SAMPLER).toBeUndefined();
    expect(env.OTEL_TRACES_SAMPLER_ARG).toBeUndefined();
    expect(env.OTEL_LOGS_ENABLED).toBe(false);
    expect(env.OTEL_EXPORTER_OTLP_LOGS_ENDPOINT).toBeUndefined();
    expect(env.OTEL_EXPORTER_OTLP_LOGS_AUTH_BEARER).toBeUndefined();
    expect(env.OTEL_LOGS_MIN_LEVEL).toBeUndefined();
    expect(env.PRODUCT_ANALYTICS_SINKS).toBe("audit");
    expect(env.ERROR_SINKS).toBe("audit");
    expect(env.RADIOSO_EDITION).toBe("oss");
  });

  it("keeps email verification enabled by default", () => {
    const env = getEnv({
      ...baseEnv,
    });

    expect(env.AUTH_AUTO_VERIFY_EMAIL).toBe(false);
  });

  it("allows automatic email verification only in development", () => {
    const env = getEnv({
      ...baseEnv,
      NODE_ENV: "development",
      AUTH_AUTO_VERIFY_EMAIL: "true",
    });

    expect(env.AUTH_AUTO_VERIFY_EMAIL).toBe(true);

    for (const nodeEnv of ["test", "production"] as const) {
      expect(() => getEnv({
        ...baseEnv,
        NODE_ENV: nodeEnv,
        AUTH_AUTO_VERIFY_EMAIL: "true",
      })).toThrow(/AUTH_AUTO_VERIFY_EMAIL/);
    }
  });

  it("requires an OTLP endpoint when tracing is enabled", () => {
    expect(() => getEnv({
      ...baseEnv,
      OTEL_ENABLED: "true",
    })).toThrow(/OTEL_EXPORTER_OTLP_ENDPOINT/);
  });

  it("accepts a non-negative integer trust proxy hop count", () => {
    const env = getEnv({
      ...baseEnv,
      TRUST_PROXY_HOPS: "2",
    });

    expect(env.TRUST_PROXY_HOPS).toBe(2);
  });

  it("rejects negative trust proxy hop counts", () => {
    expect(() => getEnv({
      ...baseEnv,
      TRUST_PROXY_HOPS: "-1",
    })).toThrow(/TRUST_PROXY_HOPS/);
  });

  it("accepts standard OpenTelemetry sampler settings when tracing is enabled", () => {
    const env = getEnv({
      ...baseEnv,
      OTEL_ENABLED: "true",
      OTEL_EXPORTER_OTLP_ENDPOINT: "http://localhost:4318/v1/traces",
      OTEL_TRACES_SAMPLER: "parentbased_traceidratio",
      OTEL_TRACES_SAMPLER_ARG: "0.25",
    });

    expect(env.OTEL_ENABLED).toBe(true);
    expect(env.OTEL_EXPORTER_OTLP_ENDPOINT).toBe("http://localhost:4318/v1/traces");
    expect(env.OTEL_TRACES_SAMPLER).toBe("parentbased_traceidratio");
    expect(env.OTEL_TRACES_SAMPLER_ARG).toBe("0.25");
  });

  it("requires an OTLP logs endpoint when OpenTelemetry logs are enabled", () => {
    expect(() => getEnv({
      ...baseEnv,
      OTEL_LOGS_ENABLED: "true",
    })).toThrow(/OTEL_EXPORTER_OTLP_LOGS_ENDPOINT/);
  });

  it("accepts OpenTelemetry logs export settings", () => {
    const env = getEnv({
      ...baseEnv,
      OTEL_LOGS_ENABLED: "true",
      OTEL_EXPORTER_OTLP_LOGS_ENDPOINT: "https://eu.i.posthog.com/i/v1/logs",
      OTEL_EXPORTER_OTLP_LOGS_AUTH_BEARER: "phc_project_token",
      OTEL_LOGS_MIN_LEVEL: "warn",
    });

    expect(env.OTEL_LOGS_ENABLED).toBe(true);
    expect(env.OTEL_EXPORTER_OTLP_LOGS_ENDPOINT).toBe("https://eu.i.posthog.com/i/v1/logs");
    expect(env.OTEL_EXPORTER_OTLP_LOGS_AUTH_BEARER).toBe("phc_project_token");
    expect(env.OTEL_LOGS_MIN_LEVEL).toBe("warn");
  });

  it("rejects invalid sampler arguments when tracing is enabled", () => {
    expect(() => getEnv({
      ...baseEnv,
      OTEL_ENABLED: "true",
      OTEL_EXPORTER_OTLP_ENDPOINT: "http://localhost:4318/v1/traces",
      OTEL_TRACES_SAMPLER: "traceidratio",
      OTEL_TRACES_SAMPLER_ARG: "2",
    })).toThrow(/OTEL_TRACES_SAMPLER_ARG/);
  });

  it("rejects a CONNECTOR_ENCRYPTION_KEY that does not decode to 32 bytes", () => {
    expect(() => getEnv({
      ...baseEnv,
      CONNECTOR_ENCRYPTION_KEY: "definitely-not-base64-32-bytes",
    })).toThrow(/CONNECTOR_ENCRYPTION_KEY/);
  });

  it("accepts a valid 32-byte base64 CONNECTOR_ENCRYPTION_KEY", () => {
    const key = Buffer.alloc(32, 0x42).toString("base64");
    const env = getEnv({
      ...baseEnv,
      CONNECTOR_ENCRYPTION_KEY: key,
    });
    expect(env.CONNECTOR_ENCRYPTION_KEY).toBe(key);
  });

  it("keeps loopback webhook destinations disabled by default", () => {
    const env = getEnv({
      ...baseEnv,
    });

    expect(env.WEBHOOK_DESTINATIONS_ALLOW_HTTP_LOOPBACK).toBe(false);
  });

  it("accepts loopback webhook destinations only outside production", () => {
    const env = getEnv({
      ...baseEnv,
      WEBHOOK_DESTINATIONS_ALLOW_HTTP_LOOPBACK: "true",
    });

    expect(env.WEBHOOK_DESTINATIONS_ALLOW_HTTP_LOOPBACK).toBe(true);

    expect(() => getEnv({
      ...baseEnv,
      NODE_ENV: "production",
      WEBHOOK_DESTINATIONS_ALLOW_HTTP_LOOPBACK: "true",
    })).toThrow(/WEBHOOK_DESTINATIONS_ALLOW_HTTP_LOOPBACK/);
  });

  it("requires a metrics auth token when metrics exposure is enabled", () => {
    expect(() => getEnv({
      ...baseEnv,
      METRICS_ENABLED: "true",
    })).toThrow(/METRICS_AUTH_TOKEN/);
  });

  it("accepts sink names for extension modules without owning vendor credentials", () => {
    const env = getEnv({
      ...baseEnv,
      PRODUCT_ANALYTICS_SINKS: "audit,posthog",
      ERROR_SINKS: "audit,sentry",
      RADIOSO_EDITION: "enterprise",
    });

    expect(env.PRODUCT_ANALYTICS_SINKS).toBe("audit,posthog");
    expect(env.ERROR_SINKS).toBe("audit,sentry");
    expect(env.RADIOSO_EDITION).toBe("enterprise");
  });

  it("keeps no-op worker dispatch as the default without AMQP settings", () => {
    const env = getEnv({
      ...baseEnv,
    });

    expect(env.WORKER_DISPATCH_DRIVER).toBe("noop");
    expect(env.WORKER_AMQP_URL).toBeUndefined();
    expect(env.WORKER_AMQP_QUEUE_NAME).toBeUndefined();
    expect(env.WORKER_AMQP_CRAWL_QUEUE_NAME).toBeUndefined();
    expect(env.WORKER_AMQP_PREFETCH).toBe(1);
    expect(env.WORKER_TASK_AUTH_TOKEN).toBeUndefined();
  });

  it("requires a strong worker task token for Cloud Tasks dispatch", () => {
    const cloudTasksEnv = {
      ...baseEnv,
      WORKER_DISPATCH_DRIVER: "cloud-tasks",
      GOOGLE_CLOUD_PROJECT: "radioso-test",
      WORKER_TASKS_QUEUE_LOCATION: "europe-west1",
      WORKER_TASKS_QUEUE_NAME: "document-processing",
      WORKER_TASKS_SERVICE_URL: "https://worker.example.com",
      WORKER_TASKS_INVOKER_SERVICE_ACCOUNT: "tasks@example.iam.gserviceaccount.com",
    } as const;

    expect(() => getEnv(cloudTasksEnv)).toThrow(/WORKER_TASK_AUTH_TOKEN/);
    expect(() => getEnv({
      ...cloudTasksEnv,
      WORKER_TASK_AUTH_TOKEN: "too-short",
    })).toThrow(/WORKER_TASK_AUTH_TOKEN/);

    const env = getEnv({
      ...cloudTasksEnv,
      WORKER_TASK_AUTH_TOKEN: "0123456789abcdef0123456789abcdef",
    });
    expect(env.WORKER_TASK_AUTH_TOKEN).toBe("0123456789abcdef0123456789abcdef");
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
      WORKER_AMQP_CRAWL_QUEUE_NAME: "radioso-website-crawls",
      WORKER_AMQP_PREFETCH: "3",
    });

    expect(env.WORKER_DISPATCH_DRIVER).toBe("amqp");
    expect(env.WORKER_AMQP_URL).toBe("amqp://localhost:5672");
    expect(env.WORKER_AMQP_QUEUE_NAME).toBe("radioso-document-jobs");
    expect(env.WORKER_AMQP_CRAWL_QUEUE_NAME).toBe("radioso-website-crawls");
    expect(env.WORKER_AMQP_PREFETCH).toBe(3);
  });

  it("accepts AMQP settings without a dedicated crawl queue via fallback to document queue", () => {
    const env = getEnv({
      ...baseEnv,
      WORKER_DISPATCH_DRIVER: "amqp",
      WORKER_AMQP_URL: "amqp://localhost:5672",
      WORKER_AMQP_QUEUE_NAME: "radioso-document-jobs",
      WORKER_AMQP_PREFETCH: "2",
    });

    expect(env.WORKER_AMQP_QUEUE_NAME).toBe("radioso-document-jobs");
    expect(env.WORKER_AMQP_CRAWL_QUEUE_NAME).toBeUndefined();
    expect(env.WORKER_AMQP_PREFETCH).toBe(2);
  });

  it("documents AMQP worker dispatch settings in the example environment", async () => {
    const example = await readFile(new URL("../../../.env.example", import.meta.url), "utf8");

    expect(example).toContain("WORKER_DISPATCH_DRIVER=noop");
    expect(example).toContain("WORKER_AMQP_URL=");
    expect(example).toContain("WORKER_AMQP_QUEUE_NAME=");
    expect(example).toContain("WORKER_AMQP_CRAWL_QUEUE_NAME=");
    expect(example).toContain("WORKER_AMQP_PREFETCH=1");
    expect(example).not.toContain("RADIOSO_MCP_ENABLED");
    expect(example).not.toContain("RADIOSO_MCP_STANDALONE");
    expect(example).not.toContain("RADIOSO_MCP_MOUNT_PATH");
    expect(example).toContain("MAIL_DRIVER=log");
    expect(example).toContain("MAIL_FROM_EMAIL=noreply@example.com");
    expect(example).toContain("MAIL_FROM_NAME=Radioso");
    expect(example).toContain("RESEND_MAIL_API_KEY=");
    expect(example).toContain("PASSWORD_RESET_TOKEN_TTL_MINUTES=30");
    expect(example).toContain("EMAIL_VERIFICATION_TOKEN_TTL_MINUTES=30");
  });

  it("pins environment-aware observability identity and cloud runtime URLs for the Cloud Run API and worker services", async () => {
    const computeTf = await readFile(new URL("../../../infra/terraform/compute.tf", import.meta.url), "utf8");
    const terraformFoundation = await readFile(new URL("../../../infra/terraform/foundation/main.tf", import.meta.url), "utf8");
    const terraformFoundationVariables = await readFile(new URL("../../../infra/terraform/foundation/variables.tf", import.meta.url), "utf8");
    const terraformWorkflow = await readFile(new URL("../../../.github/workflows/terraform.yml", import.meta.url), "utf8");
    const terraformMain = await readFile(new URL("../../../infra/terraform/main.tf", import.meta.url), "utf8");
    const terraformVariables = await readFile(new URL("../../../infra/terraform/variables.tf", import.meta.url), "utf8");
    const terraformApis = await readFile(new URL("../../../infra/terraform/apis.tf", import.meta.url), "utf8");
    const monitoringTf = await readFile(new URL("../../../infra/terraform/monitoring.tf", import.meta.url), "utf8");
    const schedulerTf = await readFile(new URL("../../../infra/terraform/scheduler.tf", import.meta.url), "utf8");
    const databaseTf = await readFile(new URL("../../../infra/terraform/database.tf", import.meta.url), "utf8");
    const secretsTf = await readFile(new URL("../../../infra/terraform/secrets.tf", import.meta.url), "utf8");
    const registryTf = await readFile(new URL("../../../infra/terraform/registry.tf", import.meta.url), "utf8");
    const stagingEnv = await readFile(new URL("../../../infra/terraform/environments/staging/main.tf", import.meta.url), "utf8");
    const stagingEnvVariables = await readFile(new URL("../../../infra/terraform/environments/staging/variables.tf", import.meta.url), "utf8");
    const liveEnv = await readFile(new URL("../../../infra/terraform/environments/live/main.tf", import.meta.url), "utf8");
    const liveEnvVariables = await readFile(new URL("../../../infra/terraform/environments/live/variables.tf", import.meta.url), "utf8");

    expect(computeTf).toContain('name  = "OBSERVABILITY_ENVIRONMENT"');
    expect(computeTf).toContain('value = var.environment');
    expect(computeTf).toContain('name  = "OBSERVABILITY_SERVICE_NAME"');
    expect(computeTf).toContain('value = "radioso-api"');
    expect(computeTf).toContain('value = "radioso-worker"');
    expect(computeTf).toContain('resource "google_cloud_run_v2_service" "mcp"');
    const mcpService = computeTf.slice(
      computeTf.indexOf('resource "google_cloud_run_v2_service" "mcp"'),
      computeTf.indexOf('resource "google_cloud_run_v2_service_iam_member" "mcp_public"'),
    );
    expect(mcpService).toContain("max_instance_count = var.backend_max_instances");
    expect(computeTf).toContain('command = ["node"]');
    expect(computeTf).toContain('args    = ["../packages/radioso-mcp-server/dist/src/cli/http.js"]');
    expect(computeTf).toContain('name  = "RADIOSO_MCP_BIND_PORT"');
    expect(computeTf).toContain('value = "8080"');
    expect(computeTf).toContain('resource "google_cloud_run_v2_service_iam_member" "mcp_public"');
    expect(computeTf).toContain('name  = "RADIOSO_MCP_PUBLIC_URL"');
    expect(computeTf.match(/name = "RADIOSO_MCP_SIGNING_SECRET"/g)).toHaveLength(2);
    expect(computeTf.match(/name {2}= "RADIOSO_TRUSTED_PROXY_HOPS"/g)).toHaveLength(2);
    expect(computeTf.match(/value = "2"/g)?.length).toBeGreaterThanOrEqual(2);
    expect(databaseTf).toContain('resource "random_password" "radioso_mcp_signing_secret"');
    expect(secretsTf).toContain('"radioso-mcp-signing-secret" = random_password.radioso_mcp_signing_secret.result');
    expect(terraformVariables).not.toContain('variable "radioso_mcp_signing_secret"');
    expect(terraformWorkflow).not.toContain('RADIOSO_MCP_SIGNING_SECRET');
    // The retention window is documented as an operator knob, and the sweep that reads it runs in
    // the worker — so a Terraform deployment that never passes it leaves the docs describing a
    // setting the deployment cannot honour.
    // Both copilot knobs are documented as operator-tunable, and each has to reach the process that
    // reads it — the budget in the API service where a Ray turn runs, the window in the worker
    // where the sweep runs. A variable that never reaches its service is a setting in name only.
    expect(computeTf).toContain('name  = "COPILOT_PROBE_BUDGET_PER_TURN"');
    expect(computeTf).toContain("value = tostring(var.copilot_probe_budget_per_turn)");
    expect(terraformVariables).toContain('variable "copilot_probe_budget_per_turn"');
    expect(computeTf).toContain('name  = "COPILOT_CONVERSATION_RETENTION_DAYS"');
    expect(computeTf).toContain("value = tostring(var.copilot_conversation_retention_days)");
    expect(terraformVariables).toContain('variable "copilot_conversation_retention_days"');
    expect((computeTf.match(/var\.ops_event_webhook_url == null \? \[\] : \[var\.ops_event_webhook_min_error_severity\]/g) ?? [])).toHaveLength(0);
    expect((computeTf.match(/var\.ops_event_webhook_url != null \? \[var\.ops_event_webhook_min_error_severity\] : \[\]/g) ?? [])).toHaveLength(3);
    expect((computeTf.match(/var\.ops_event_webhook_url == null \? \[\] : \[var\.ops_event_webhook_queue_limit\]/g) ?? [])).toHaveLength(0);
    expect((computeTf.match(/var\.ops_event_webhook_url != null \? \[var\.ops_event_webhook_queue_limit\] : \[\]/g) ?? [])).toHaveLength(3);

    // A root variable an environment wrapper never declares is a knob the docs describe and the
    // deployment cannot set. Terraform does not substitute a child default for an explicit null —
    // the validation runs against the null and fails — so these carry their default in each
    // wrapper, and the assertion below is what keeps the copies honest.
    const environments = ["staging", "live", "live-eu"];
    const copilotDefaults = { copilot_probe_budget_per_turn: "6", copilot_conversation_retention_days: "90" };
    for (const environment of environments) {
      const wrapperVariables = await readFile(
        new URL(`../../../infra/terraform/environments/${environment}/variables.tf`, import.meta.url),
        "utf8",
      );
      const wrapperMain = await readFile(
        new URL(`../../../infra/terraform/environments/${environment}/main.tf`, import.meta.url),
        "utf8",
      );
      for (const name of [...Object.keys(copilotDefaults), "copilot_retention_schedule"]) {
        expect(wrapperVariables, `${environment} does not declare ${name}`).toContain(`variable "${name}"`);
        expect(wrapperMain, `${environment} does not pass ${name} to the root module`).toMatch(
          new RegExp(`${name}\\s+= var\\.${name}`),
        );
      }
      for (const [name, expected] of Object.entries(copilotDefaults)) {
        const rootDefault = new RegExp(`variable "${name}" \\{[\\s\\S]*?default\\s+= ${expected}`);
        expect(terraformVariables, `root default for ${name} moved away from ${expected}`).toMatch(rootDefault);
        expect(wrapperVariables, `${environment} default for ${name} drifted from the root`).toMatch(rootDefault);
      }
    }
    expect(computeTf).toContain('name  = "PUBLIC_CHAT_BASE_URL"');
    expect(computeTf).toContain('name  = "APP_BASE_URL"');
    expect(computeTf).toContain('name  = "WORKER_TASKS_SERVICE_URL"');
    // Split-worker topology: there must be a dedicated Cloud Run service for
    // the crawler that is invokable by the worker_task_invoker SA, and the
    // backend/document worker must read its URL via direct reference (no
    // operator-supplied override needed).
    expect(computeTf).toContain('resource "google_cloud_run_v2_service" "crawler_worker"');
    expect(computeTf).toContain('command = ["npm", "run", "start:crawler-worker-server"]');
    expect(computeTf).toContain('resource "google_cloud_run_v2_service_iam_member" "crawler_worker_invoker"');
    expect(computeTf).toContain('value = try(google_cloud_run_v2_service.crawler_worker[0].uri, "")');
    expect(computeTf).toContain('name  = "WORKER_TASKS_CRAWL_SERVICE_URL"');
    expect((computeTf.match(/name\s+=\s+"WORKER_TASK_AUTH_TOKEN"/g) ?? [])).toHaveLength(3);
    expect((computeTf.match(/secret {2}= google_secret_manager_secret\.secrets\["worker-task-auth-token"\]\.secret_id/g) ?? [])).toHaveLength(3);
    expect(computeTf).toContain('network_interfaces {');
    expect(computeTf).toContain('secret  = google_secret_manager_secret.secrets["database-url"].secret_id');
    expect(computeTf).not.toContain("cpu_idle = false");
    expect((computeTf.match(/cpu_idle = true/g) ?? [])).toHaveLength(2);
    expect(computeTf).not.toContain('name  = "MAIL_DRIVER"');
    expect(computeTf).toContain('for_each = var.resend_mail_api_key != null ? [google_secret_manager_secret.secrets["resend-mail-api-key"].secret_id] : []');
    expect(computeTf).toContain('name = "RESEND_MAIL_API_KEY"');
    expect((computeTf.match(/name = "RESEND_MAIL_API_KEY"/g) ?? [])).toHaveLength(2);
    expect(computeTf).toContain('name  = "MAIL_FROM_EMAIL"');
    expect((computeTf.match(/name {2}= "MAIL_FROM_EMAIL"/g) ?? [])).toHaveLength(2);
    expect(computeTf).toContain('name  = "MAIL_FROM_NAME"');
    expect((computeTf.match(/name {2}= "MAIL_FROM_NAME"/g) ?? [])).toHaveLength(2);
    expect(computeTf).not.toContain('name  = "AUTH_SKIP_EMAIL_VERIFICATION"');
    expect(computeTf).toContain('ignore_changes = [');
    expect(computeTf).toContain('client_version,');
    expect(computeTf).toContain('template[0].containers[0].image,');
    expect(terraformFoundation).toContain('resource "google_project_iam_member" "runtime_deployer_role"');
    expect(terraformFoundation).toContain('resource "google_project_service" "required_apis"');
    expect(terraformFoundation).toContain('"cloudresourcemanager.googleapis.com"');
    expect(terraformFoundation).toContain('"iam.googleapis.com"');
    expect(terraformFoundation).toContain('"iamcredentials.googleapis.com"');
    expect(terraformFoundation).toContain('"sts.googleapis.com"');
    expect(terraformFoundation).toContain('"serviceusage.googleapis.com"');
    expect(terraformFoundation).toContain("depends_on = [google_project_service.required_apis]");
    expect(terraformFoundation).toContain('resource "google_service_account_iam_member" "runtime_deployer_act_as"');
    expect(terraformFoundation).toContain('resource "google_service_account_iam_member" "runtime_worker_task_act_as"');
    expect(terraformFoundation).toContain('resource "google_iam_workload_identity_pool_provider" "github_actions"');
    expect(terraformFoundation).toContain('https://token.actions.githubusercontent.com');
    expect(terraformFoundation).toContain("projects/${var.project_number}/locations/global/workloadIdentityPools/");
    expect(terraformFoundation).not.toContain('data "google_project" "current"');
    expect(terraformFoundationVariables).toContain('variable "project_number"');
    expect(terraformMain).toContain('worker_tasks_service_url = coalesce(var.worker_tasks_service_url_override, "https://example.invalid")');
    expect(terraformMain).toContain('resource_name_prefix         = "${local.service_name}-${var.environment}"');
    expect(terraformMain).toContain('app_base_url = coalesce(var.app_base_url_override, "https://example.invalid")');
    expect(terraformVariables).toContain('app_base_url_override must be set when radioso_edition is enterprise.');
    expect(terraformVariables).toContain('variable "mail_from_email"');
    expect(terraformVariables).toContain('variable "document_worker_recovery_schedule"');
    expect(terraformVariables).toContain('variable "crawler_worker_recovery_schedule"');
    expect(terraformMain).toContain('"0 * * * *"');
    expect(terraformMain).toContain('"0 3 * * *"');
    expect(terraformApis).toContain('"cloudscheduler.googleapis.com"');
    expect(terraformApis).toContain('"monitoring.googleapis.com"');
    expect(terraformApis).toContain('"logging.googleapis.com"');
    expect(monitoringTf).toContain('resource "google_logging_metric" "scheduler_job_failures"');
    expect(monitoringTf).toContain('cloudscheduler.googleapis.com%2Fexecutions');
    expect(monitoringTf).toContain('jsonPayload.\\"@type\\"');
    expect(monitoringTf).toContain('metric.type=\\"logging.googleapis.com/user/${google_logging_metric.scheduler_job_failures[0].name}\\"');
    expect(monitoringTf).toContain('group_by_fields      = ["metric.label.job_id"]');
    expect(monitoringTf).not.toContain('cloudscheduler.googleapis.com/job/attempt_count');
    expect(terraformApis).not.toContain('"vpcaccess.googleapis.com"');
    expect(terraformApis).not.toContain('"cloudresourcemanager.googleapis.com"');
    expect(terraformApis).not.toContain('"iam.googleapis.com"');
    expect(terraformApis).not.toContain('"iamcredentials.googleapis.com"');
    expect(terraformApis).not.toContain('"sts.googleapis.com"');
    expect(schedulerTf).toContain('resource "google_cloud_scheduler_job" "document_worker_recovery"');
    expect(schedulerTf).toContain("schedule = local.document_worker_recovery_schedule");
    expect(schedulerTf).toContain('resource "google_cloud_scheduler_job" "crawler_worker_recovery"');
    expect(schedulerTf).toContain("schedule = local.crawler_worker_recovery_schedule");
    expect(schedulerTf).toContain('resource "google_cloud_scheduler_job" "copilot_retention"');
    expect(schedulerTf).toContain("schedule = local.copilot_retention_schedule");
    // Counted against the jobs actually declared rather than a fixed number: the invariant is
    // that EVERY scheduled push authenticates, and a hardcoded count silently stops checking the
    // job that pushed it past the number.
    const schedulerJobCount = (schedulerTf.match(/resource "google_cloud_scheduler_job"/g) ?? []).length;
    expect(schedulerJobCount).toBeGreaterThanOrEqual(4);
    expect((schedulerTf.match(/"X-Radioso-Worker-Token"\s+=\s+random_password\.worker_task_auth_token\.result/g) ?? [])).toHaveLength(schedulerJobCount);
    expect((schedulerTf.match(/oidc_token \{/g) ?? [])).toHaveLength(schedulerJobCount);
    for (const policyName of [
      "backend_unreachable",
      "cloud_run_server_errors",
      "backend_latency",
      "application_error_rate",
      "cloudsql_saturation",
      "task_queue_backlog",
      "scheduler_job_failures",
    ]) {
      const policyStart = monitoringTf.indexOf(`resource "google_monitoring_alert_policy" "${policyName}"`);
      expect(policyStart, `${policyName} policy should exist`).toBeGreaterThanOrEqual(0);
      const nextPolicyStart = monitoringTf.indexOf('resource "google_monitoring_alert_policy"', policyStart + 1);
      const policyBlock = monitoringTf.slice(
        policyStart,
        nextPolicyStart === -1 ? undefined : nextPolicyStart,
      );
      expect(policyBlock, `${policyName} should wait for API enablement`).toMatch(/depends_on\s+= \[google_project_service\.apis\]/);
    }
    expect(databaseTf).toContain('resource "random_password" "worker_task_auth_token"');
    expect(databaseTf).toMatch(/resource "random_password" "worker_task_auth_token" \{[\s\S]*?length\s+=\s+(?:3[2-9]|[4-9]\d|\d{3,})/);
    expect(secretsTf).toMatch(/"worker-task-auth-token"\s+=\s+random_password\.worker_task_auth_token\.result/);
    expect(registryTf).toContain('id     = "delete-untagged-older-than-7-days"');
    expect(registryTf).toContain('id     = "delete-tagged-older-than-30-days"');
    expect(terraformWorkflow).toContain("TF_VAR_resend_mail_api_key: ${{ secrets.RESEND_MAIL_API_KEY }}");
    expect(terraformWorkflow).toContain("APP_BASE_URL: ${{ vars.APP_BASE_URL }}");
    expect(terraformWorkflow).toContain("PUBLIC_CHAT_BASE_URL: ${{ vars.PUBLIC_CHAT_BASE_URL }}");
    expect(terraformWorkflow).toContain('APP_BASE_URL_OVERRIDE="${APP_BASE_URL:-$FRONTEND_URL}"');
    expect(terraformWorkflow).toContain('PUBLIC_CHAT_BASE_URL_OVERRIDE="${PUBLIC_CHAT_BASE_URL:-${APP_BASE_URL_OVERRIDE%/}/chat}"');
    expect(terraformWorkflow).toContain("TF_VAR_mail_from_email: ${{ vars.MAIL_FROM_EMAIL }}");
    expect(terraformWorkflow).toContain("TF_VAR_mail_from_name");
    expect(terraformWorkflow).not.toContain("MAIL_SMTP");
    expect(terraformFoundation).toContain("assertion.ref == 'refs/heads/main'");
    expect(stagingEnv).not.toContain("mail_driver");
    expect(stagingEnv).toContain("resend_mail_api_key");
    expect(stagingEnv).toContain("mail_from_email");
    expect(stagingEnv).toContain("mail_from_name");
    expect(stagingEnv).toContain("document_worker_recovery_schedule");
    expect(stagingEnv).toContain("crawler_worker_recovery_schedule");
    expect(stagingEnvVariables).toContain('variable "document_worker_recovery_schedule"');
    expect(stagingEnvVariables).toContain('variable "crawler_worker_recovery_schedule"');
    expect(stagingEnvVariables).not.toContain('default     = "0 * * * *"');
    expect(stagingEnvVariables).not.toContain('default     = "0 3 * * *"');
    expect(liveEnv).not.toContain("mail_driver");
    expect(liveEnv).toContain("resend_mail_api_key");
    expect(liveEnv).toContain("mail_from_email");
    expect(liveEnv).toContain("mail_from_name");
    expect(liveEnv).toContain("document_worker_recovery_schedule");
    expect(liveEnv).toContain("crawler_worker_recovery_schedule");
    expect(liveEnvVariables).toContain('variable "document_worker_recovery_schedule"');
    expect(liveEnvVariables).toContain('variable "crawler_worker_recovery_schedule"');
    expect(liveEnvVariables).not.toContain('default     = "0 * * * *"');
    expect(liveEnvVariables).not.toContain('default     = "0 3 * * *"');
    expect(stagingEnvVariables).toMatch(/default\s+= "staging"/);
    expect(liveEnvVariables).toMatch(/default\s+= "live"/);
    expect(liveEnvVariables).toMatch(/variable "region" \{[\s\S]*?default\s+= "us-central1"\n\}/);
  });

  it("defines an isolated EU live environment without taking ownership of shared project services", async () => {
    const terraformVariables = await readFile(new URL("../../../infra/terraform/variables.tf", import.meta.url), "utf8");
    const terraformApis = await readFile(new URL("../../../infra/terraform/apis.tf", import.meta.url), "utf8");
    const terraformSecrets = await readFile(new URL("../../../infra/terraform/secrets.tf", import.meta.url), "utf8");
    const terraformWorkflow = await readFile(new URL("../../../.github/workflows/terraform.yml", import.meta.url), "utf8");
    const deployLive = await readFile(new URL("../../../.github/workflows/deploy-live.yml", import.meta.url), "utf8");
    const deployLiveUs = await readFile(new URL("../../../.github/workflows/deploy-live-us.yml", import.meta.url), "utf8");
    const liveEuEnv = await readFile(new URL("../../../infra/terraform/environments/live-eu/main.tf", import.meta.url), "utf8");
    const liveEuEnvVariables = await readFile(new URL("../../../infra/terraform/environments/live-eu/variables.tf", import.meta.url), "utf8");
    const liveEuBackend = await readFile(new URL("../../../infra/terraform/environments/live-eu/backend.hcl", import.meta.url), "utf8");
    const foundationTfvarsExample = await readFile(new URL("../../../infra/terraform/foundation/terraform.tfvars.example", import.meta.url), "utf8");

    expect(terraformVariables).toContain('contains(["staging", "live", "live-eu"], var.environment)');
    expect(terraformVariables).toContain('variable "manage_project_services"');
    expect(terraformVariables).toContain('variable "secret_replication_locations"');
    expect(terraformApis).toContain("var.manage_project_services ? toset(local.required_apis) : toset([])");
    expect(terraformSecrets).toContain('for_each = length(var.secret_replication_locations) == 0 ? [true] : []');
    expect(terraformSecrets).toContain("for_each = var.secret_replication_locations");

    expect(liveEuEnv).toContain("manage_project_services = false");
    expect(liveEuEnv).toMatch(/secret_replication_locations\s+= \[var\.region\]/);
    expect(foundationTfvarsExample).toMatch(/github_actions_workload_identity_pool_id\s+= "github-actions-live-eu"/);
    expect(foundationTfvarsExample).toMatch(/github_actions_workload_identity_provider_id\s+= "github-actions-live-eu"/);
    expect(liveEuEnv).toMatch(/worker_task_queue_name\s+= "radioso-\$\{var\.environment\}-document-processing"/);
    expect(liveEuEnvVariables).toMatch(/default\s+= "live-eu"/);
    expect(liveEuEnvVariables).toMatch(/default\s+= "europe-west1"/);
    expect(liveEuBackend).toContain('bucket = "radioso-494120-terraform-state-eu"');
    expect(liveEuBackend).toContain('prefix = "radioso/live-eu"');

    expect(terraformWorkflow).toContain("          - live-eu");
    expect(terraformWorkflow).toContain("      initial_backend_image:");
    expect(terraformWorkflow).toContain("      initial_frontend_image:");
    expect(terraformWorkflow).toContain("      initial_worker_tasks_service_url:");
    expect(terraformWorkflow).toContain("INITIAL_BACKEND_IMAGE: ${{ inputs.initial_backend_image }}");
    expect(terraformWorkflow).toContain("INITIAL_FRONTEND_IMAGE: ${{ inputs.initial_frontend_image }}");
    expect(terraformWorkflow).toContain(
      "INITIAL_WORKER_TASKS_SERVICE_URL: ${{ inputs.initial_worker_tasks_service_url }}",
    );
    expect(terraformWorkflow).toContain(
      "initial_backend_image, initial_frontend_image, and initial_worker_tasks_service_url are all required for a bootstrap run.",
    );
    expect(terraformWorkflow).toContain(
      "initial_worker_tasks_service_url must be a stable HTTPS endpoint for the worker service.",
    );
    expect(terraformWorkflow).toContain(
      "APP_BASE_URL must be configured when bootstrapping an environment without an existing frontend service.",
    );
    expect(terraformWorkflow).toMatch(
      /if \[ -n "\$\{INITIAL_BACKEND_IMAGE\}" \] \|\| \[ -n "\$\{INITIAL_FRONTEND_IMAGE\}" \] \|\| \[ -n "\$\{INITIAL_WORKER_TASKS_SERVICE_URL\}" \]; then[\s\S]*?BACKEND_IMAGE="\$\{INITIAL_BACKEND_IMAGE\}"[\s\S]*?FRONTEND_IMAGE="\$\{INITIAL_FRONTEND_IMAGE\}"[\s\S]*?WORKER_URL="\$\{INITIAL_WORKER_TASKS_SERVICE_URL%\/\}"[\s\S]*?else[\s\S]*?gcloud run services describe/,
    );
    expect(terraformWorkflow).not.toContain('BACKEND_URL=');
    expect(terraformWorkflow).toContain(
      "Worker service URL could not be resolved; refusing to use Terraform's placeholder URL.",
    );
    expect(terraformWorkflow).toContain(
      'echo "TF_VAR_worker_tasks_service_url_override=${WORKER_URL}" >> "$GITHUB_ENV"',
    );
    expect(terraformWorkflow).not.toContain('if [ -n "${WORKER_URL}" ]; then');
    expect(deployLive).toContain("github_environment: live-eu");
    expect(deployLive).toContain("artifact_repository: radioso-live-eu");
    expect(deployLive).toContain("backend_service: radioso-live-eu-backend");
    expect(deployLive).toContain("mcp_service: radioso-live-eu-mcp");
    expect(deployLiveUs).toContain("github_environment: live");
    expect(deployLiveUs).toContain("backend_service: radioso-live-backend");
    expect(deployLiveUs).toContain("mcp_service: radioso-live-mcp");
  });

  it("keeps the retained US live data plane independent from EU", async () => {
    const terraformVariables = await readFile(new URL("../../../infra/terraform/variables.tf", import.meta.url), "utf8");
    const terraformCompute = await readFile(new URL("../../../infra/terraform/compute.tf", import.meta.url), "utf8");
    const liveEnv = await readFile(new URL("../../../infra/terraform/environments/live/main.tf", import.meta.url), "utf8");
    const liveEnvVariables = await readFile(new URL("../../../infra/terraform/environments/live/variables.tf", import.meta.url), "utf8");

    expect(terraformVariables).toContain('variable "frontend_backend_internal_url_override"');
    expect(terraformCompute).toContain("coalesce(var.frontend_backend_internal_url_override, google_cloud_run_v2_service.backend[0].uri)");
    expect(terraformVariables).toContain('variable "backend_public_invocation_enabled"');
    expect(terraformCompute).toContain("var.deploy_services && var.backend_public_invocation_enabled ? 1 : 0");
    // `terraform fmt` aligns `=` across a block, so the gap widens whenever a longer
    // argument name is added. Assert the wiring, not the column it lands in.
    expect(liveEnv).toMatch(/frontend_backend_internal_url_override\s+= var\.frontend_backend_internal_url_override/);
    expect(liveEnv).toMatch(/backend_public_invocation_enabled\s+= var\.backend_public_invocation_enabled/);
    expect(liveEnvVariables).toMatch(
      /variable "frontend_backend_internal_url_override" \{[\s\S]*?default\s+= null\n\}/,
    );
    expect(liveEnvVariables).toMatch(
      /variable "backend_public_invocation_enabled" \{[\s\S]*?default\s+= true\n\}/,
    );
  });

  it("defaults worker entrypoints to the worker observability service name", async () => {
    const workerEntry = await readFile(new URL("../../src/documentWorker.ts", import.meta.url), "utf8");
    const workerServerEntry = await readFile(new URL("../../src/documentWorkerServer.ts", import.meta.url), "utf8");

    expect(workerEntry).toContain('OBSERVABILITY_SERVICE_NAME: "radioso-worker"');
    expect(workerServerEntry).toContain('OBSERVABILITY_SERVICE_NAME: "radioso-worker"');
  });

  it("uses the shared realtime schema and rejects unsafe realtime relationships at runtime startup", () => {
    const env = getEnv({ ...baseEnv, REALTIME_MODE: "disabled" });
    expect(env.REALTIME_MAX_CONNECTIONS).toBe(500);
    expect(env.REALTIME_PLATFORM_CONCURRENCY).toBe(600);
    expect(env.REALTIME_DB_APPLICATION_NAME).toBe("radioso-realtime");
    expect(() => getEnv({
      ...baseEnv,
      REALTIME_MODE: "standalone",
      REALTIME_REDIS_URL: "redis://localhost:6379",
      REALTIME_ROLLOUT_MODE: "default-on",
      REALTIME_PLATFORM_CONCURRENCY: "1000",
      REALTIME_MAX_CONNECTIONS: "1000",
    })).toThrow(/below platform concurrency/i);
  });
});
