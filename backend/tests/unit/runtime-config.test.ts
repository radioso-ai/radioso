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

  it("keeps backend dev dependency installation aligned with backend workspace imports", async () => {
    const dockerfile = await readFile(new URL("../../../infra/backend.dev.Dockerfile", import.meta.url), "utf8");
    const entrypoint = await readFile(new URL("../../../infra/backend.dev.entrypoint.sh", import.meta.url), "utf8");

    for (const manifest of [
      "packages/conversation-contract/package.json",
      "packages/conversation-engine/package.json",
      "packages/connector-api/package.json",
      "packages/crawler/package.json",
      "packages/document-parser/package.json",
      "packages/radioso-mcp-server/package.json",
      "packages/skill-contract/package.json",
      "packages/usage-contract/package.json",
    ]) {
      expect(dockerfile).toContain(`COPY ${manifest}`);
    }

    expect(entrypoint).toContain("backend_modules_ready");
    expect(entrypoint).toContain("module_is_ready_from");
    expect(entrypoint).toContain("zod/package.json");
    expect(entrypoint).toContain("backend/node_modules/@radioso/conversation-engine");
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
    expect(env.ERROR_SINKS).toBe("audit");
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
    });

    expect(env.PRODUCT_ANALYTICS_SINKS).toBe("audit,posthog");
    expect(env.ERROR_SINKS).toBe("audit,sentry");
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
  });

  it("defaults backend MCP to disabled and non-standalone", () => {
    const env = getEnv({
      ...baseEnv,
    });

    expect(env.RADIOSO_MCP_ENABLED).toBe(false);
    expect(env.RADIOSO_MCP_STANDALONE).toBe(false);
    expect(env.RADIOSO_MCP_MOUNT_PATH).toBe("/mcp");
    expect(env.RADIOSO_MCP_MERGED_CORS_ORIGINS).toBe("*");
  });

  it("keeps the reusable conversation engine disabled by default", () => {
    const env = getEnv({
      ...baseEnv,
    });

    expect(env.RADIOSO_CONVERSATION_ENGINE_ENABLED).toBe(false);
  });

  it("accepts the reusable conversation engine feature flag", () => {
    const env = getEnv({
      ...baseEnv,
      RADIOSO_CONVERSATION_ENGINE_ENABLED: "true",
    });

    expect(env.RADIOSO_CONVERSATION_ENGINE_ENABLED).toBe(true);
  });

  it("accepts merged MCP deployment settings", () => {
    const env = getEnv({
      ...baseEnv,
      RADIOSO_BASE_URL: "https://radioso.example.com",
      RADIOSO_MCP_ENABLED: "true",
      RADIOSO_MCP_STANDALONE: "false",
      RADIOSO_MCP_MOUNT_PATH: "/internal/mcp",
      RADIOSO_MCP_MERGED_CORS_ORIGINS: "https://cursor.example,https://client.example",
      RADIOSO_MCP_SIGNING_SECRET: "0123456789abcdef",
      RADIOSO_MCP_REDIS_URL: "redis://localhost:6379",
      RADIOSO_MCP_REDIS_KEY_PREFIX: "radioso-mcp-test",
      RADIOSO_MCP_ALLOWED_READ_TOOLS: "describe_capabilities,list_documents",
      RADIOSO_MCP_ALLOWED_WRITE_TOOLS: "create_document",
      RADIOSO_MCP_APPROVAL_REQUIRED_WRITE_TOOLS: "create_document",
      RADIOSO_MCP_AUDIT_LOG_PATH: "/tmp/radioso-mcp-audit.jsonl",
    });

    expect(env.RADIOSO_MCP_ENABLED).toBe(true);
    expect(env.RADIOSO_MCP_STANDALONE).toBe(false);
    expect(env.RADIOSO_MCP_MOUNT_PATH).toBe("/internal/mcp");
    expect(env.RADIOSO_MCP_MERGED_CORS_ORIGINS).toBe("https://cursor.example,https://client.example");
    expect(env.RADIOSO_MCP_REDIS_URL).toBe("redis://localhost:6379");
    expect(env.RADIOSO_MCP_ALLOWED_READ_TOOLS).toBe("describe_capabilities,list_documents");
    expect(env.RADIOSO_MCP_AUDIT_LOG_PATH).toBe("/tmp/radioso-mcp-audit.jsonl");
  });

  it("rejects invalid merged MCP mount paths", () => {
    expect(() => getEnv({
      ...baseEnv,
      RADIOSO_BASE_URL: "https://radioso.example.com",
      RADIOSO_MCP_ENABLED: "true",
      RADIOSO_MCP_MOUNT_PATH: "mcp",
      RADIOSO_MCP_SIGNING_SECRET: "0123456789abcdef",
    })).toThrow(/RADIOSO_MCP_MOUNT_PATH/);
  });

  it("requires a signing secret when merged MCP is enabled", () => {
    expect(() => getEnv({
      ...baseEnv,
      RADIOSO_BASE_URL: "https://radioso.example.com",
      RADIOSO_MCP_ENABLED: "true",
      RADIOSO_MCP_SIGNING_SECRET: "",
    })).toThrow(/RADIOSO_MCP_SIGNING_SECRET/);
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
    expect(example).toContain("RADIOSO_MCP_ENABLED=false");
    expect(example).toContain("RADIOSO_MCP_STANDALONE=false");
    expect(example).toContain("RADIOSO_MCP_MOUNT_PATH=/mcp");
    expect(example).toContain("RADIOSO_MCP_MERGED_CORS_ORIGINS=*");
    expect(example).toContain("MAIL_DRIVER=log");
    expect(example).toContain("MAIL_FROM_EMAIL=noreply@example.com");
    expect(example).toContain("MAIL_FROM_NAME=Radioso");
    expect(example).toContain("RESEND_MAIL_API_KEY=");
    expect(example).toContain("PASSWORD_RESET_TOKEN_TTL_MINUTES=30");
    expect(example).toContain("EMAIL_VERIFICATION_TOKEN_TTL_MINUTES=30");
  });

  it("pins environment-aware observability identity and cloud runtime URLs for the Cloud Run API and worker services", async () => {
    const computeTf = await readFile(new URL("../../../infra/terraform/compute.tf", import.meta.url), "utf8");
    const githubActionsTf = await readFile(new URL("../../../infra/terraform/github_actions.tf", import.meta.url), "utf8");
    const terraformWorkflow = await readFile(new URL("../../../.github/workflows/terraform.yml", import.meta.url), "utf8");
    const terraformMain = await readFile(new URL("../../../infra/terraform/main.tf", import.meta.url), "utf8");
    const terraformVariables = await readFile(new URL("../../../infra/terraform/variables.tf", import.meta.url), "utf8");
    const terraformApis = await readFile(new URL("../../../infra/terraform/apis.tf", import.meta.url), "utf8");
    const schedulerTf = await readFile(new URL("../../../infra/terraform/scheduler.tf", import.meta.url), "utf8");
    const registryTf = await readFile(new URL("../../../infra/terraform/registry.tf", import.meta.url), "utf8");
    const stagingEnv = await readFile(new URL("../../../infra/terraform/environments/staging/main.tf", import.meta.url), "utf8");
    const liveEnv = await readFile(new URL("../../../infra/terraform/environments/live/main.tf", import.meta.url), "utf8");

    expect(computeTf).toContain('name  = "OBSERVABILITY_ENVIRONMENT"');
    expect(computeTf).toContain('value = var.environment');
    expect(computeTf).toContain('name  = "OBSERVABILITY_SERVICE_NAME"');
    expect(computeTf).toContain('value = "radioso-api"');
    expect(computeTf).toContain('value = "radioso-worker"');
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
    expect(computeTf).toContain('network_interfaces {');
    expect(computeTf).toContain('secret  = google_secret_manager_secret.secrets["database-url"].secret_id');
    expect(computeTf).not.toContain("cpu_idle = false");
    expect(computeTf).not.toContain('name  = "MAIL_DRIVER"');
    expect(computeTf).toContain('for_each = var.resend_mail_api_key != null ? [google_secret_manager_secret.secrets["resend-mail-api-key"].secret_id] : []');
    expect(computeTf).toContain('name = "RESEND_MAIL_API_KEY"');
    expect((computeTf.match(/name = "RESEND_MAIL_API_KEY"/g) ?? [])).toHaveLength(2);
    expect(computeTf).toContain('name  = "MAIL_FROM_EMAIL"');
    expect((computeTf.match(/name  = "MAIL_FROM_EMAIL"/g) ?? [])).toHaveLength(2);
    expect(computeTf).toContain('name  = "MAIL_FROM_NAME"');
    expect((computeTf.match(/name  = "MAIL_FROM_NAME"/g) ?? [])).toHaveLength(2);
    expect(computeTf).not.toContain('name  = "AUTH_SKIP_EMAIL_VERIFICATION"');
    expect(computeTf).toContain('ignore_changes = [');
    expect(computeTf).toContain('client_version,');
    expect(computeTf).toContain('template[0].containers[0].image,');
    expect(githubActionsTf).toContain('roles/run.admin');
    expect(githubActionsTf).toContain('roles/artifactregistry.writer');
    expect(githubActionsTf).toContain('roles/cloudscheduler.admin');
    expect(githubActionsTf).toContain('resource "google_service_account_iam_member" "github_actions_worker_task_invoker_act_as"');
    expect(githubActionsTf).toContain('https://token.actions.githubusercontent.com');
    expect(terraformMain).toContain('worker_tasks_service_url = coalesce(var.worker_tasks_service_url_override, "https://example.invalid")');
    expect(terraformMain).toContain('resource_name_prefix         = "${local.service_name}-${var.environment}"');
    expect(terraformMain).toContain('app_base_url = coalesce(var.app_base_url_override, "https://example.invalid")');
    expect(terraformVariables).toContain('app_base_url_override must be set when radioso_edition is enterprise.');
    expect(terraformVariables).toContain('variable "mail_from_email"');
    expect(terraformVariables).toContain('default     = "*/15 * * * *"');
    expect(terraformApis).toContain('"cloudscheduler.googleapis.com"');
    expect(terraformApis).not.toContain('"vpcaccess.googleapis.com"');
    expect(schedulerTf).toContain('resource "google_cloud_scheduler_job" "document_worker_recovery"');
    expect(schedulerTf).toContain('resource "google_cloud_scheduler_job" "crawler_worker_recovery"');
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
    expect(githubActionsTf).toContain("assertion.ref == 'refs/heads/main'");
    expect(stagingEnv).not.toContain("mail_driver");
    expect(stagingEnv).toContain("resend_mail_api_key");
    expect(stagingEnv).toContain("mail_from_email");
    expect(stagingEnv).toContain("mail_from_name");
    expect(liveEnv).not.toContain("mail_driver");
    expect(liveEnv).toContain("resend_mail_api_key");
    expect(liveEnv).toContain("mail_from_email");
    expect(liveEnv).toContain("mail_from_name");
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
