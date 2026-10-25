import { readFile } from "node:fs/promises";

import { describe, expect, it } from "vitest";
import YAML from "yaml";
import { emailChannelConfigGaps, getEnv, parseEmailChannelConfig } from "../../src/app/config/env.js";

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
      "./packages/operator-mcp-contract/src:/app/packages/operator-mcp-contract/src",
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
      "packages/operator-mcp-contract/package.json",
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
    expect(dockerfile).toContain("COPY packages/operator-mcp-contract ./packages/operator-mcp-contract");
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
      "COPY packages/operator-mcp-contract/package.json ./packages/operator-mcp-contract/package.json",
      "COPY packages/operator-mcp-contract ./packages/operator-mcp-contract",
      "COPY --chown=node:node --from=build /app/packages/operator-mcp-contract/dist ./packages/operator-mcp-contract/dist",
      "@radioso/conversation-tools...",
    ]) {
      expect(dockerfile).toContain(expected);
    }

    expect(workflow).toContain("packages/conversation-tools/**");
    expect(workflow).toContain("packages/mcp-source-proof/**");
    expect(workflow).toContain("packages/operator-mcp-contract/**");
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
    expect(
      sharedDeployWorkflow.match(
        /--update-env-vars "RADIOSO_EDITION=\$\{RADIOSO_EDITION\},RADIOSO_RELEASE=\$\{RADIOSO_RELEASE\},RADIOSO_COMMIT=\$\{RELEASE_COMMIT\}"/g,
      ),
    ).toHaveLength(4);
    expect(sharedDeployWorkflow).toContain(
      '--update-env-vars "RADIOSO_EDITION=${RADIOSO_EDITION},NEXT_PUBLIC_RADIOSO_EDITION=${RADIOSO_EDITION}"',
    );
  });

  it("stamps the release it ships into the image it builds", async () => {
    const dockerfile = await readFile(new URL("../../../infra/backend.Dockerfile", import.meta.url), "utf8");
    const sharedDeployWorkflow = await readFile(
      new URL("../../../.github/workflows/_deploy-cloud-run.yml", import.meta.url),
      "utf8",
    );
    const liveWorkflow = await readFile(
      new URL("../../../.github/workflows/deploy-live.yml", import.meta.url),
      "utf8",
    );

    // A release deploy builds the tag, which is not necessarily the commit the workflow was
    // dispatched from, so both the ancestry check and the image tag read the checked-out commit.
    expect(sharedDeployWorkflow).toContain("ref: ${{ inputs.release }}");
    expect(sharedDeployWorkflow).toContain("git merge-base --is-ancestor HEAD refs/remotes/origin/main");
    expect(sharedDeployWorkflow).toContain("backend:${RELEASE_COMMIT}");
    expect(sharedDeployWorkflow).not.toContain("backend:${GITHUB_SHA}");
    expect(sharedDeployWorkflow).toContain('--build-arg RADIOSO_RELEASE="${RADIOSO_RELEASE}"');
    expect(sharedDeployWorkflow).toContain('--build-arg RADIOSO_COMMIT="${RELEASE_COMMIT}"');

    expect(dockerfile).toContain("ARG RADIOSO_RELEASE=development");
    expect(dockerfile).toContain("ENV RADIOSO_RELEASE=${RADIOSO_RELEASE}");
    expect(dockerfile).toContain("OBSERVABILITY_VERSION=${RADIOSO_RELEASE}");

    // Production ships a release someone named, never whatever main happened to be.
    expect(liveWorkflow).toContain("required: true");
    expect(liveWorkflow).toContain("release: ${{ inputs.release }}");
  });

  it("refuses a release input that is not an existing release tag", async () => {
    const sharedDeployWorkflow = await readFile(
      new URL("../../../.github/workflows/_deploy-cloud-run.yml", import.meta.url),
      "utf8",
    );

    // A workflow_dispatch input is free text, so "main" or a bare SHA would otherwise satisfy
    // the ancestry check and ship as a release, stamping images and /health with a non-version.
    expect(sharedDeployWorkflow).toContain("grep -Eq '^v[0-9]+\\.[0-9]+\\.[0-9]+$'");
    expect(sharedDeployWorkflow).toContain(
      'git ls-remote --exit-code --tags origin "refs/tags/${RELEASE}"',
    );
    // A branch sharing the tag's name wins the checkout, so the tag's commit is compared to
    // what was actually checked out rather than the name being trusted.
    expect(sharedDeployWorkflow).toContain('git rev-parse "refs/tags/${RELEASE}^{commit}"');
    expect(sharedDeployWorkflow).toContain('if [ "${tag_commit}" != "${commit}" ]; then');
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

  it("boots an unstamped build rather than demanding a release it was not given", () => {
    const unstamped = getEnv({ ...baseEnv });
    expect(unstamped.RADIOSO_RELEASE).toBe("development");
    expect(unstamped.RADIOSO_COMMIT).toBe("unknown");

    // An empty value is what a compose file or a Cloud Run variable left blank actually sends.
    const blank = getEnv({ ...baseEnv, RADIOSO_RELEASE: "", RADIOSO_COMMIT: "" });
    expect(blank.RADIOSO_RELEASE).toBe("development");
    expect(blank.RADIOSO_COMMIT).toBe("unknown");

    const stamped = getEnv({ ...baseEnv, RADIOSO_RELEASE: "1.4.0", RADIOSO_COMMIT: "5434e0e" });
    expect(stamped.RADIOSO_RELEASE).toBe("1.4.0");
    expect(stamped.RADIOSO_COMMIT).toBe("5434e0e");
  });

  it("keeps the quick-reply lane on unless CHAT_QUICK_REPLY_LANE turns it off", () => {
    expect(getEnv({ ...baseEnv }).CHAT_QUICK_REPLY_LANE).toBe("on");
    expect(getEnv({ ...baseEnv, CHAT_QUICK_REPLY_LANE: "" }).CHAT_QUICK_REPLY_LANE).toBe("on");
    expect(getEnv({ ...baseEnv, CHAT_QUICK_REPLY_LANE: "off" }).CHAT_QUICK_REPLY_LANE).toBe("off");
    expect(() => getEnv({ ...baseEnv, CHAT_QUICK_REPLY_LANE: "disabled" })).toThrow();
  });

  it("provides default observability configuration without extra vendor settings", () => {
    const env = getEnv({
      ...baseEnv,
    });

    expect(env.RADIOSO_TRUSTED_PROXY_HOPS).toBe(0);
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

  it("enables notification recipient confirmation by default and accepts an explicit opt-out", () => {
    expect(getEnv({ ...baseEnv }).NOTIFICATION_RECIPIENT_CONFIRMATION_ENABLED).toBe(true);
    expect(getEnv({
      ...baseEnv,
      NOTIFICATION_RECIPIENT_CONFIRMATION_ENABLED: "false",
    }).NOTIFICATION_RECIPIENT_CONFIRMATION_ENABLED).toBe(false);
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

  it("allows verification-link exposure only in development", () => {
    const env = getEnv({
      ...baseEnv,
      NODE_ENV: "development",
      AUTH_EXPOSE_EMAIL_VERIFICATION_LINK: "true",
      AUTH_PENDING_REGISTRATION_TTL_MINUTES: "12",
    });

    expect(env.AUTH_EXPOSE_EMAIL_VERIFICATION_LINK).toBe(true);
    expect(env.AUTH_PENDING_REGISTRATION_TTL_MINUTES).toBe(12);
    expect(() => getEnv({
      ...baseEnv,
      AUTH_PENDING_REGISTRATION_TTL_MINUTES: "61",
    })).toThrow(/AUTH_PENDING_REGISTRATION_TTL_MINUTES/);
    for (const nodeEnv of ["test", "production"] as const) {
      expect(() => getEnv({
        ...baseEnv,
        NODE_ENV: nodeEnv,
        AUTH_EXPOSE_EMAIL_VERIFICATION_LINK: "true",
      })).toThrow(/AUTH_EXPOSE_EMAIL_VERIFICATION_LINK/);
    }
  });

  it("requires an OTLP endpoint when tracing is enabled", () => {
    expect(() => getEnv({
      ...baseEnv,
      OTEL_ENABLED: "true",
    })).toThrow(/OTEL_EXPORTER_OTLP_ENDPOINT/);
  });

  it("refuses to start on a non-zero TRUST_PROXY_HOPS, naming the setting that replaces it", () => {
    expect(() => getEnv({
      ...baseEnv,
      TRUST_PROXY_HOPS: "2",
    })).toThrow(/TRUST_PROXY_HOPS.*RADIOSO_TRUSTED_PROXY_HOPS/);
  });

  it("starts on a zero or empty TRUST_PROXY_HOPS, which asks for the default hop count", () => {
    for (const value of ["0", ""]) {
      const env = getEnv({
        ...baseEnv,
        TRUST_PROXY_HOPS: value,
      });

      expect(env.RADIOSO_TRUSTED_PROXY_HOPS).toBe(0);
      expect(env).not.toHaveProperty("TRUST_PROXY_HOPS");
    }
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
    expect(example).toContain("LETTERMINT_PROJECT_TOKEN=");
    expect(example).toContain("NOTIFICATION_RECIPIENT_CONFIRMATION_ENABLED=true");
    expect(example).toContain("PASSWORD_RESET_TOKEN_TTL_MINUTES=30");
    expect(example).toContain("EMAIL_VERIFICATION_TOKEN_TTL_MINUTES=30");
  });

  it("leaves Operator MCP opt-in configuration empty in the example environment", async () => {
    const example = await readFile(new URL("../../../.env.example", import.meta.url), "utf8");

    for (const setting of [
      "OPERATOR_MCP_RESOURCE_URL",
      "OPERATOR_MCP_ISSUER_URL",
      "OPERATOR_MCP_INTERNAL_SECRET",
      "OPERATOR_MCP_CREDENTIAL_EPOCH",
    ]) {
      expect(example).toMatch(new RegExp(`^${setting}=$`, "m"));
    }
  });

  it("defaults OPENAI_DATA_RESIDENCY to global and validates its enum", () => {
    expect(getEnv({ ...baseEnv }).OPENAI_DATA_RESIDENCY).toBe("global");
    expect(getEnv({ ...baseEnv, OPENAI_DATA_RESIDENCY: "" }).OPENAI_DATA_RESIDENCY).toBe("global");
    expect(getEnv({ ...baseEnv, OPENAI_DATA_RESIDENCY: "us" }).OPENAI_DATA_RESIDENCY).toBe("us");
    expect(getEnv({ ...baseEnv, OPENAI_DATA_RESIDENCY: "eu" }).OPENAI_DATA_RESIDENCY).toBe("eu");
    expect(() => getEnv({ ...baseEnv, OPENAI_DATA_RESIDENCY: "apac" })).toThrow();
  });

  it("documents OPENAI_DATA_RESIDENCY in the example environment", async () => {
    const example = await readFile(new URL("../../../.env.example", import.meta.url), "utf8");
    expect(example).toContain("OPENAI_DATA_RESIDENCY=global");
  });

  it("wires the OpenAI data-residency setting into every service that gets OPENAI_API_KEY", async () => {
    const terraformVariables = await readFile(new URL("../../../infra/terraform/variables.tf", import.meta.url), "utf8");
    const computeTf = await readFile(new URL("../../../infra/terraform/compute.tf", import.meta.url), "utf8");
    const terraformWorkflow = await readFile(new URL("../../../.github/workflows/terraform.yml", import.meta.url), "utf8");

    expect(terraformVariables).toMatch(
      /variable "openai_data_residency" \{[\s\S]*?default\s+= "global"[\s\S]*?\n\}/,
    );
    expect(terraformVariables).toContain('contains(["global", "us", "eu"], var.openai_data_residency)');

    // Backend, document worker, and crawler worker — the three services that receive
    // OPENAI_API_KEY (infra/terraform/compute.tf). MCP does not call OpenAI, so it gets neither.
    expect((computeTf.match(/name\s+= "OPENAI_API_KEY"/g) ?? [])).toHaveLength(3);
    expect((computeTf.match(/name {2}= "OPENAI_DATA_RESIDENCY"\s*\n\s*value = var\.openai_data_residency/g) ?? [])).toHaveLength(3);

    expect(terraformWorkflow).toContain("OPENAI_DATA_RESIDENCY: ${{ vars.OPENAI_DATA_RESIDENCY }}");
    expect(terraformWorkflow).toContain('if [ -n "${OPENAI_DATA_RESIDENCY}" ]; then');
    expect(terraformWorkflow).toContain("TF_VAR_openai_data_residency=${OPENAI_DATA_RESIDENCY}");

    for (const environment of ["staging", "live", "live-eu"]) {
      const wrapperVariables = await readFile(
        new URL(`../../../infra/terraform/environments/${environment}/variables.tf`, import.meta.url),
        "utf8",
      );
      const wrapperMain = await readFile(
        new URL(`../../../infra/terraform/environments/${environment}/main.tf`, import.meta.url),
        "utf8",
      );
      expect(wrapperVariables, `${environment} does not declare openai_data_residency`).toContain(
        'variable "openai_data_residency"',
      );
      expect(wrapperMain, `${environment} does not pass openai_data_residency to the root module`).toMatch(
        /openai_data_residency\s+= var\.openai_data_residency/,
      );
    }
  });

  it("normalizes AZURE_OPENAI_ENDPOINT and rejects a non-Azure host", () => {
    expect(getEnv({ ...baseEnv, AZURE_OPENAI_ENDPOINT: "" }).AZURE_OPENAI_ENDPOINT).toBeUndefined();
    expect(getEnv({ ...baseEnv, AZURE_OPENAI_ENDPOINT: "https://radioso-eu-1.openai.azure.com" }).AZURE_OPENAI_ENDPOINT).toBe(
      "https://radioso-eu-1.openai.azure.com/openai/v1",
    );
    expect(
      getEnv({ ...baseEnv, AZURE_OPENAI_ENDPOINT: "https://radioso-eu-1.openai.azure.com/openai/v1/" })
        .AZURE_OPENAI_ENDPOINT,
    ).toBe("https://radioso-eu-1.openai.azure.com/openai/v1");
    expect(() => getEnv({ ...baseEnv, AZURE_OPENAI_ENDPOINT: "https://attacker.example/v1" })).toThrow();
  });

  it("reports a named zod issue — never a raw TypeError — for a malformed AZURE_OPENAI_ENDPOINT value", () => {
    // "radioso-eu-1.openai.azure.com" (no scheme, exactly what an operator might paste straight
    // out of the Azure portal's resource summary) and whitespace both fail zod's own `.url()`
    // check; a naive `new URL(value)` inside a later `.refine()` would otherwise leak that
    // failure past zod's issue reporting as a raw, unhelpful `TypeError: Invalid URL`.
    for (const malformed of ["radioso-eu-1.openai.azure.com", "   "]) {
      let failure: unknown;
      try {
        getEnv({ ...baseEnv, AZURE_OPENAI_ENDPOINT: malformed });
      } catch (error) {
        failure = error;
      }
      expect(failure).toBeInstanceOf(Error);
      expect((failure as Error).name).not.toBe("TypeError");
      expect((failure as Error).message).toContain("AZURE_OPENAI_ENDPOINT");
    }
  });

  it("accepts a cognitiveservices.azure.com host", () => {
    expect(
      getEnv({ ...baseEnv, AZURE_OPENAI_ENDPOINT: "https://radioso-eu-1.cognitiveservices.azure.com" })
        .AZURE_OPENAI_ENDPOINT,
    ).toBe("https://radioso-eu-1.cognitiveservices.azure.com/openai/v1");
  });

  it("refuses startup when AZURE_OPENAI_ENDPOINT is combined with a non-global OPENAI_DATA_RESIDENCY", () => {
    expect(() =>
      getEnv({
        ...baseEnv,
        AZURE_OPENAI_ENDPOINT: "https://radioso-eu-1.openai.azure.com",
        OPENAI_DATA_RESIDENCY: "eu",
      }),
    ).toThrow();
    expect(() =>
      getEnv({ ...baseEnv, AZURE_OPENAI_ENDPOINT: "https://radioso-eu-1.openai.azure.com", OPENAI_DATA_RESIDENCY: "global" }),
    ).not.toThrow();
  });

  it("leaves AZURE_OPENAI_ENDPOINT empty in the example environment", async () => {
    const example = await readFile(new URL("../../../.env.example", import.meta.url), "utf8");
    expect(example).toMatch(/^AZURE_OPENAI_ENDPOINT=$/m);
  });

  it("wires AZURE_OPENAI_ENDPOINT into every service that gets OPENAI_API_KEY", async () => {
    const terraformVariables = await readFile(new URL("../../../infra/terraform/variables.tf", import.meta.url), "utf8");
    const computeTf = await readFile(new URL("../../../infra/terraform/compute.tf", import.meta.url), "utf8");
    const terraformWorkflow = await readFile(new URL("../../../.github/workflows/terraform.yml", import.meta.url), "utf8");

    expect(terraformVariables).toMatch(/variable "azure_openai_endpoint" \{[\s\S]*?default\s+= ""[\s\S]*?\n\}/);

    expect((computeTf.match(/name\s+= "AZURE_OPENAI_ENDPOINT"\s*\n\s*value = var\.azure_openai_endpoint/g) ?? []))
      .toHaveLength(3);

    expect(terraformWorkflow).toContain("AZURE_OPENAI_ENDPOINT: ${{ vars.AZURE_OPENAI_ENDPOINT }}");
    expect(terraformWorkflow).toContain('if [ -n "${AZURE_OPENAI_ENDPOINT}" ]; then');
    expect(terraformWorkflow).toContain("TF_VAR_azure_openai_endpoint=${AZURE_OPENAI_ENDPOINT}");

    for (const environment of ["staging", "live", "live-eu"]) {
      const wrapperVariables = await readFile(
        new URL(`../../../infra/terraform/environments/${environment}/variables.tf`, import.meta.url),
        "utf8",
      );
      const wrapperMain = await readFile(
        new URL(`../../../infra/terraform/environments/${environment}/main.tf`, import.meta.url),
        "utf8",
      );
      expect(wrapperVariables, `${environment} does not declare azure_openai_endpoint`).toContain(
        'variable "azure_openai_endpoint"',
      );
      expect(wrapperMain, `${environment} does not pass azure_openai_endpoint to the root module`).toMatch(
        /azure_openai_endpoint\s+= var\.azure_openai_endpoint/,
      );
    }
  });

  it("wires OPENAI_RERANK_MODEL as a per-environment GitHub variable, so live-eu can switch it without a code change", async () => {
    // live-eu's own default (environments/live-eu/variables.tf) is gpt-5.4-nano, which has no EU
    // Data Zone quota on Azure; switching the rerank model to gpt-5.4-mini for the Azure cutover
    // must be a GitHub Environment variable change, not a Terraform default edit.
    const terraformWorkflow = await readFile(new URL("../../../.github/workflows/terraform.yml", import.meta.url), "utf8");

    expect(terraformWorkflow).toContain("OPENAI_RERANK_MODEL: ${{ vars.OPENAI_RERANK_MODEL }}");
    expect(terraformWorkflow).toContain('if [ -n "${OPENAI_RERANK_MODEL}" ]; then');
    expect(terraformWorkflow).toContain("TF_VAR_openai_rerank_model=${OPENAI_RERANK_MODEL}");
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
    const liveEuEnv = await readFile(new URL("../../../infra/terraform/environments/live-eu/main.tf", import.meta.url), "utf8");
    const liveEuEnvVariables = await readFile(new URL("../../../infra/terraform/environments/live-eu/variables.tf", import.meta.url), "utf8");

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
    // Cloud Run's front end appends exactly the connecting peer, so both the
    // backend and the MCP service trust one hop and no more.
    expect(computeTf.match(/name {2}= "RADIOSO_TRUSTED_PROXY_HOPS"/g)).toHaveLength(2);
    expect(computeTf.match(/name {2}= "RADIOSO_TRUSTED_PROXY_HOPS"\s+value = "1"/g)).toHaveLength(2);
    expect(mcpService).toMatch(/name {2}= "RADIOSO_TRUSTED_PROXY_HOPS"\s+value = "1"/);
    expect(databaseTf).toContain('resource "random_password" "radioso_mcp_signing_secret"');
    expect(secretsTf).toMatch(/"radioso-mcp-signing-secret"\s+= random_password\.radioso_mcp_signing_secret\.result/u);
    expect(terraformVariables).not.toContain('variable "radioso_mcp_signing_secret"');
    expect(terraformWorkflow).not.toContain('RADIOSO_MCP_SIGNING_SECRET');
    expect(terraformVariables).toContain('variable "mcp_public_origin"');
    expect(terraformVariables).toContain('variable "operator_mcp_credential_epoch"');
    expect(terraformWorkflow).toContain("MCP_PUBLIC_ORIGIN: ${{ vars.MCP_PUBLIC_ORIGIN }}");
    expect(terraformWorkflow).toContain('TF_VAR_mcp_public_origin=${MCP_RESOURCE_ORIGIN%/}');
    expect(terraformWorkflow).toContain('MCP_URL="$(gcloud run services describe "${SERVICE_PREFIX}-mcp"');
    expect(terraformWorkflow).toContain('MCP_RESOURCE_ORIGIN="${MCP_PUBLIC_ORIGIN:-$MCP_URL}"');
    for (const [name, main, variables] of [
      ["staging", stagingEnv, stagingEnvVariables],
      ["live", liveEnv, liveEnvVariables],
      ["live-eu", liveEuEnv, liveEuEnvVariables],
    ] as const) {
      for (const setting of [
        "mcp_public_origin",
        "operator_mcp_credential_epoch",
      ]) {
        expect(variables, `${name} must expose ${setting}`).toContain(`variable "${setting}"`);
        expect(main, `${name} must pass ${setting}`).toMatch(new RegExp(`${setting}\\s+= var\\.${setting}`));
      }
    }
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
    // MAIL_DRIVER only reaches the runtime when an operator sets it; unset, the parsed TF_VAR
    // stays absent and the dynamic env block below contributes nothing.
    expect(computeTf).toContain('for_each = var.mail_driver != null ? [var.mail_driver] : []');
    expect((computeTf.match(/name {2}= "MAIL_DRIVER"/g) ?? [])).toHaveLength(2);
    expect(computeTf).toContain('for_each = var.resend_mail_api_key != null ? [google_secret_manager_secret.secrets["resend-mail-api-key"].secret_id] : []');
    expect(computeTf).toContain('name = "RESEND_MAIL_API_KEY"');
    expect((computeTf.match(/name = "RESEND_MAIL_API_KEY"/g) ?? [])).toHaveLength(2);
    // Lettermint mirrors Resend's transactional key and channel-only credentials, on both
    // services: one shared project token, plus a channel-only team token and project id.
    expect(computeTf).toContain('for_each = var.lettermint_project_token != null ? [google_secret_manager_secret.secrets["lettermint-project-token"].secret_id] : []');
    expect((computeTf.match(/name = "LETTERMINT_PROJECT_TOKEN"/g) ?? [])).toHaveLength(2);
    expect(computeTf).toContain('for_each = var.lettermint_team_token != null ? [google_secret_manager_secret.secrets["lettermint-team-token"].secret_id] : []');
    expect((computeTf.match(/name = "LETTERMINT_TEAM_TOKEN"/g) ?? [])).toHaveLength(2);
    expect(computeTf).toContain('for_each = var.lettermint_project_id != null ? [var.lettermint_project_id] : []');
    expect((computeTf.match(/name {2}= "LETTERMINT_PROJECT_ID"/g) ?? [])).toHaveLength(2);
    expect(computeTf).toContain('name  = "MAIL_FROM_EMAIL"');
    expect((computeTf.match(/name {2}= "MAIL_FROM_EMAIL"/g) ?? [])).toHaveLength(2);
    expect(computeTf).toContain('name  = "MAIL_FROM_NAME"');
    expect((computeTf.match(/name {2}= "MAIL_FROM_NAME"/g) ?? [])).toHaveLength(2);
    expect(computeTf).not.toContain('name  = "AUTH_SKIP_EMAIL_VERIFICATION"');
    expect(computeTf).toContain('ignore_changes = [');
    expect(computeTf).toContain('client_version,');
    expect(computeTf).toContain('template[0].containers[0].image,');
    expect(terraformFoundation).toContain('resource "google_project_iam_member" "ci_project_role"');
    // The CI identities never administer project IAM, service accounts, or the pool they authenticate through.
    expect(terraformFoundation).not.toContain("roles/resourcemanager.projectIamAdmin");
    expect(terraformFoundation).not.toContain("roles/iam.serviceAccountAdmin");
    expect(terraformFoundation).not.toContain("roles/iam.workloadIdentityPoolAdmin");
    expect(terraformFoundation).toContain('"attribute.job_workflow_ref" = "assertion.job_workflow_ref"');
    expect(terraformFoundation).toContain("/attribute.job_workflow_ref/${local.github_workflow_ref_prefix}/${each.value.workflow}@refs/heads/main");
    expect(terraformFoundation).not.toContain("attribute.repository/");
    expect(terraformFoundation).toContain('resource "google_project_service" "required_apis"');
    expect(terraformFoundation).toContain('"cloudresourcemanager.googleapis.com"');
    expect(terraformFoundation).toContain('"iam.googleapis.com"');
    expect(terraformFoundation).toContain('"iamcredentials.googleapis.com"');
    expect(terraformFoundation).toContain('"sts.googleapis.com"');
    expect(terraformFoundation).toContain('"serviceusage.googleapis.com"');
    expect(terraformFoundation).toContain("depends_on = [google_project_service.required_apis]");
    expect(terraformFoundation).toContain('resource "google_service_account_iam_member" "ci_act_as"');
    expect(terraformFoundation).toContain('resource "google_service_account_iam_member" "runtime_worker_task_act_as"');
    expect(terraformFoundation).toContain('resource "google_iam_workload_identity_pool_provider" "github_actions"');
    expect(terraformFoundation).toContain('https://token.actions.githubusercontent.com');
    expect(terraformFoundation).toContain("projects/${var.project_number}/locations/global/workloadIdentityPools/");
    expect(terraformFoundation).not.toContain('data "google_project" "current"');
    expect(terraformFoundationVariables).toContain('variable "project_number"');
    expect(terraformMain).toContain('worker_tasks_service_url = coalesce(var.worker_tasks_service_url_override, "https://example.invalid")');
    expect(terraformMain).toContain('resource_name_prefix         = "${local.service_name}-${var.environment}"');
    expect(terraformMain).toContain('app_base_url            = coalesce(var.app_base_url_override, "https://example.invalid")');
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
    // The conversation retention sweep is a built-in periodic task, pushed by its registration id.
    expect(schedulerTf).toContain('resource "google_cloud_scheduler_job" "conversation_retention"');
    expect(schedulerTf).toContain("schedule         = local.conversation_retention_schedule");
    expect(schedulerTf).toContain("/internal/tasks/periodic-tasks/conversation-retention/run");
    // So is the voice recording erasure recovery sweep, which restarts erasures no job is working on.
    expect(schedulerTf).toContain('resource "google_cloud_scheduler_job" "voice_recording_erasure_recovery"');
    expect(schedulerTf).toContain("schedule         = local.voice_recording_erasure_recovery_schedule");
    expect(schedulerTf).toContain("/internal/tasks/periodic-tasks/voice-recording-erasure-recovery/run");
    // How long deleted conversation data survives in backups and logs is what the data retention
    // docs state, so the windows are pinned rather than left to provider defaults. Turning
    // point-in-time recovery on restarts the instance, so it stays a per-stack choice defaulting to
    // off, and its 7-day log window applies only where it is on.
    expect(databaseTf).toMatch(/backup_configuration \{[\s\S]*?point_in_time_recovery_enabled = var\.db_point_in_time_recovery_enabled[\s\S]*?transaction_log_retention_days = var\.db_point_in_time_recovery_enabled \? 7 : null[\s\S]*?retained_backups = 7[\s\S]*?retention_unit\s+= "COUNT"/);
    expect(terraformVariables).toMatch(/variable "db_point_in_time_recovery_enabled" \{[\s\S]*?default\s+= false/);
    for (const env of [stagingEnv, liveEnv, liveEuEnv]) {
      expect(env).toMatch(/db_point_in_time_recovery_enabled = var\.db_point_in_time_recovery_enabled/);
    }
    expect(monitoringTf).toContain('"${local.resource_name_prefix}-conversation-retention",');
    expect(monitoringTf).toContain('"${local.resource_name_prefix}-voice-recording-erasure-recovery",');
    const loggingTf = await readFile(new URL("../../../infra/terraform/logging.tf", import.meta.url), "utf8");
    expect(loggingTf).toMatch(/resource "google_logging_project_bucket_config" "default" \{[\s\S]*?count = var\.manage_project_services \? 1 : 0[\s\S]*?bucket_id\s+= "_Default"[\s\S]*?retention_days = 30/);
    // An environment that keeps its logs in its own region holds them for the same 30 days.
    const foundationLoggingTf = await readFile(new URL("../../../infra/terraform/foundation/logging.tf", import.meta.url), "utf8");
    expect(foundationLoggingTf).toMatch(/resource "google_logging_project_bucket_config" "regional" \{[\s\S]*?location\s+= var\.region[\s\S]*?retention_days = 30/);
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
    expect(terraformWorkflow).toContain("MAIL_DRIVER: ${{ vars.MAIL_DRIVER }}");
    expect(terraformWorkflow).toContain('echo "TF_VAR_mail_driver=${MAIL_DRIVER}" >> "$GITHUB_ENV"');
    expect(terraformWorkflow).toContain("LETTERMINT_PROJECT_TOKEN: ${{ secrets.LETTERMINT_PROJECT_TOKEN }}");
    expect(terraformWorkflow).toContain("LETTERMINT_TEAM_TOKEN: ${{ secrets.LETTERMINT_TEAM_TOKEN }}");
    expect(terraformWorkflow).toContain("LETTERMINT_PROJECT_ID: ${{ vars.LETTERMINT_PROJECT_ID }}");
    expect(terraformWorkflow).toMatch(
      /if \[ "\$\{EMAIL_CHANNEL_PROVIDER\/\/\[\[:space:\]\]\/\}" = "lettermint" \]; then[\s\S]*?LETTERMINT_PROJECT_TOKEN LETTERMINT_TEAM_TOKEN LETTERMINT_PROJECT_ID/,
    );
    expect(terraformWorkflow).toContain('mail_key=LETTERMINT_PROJECT_TOKEN');
    expect(terraformWorkflow).toContain('mail_key=TF_VAR_resend_mail_api_key');
    expect(terraformWorkflow).toContain('if [ "${mail_driver:-resend}" != "$channel_provider" ]; then');
    expect(terraformWorkflow).toContain("APP_BASE_URL: ${{ vars.APP_BASE_URL }}");
    expect(terraformWorkflow).toContain("PUBLIC_CHAT_BASE_URL: ${{ vars.PUBLIC_CHAT_BASE_URL }}");
    expect(terraformWorkflow).toContain('APP_BASE_URL_OVERRIDE="${APP_BASE_URL:-$FRONTEND_URL}"');
    expect(terraformWorkflow).toContain('PUBLIC_CHAT_BASE_URL_OVERRIDE="${PUBLIC_CHAT_BASE_URL:-${APP_BASE_URL_OVERRIDE%/}/chat}"');
    expect(terraformWorkflow).toContain("TF_VAR_mail_from_email: ${{ vars.MAIL_FROM_EMAIL }}");
    expect(terraformWorkflow).toContain("TF_VAR_mail_from_name");
    expect(terraformWorkflow).not.toContain("MAIL_SMTP");
    expect(terraformFoundation).toContain("assertion.ref == 'refs/heads/main'");
    expect(stagingEnv).toContain("mail_driver");
    expect(stagingEnv).toContain("resend_mail_api_key");
    expect(stagingEnv).toContain("lettermint_project_token");
    expect(stagingEnv).toContain("lettermint_team_token");
    expect(stagingEnv).toContain("lettermint_project_id");
    expect(stagingEnv).toContain("mail_from_email");
    expect(stagingEnv).toContain("mail_from_name");
    expect(stagingEnv).toContain("document_worker_recovery_schedule");
    expect(stagingEnv).toContain("crawler_worker_recovery_schedule");
    expect(stagingEnvVariables).toContain('variable "document_worker_recovery_schedule"');
    expect(stagingEnvVariables).toContain('variable "crawler_worker_recovery_schedule"');
    expect(stagingEnvVariables).not.toContain('default     = "0 * * * *"');
    expect(stagingEnvVariables).not.toContain('default     = "0 3 * * *"');
    expect(liveEnv).toContain("mail_driver");
    expect(liveEnv).toContain("resend_mail_api_key");
    expect(liveEnv).toContain("lettermint_project_token");
    expect(liveEnv).toContain("lettermint_team_token");
    expect(liveEnv).toContain("lettermint_project_id");
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
    const liveEuFoundation = await readFile(new URL("../../../infra/terraform/foundation/environments/live-eu/main.tf", import.meta.url), "utf8");

    expect(terraformVariables).toContain('contains(["staging", "live", "live-eu"], var.environment)');
    expect(terraformVariables).toContain('variable "manage_project_services"');
    expect(terraformVariables).toContain('variable "secret_replication_locations"');
    expect(terraformApis).toContain("var.manage_project_services ? toset(local.required_apis) : toset([])");
    expect(terraformSecrets).toContain('for_each = length(var.secret_replication_locations) == 0 ? [true] : []');
    expect(terraformSecrets).toContain("for_each = var.secret_replication_locations");

    expect(liveEuEnv).toContain("manage_project_services = false");
    expect(liveEuEnv).toMatch(/secret_replication_locations\s+= \[var\.region\]/);
    expect(liveEuEnv).not.toMatch(/^module "foundation"/m);
    expect(liveEuFoundation).toMatch(/pool_id\s+= "github-actions-live-eu"/);
    expect(liveEuFoundation).toMatch(/github_actions_workload_identity_pool_id\s+= local\.pool_id/);
    expect(liveEuFoundation).toMatch(/github_actions_workload_identity_provider_id\s+= local\.pool_id/);
    expect(liveEuFoundation).toContain("manage_project_services = false");
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

  describe("email channel", () => {
    const emailChannelOf = (source: NodeJS.ProcessEnv) => parseEmailChannelConfig(getEnv(source));
    const localChannelEnv = {
      ...baseEnv,
      EMAIL_CHANNEL_PROVIDER: "local",
      EMAIL_CHANNEL_INBOUND_DOMAIN: "in.localhost.test",
      EMAIL_CHANNEL_WEBHOOK_SECRET: "whsec_bG9jYWwtZGV2LXNlY3JldC0wMDAwMDAwMDAwMDA=",
    } as const;

    it("leaves the channel unconfigured when EMAIL_CHANNEL_PROVIDER is unset or blank", () => {
      expect(emailChannelOf({ ...baseEnv })).toBeUndefined();

      // Secrets provisioned ahead of the provider do not switch the channel on.
      const blankProvider = emailChannelOf({
        ...baseEnv,
        EMAIL_CHANNEL_PROVIDER: "",
        EMAIL_CHANNEL_INBOUND_DOMAIN: "in.localhost.test",
        EMAIL_CHANNEL_WEBHOOK_SECRET: "whsec_c2VjcmV0",
        EMAIL_CHANNEL_WORKERS_ENABLED: "true",
        RESEND_CHANNEL_API_KEY: "re_test",
      });
      expect(blankProvider).toBeUndefined();
    });

    it("keeps the channel off and names the gap when the resend provider has no key", () => {
      const noKey = { ...localChannelEnv, EMAIL_CHANNEL_PROVIDER: "resend" } as const;
      expect(() => getEnv(noKey)).not.toThrow();
      expect(emailChannelOf(noKey)).toBeUndefined();
      expect(emailChannelConfigGaps(getEnv(noKey))).toEqual({
        provider: "resend",
        unmet: ["RESEND_CHANNEL_API_KEY or RESEND_MAIL_API_KEY"],
      });

      const blankKeys = { ...noKey, RESEND_CHANNEL_API_KEY: "", RESEND_MAIL_API_KEY: "" } as const;
      expect(emailChannelOf(blankKeys)).toBeUndefined();
      expect(emailChannelConfigGaps(getEnv(blankKeys))?.unmet).toEqual(["RESEND_CHANNEL_API_KEY or RESEND_MAIL_API_KEY"]);

      const env = emailChannelOf({
        ...localChannelEnv,
        EMAIL_CHANNEL_PROVIDER: "resend",
        RESEND_CHANNEL_API_KEY: "re_test",
        RESEND_CHANNEL_REGION: "eu-west-1",
      });
      expect(env?.provider).toEqual({ kind: "resend", apiKey: "re_test", region: "eu-west-1" });
    });

    it("keeps the channel off and names each missing lettermint setting, in order", () => {
      const noTokens = { ...localChannelEnv, EMAIL_CHANNEL_PROVIDER: "lettermint" } as const;
      expect(() => getEnv(noTokens)).not.toThrow();
      expect(emailChannelOf(noTokens)).toBeUndefined();
      expect(emailChannelConfigGaps(getEnv(noTokens))).toEqual({
        provider: "lettermint",
        unmet: ["LETTERMINT_PROJECT_TOKEN", "LETTERMINT_TEAM_TOKEN", "LETTERMINT_PROJECT_ID"],
      });

      const partial = { ...noTokens, LETTERMINT_PROJECT_TOKEN: "lm_test" } as const;
      expect(emailChannelOf(partial)).toBeUndefined();
      expect(emailChannelConfigGaps(getEnv(partial))?.unmet).toEqual([
        "LETTERMINT_TEAM_TOKEN",
        "LETTERMINT_PROJECT_ID",
      ]);

      const env = emailChannelOf({
        ...localChannelEnv,
        EMAIL_CHANNEL_PROVIDER: "lettermint",
        LETTERMINT_PROJECT_TOKEN: "lm_test",
        LETTERMINT_TEAM_TOKEN: "lm_team_test",
        LETTERMINT_PROJECT_ID: "proj_test",
      });
      expect(env?.provider).toEqual({
        kind: "lettermint",
        projectToken: "lm_test",
        teamToken: "lm_team_test",
        projectId: "proj_test",
      });
    });

    it("keeps the channel off while transactional mail resolves to the other provider, which shares its delivery webhook", () => {
      const lettermintChannel = {
        ...localChannelEnv,
        EMAIL_CHANNEL_PROVIDER: "lettermint",
        LETTERMINT_PROJECT_TOKEN: "lm_test",
        LETTERMINT_TEAM_TOKEN: "lm_team_test",
        LETTERMINT_PROJECT_ID: "proj_test",
      } as const;
      const withResendMail = { ...lettermintChannel, RESEND_MAIL_API_KEY: "re_mail" } as const;
      expect(() => getEnv(withResendMail)).not.toThrow();
      expect(emailChannelOf(withResendMail)).toBeUndefined();
      expect(emailChannelConfigGaps(getEnv(withResendMail))).toEqual({
        provider: "lettermint",
        unmet: ["MAIL_DRIVER must be lettermint: transactional mail and the channel share one delivery webhook"],
      });
      expect(emailChannelOf({ ...withResendMail, MAIL_DRIVER: "lettermint" })?.provider.kind).toBe("lettermint");
      expect(emailChannelOf({ ...lettermintChannel, MAIL_DRIVER: "log" })?.provider.kind).toBe("lettermint");

      const resendChannel = {
        ...localChannelEnv,
        EMAIL_CHANNEL_PROVIDER: "resend",
        RESEND_CHANNEL_API_KEY: "re_channel",
        MAIL_DRIVER: "lettermint",
        LETTERMINT_PROJECT_TOKEN: "lm_test",
      } as const;
      expect(emailChannelOf(resendChannel)).toBeUndefined();
      expect(emailChannelConfigGaps(getEnv(resendChannel))?.unmet).toEqual([
        "MAIL_DRIVER must be resend: transactional mail and the channel share one delivery webhook",
      ]);
    });

    it("uses transactional mail's Resend key when the channel has none of its own", () => {
      const shared = emailChannelOf({
        ...localChannelEnv,
        EMAIL_CHANNEL_PROVIDER: "resend",
        RESEND_MAIL_API_KEY: "re_mail",
      });
      expect(shared?.provider).toEqual({ kind: "resend", apiKey: "re_mail", region: "us-east-1" });

      const own = emailChannelOf({
        ...localChannelEnv,
        EMAIL_CHANNEL_PROVIDER: "resend",
        RESEND_CHANNEL_API_KEY: "re_channel",
        RESEND_MAIL_API_KEY: "re_mail",
      });
      expect(own?.provider).toEqual({ kind: "resend", apiKey: "re_channel", region: "us-east-1" });
    });

    it("keeps the channel off and names every unmet setting once a provider is chosen", () => {
      const noDomain = { ...localChannelEnv, EMAIL_CHANNEL_INBOUND_DOMAIN: "" } as const;
      expect(() => getEnv(noDomain)).not.toThrow();
      expect(emailChannelOf(noDomain)).toBeUndefined();
      expect(emailChannelConfigGaps(getEnv(noDomain))).toEqual({ provider: "local", unmet: ["EMAIL_CHANNEL_INBOUND_DOMAIN"] });

      const noSecret = { ...localChannelEnv, EMAIL_CHANNEL_WEBHOOK_SECRET: "" } as const;
      expect(emailChannelOf(noSecret)).toBeUndefined();
      expect(emailChannelConfigGaps(getEnv(noSecret))?.unmet).toEqual(["EMAIL_CHANNEL_WEBHOOK_SECRET"]);

      const badDomain = { ...localChannelEnv, EMAIL_CHANNEL_INBOUND_DOMAIN: "not a domain" } as const;
      expect(() => getEnv(badDomain)).not.toThrow();
      expect(emailChannelOf(badDomain)).toBeUndefined();
      expect(emailChannelConfigGaps(getEnv(badDomain))?.unmet).toEqual(["EMAIL_CHANNEL_INBOUND_DOMAIN must be a DNS hostname"]);

      const nothing = { ...baseEnv, EMAIL_CHANNEL_PROVIDER: "resend" } as const;
      expect(emailChannelConfigGaps(getEnv(nothing))?.unmet).toEqual([
        "RESEND_CHANNEL_API_KEY or RESEND_MAIL_API_KEY",
        "EMAIL_CHANNEL_INBOUND_DOMAIN",
        "EMAIL_CHANNEL_WEBHOOK_SECRET",
      ]);

      const nothingLettermint = { ...baseEnv, EMAIL_CHANNEL_PROVIDER: "lettermint" } as const;
      expect(emailChannelConfigGaps(getEnv(nothingLettermint))?.unmet).toEqual([
        "LETTERMINT_PROJECT_TOKEN",
        "LETTERMINT_TEAM_TOKEN",
        "LETTERMINT_PROJECT_ID",
        "EMAIL_CHANNEL_INBOUND_DOMAIN",
        "EMAIL_CHANNEL_WEBHOOK_SECRET",
      ]);
    });

    it("reports no gap when the provider is unset or the channel is complete", () => {
      expect(emailChannelConfigGaps(getEnv({ ...baseEnv }))).toBeNull();
      expect(emailChannelConfigGaps(getEnv({ ...baseEnv, EMAIL_CHANNEL_PROVIDER: "" }))).toBeNull();
      expect(emailChannelConfigGaps(getEnv(localChannelEnv))).toBeNull();
    });

    it("lower-cases the inbound domain", () => {
      const env = emailChannelOf({
        ...localChannelEnv,
        EMAIL_CHANNEL_INBOUND_DOMAIN: "In.EU.Radioso.TEST",
      });

      expect(env?.inboundDomain).toBe("in.eu.radioso.test");
    });

    it("applies the documented defaults and ships workers disabled", () => {
      const env = emailChannelOf({ ...localChannelEnv });

      expect(env).toEqual({
        provider: { kind: "local" },
        inboundDomain: "in.localhost.test",
        webhookSecret: "whsec_bG9jYWwtZGV2LXNlY3JldC0wMDAwMDAwMDAwMDA=",
        previousWebhookSecret: undefined,
        workersEnabled: false,
        taskQueueName: undefined,
      });

      const resend = emailChannelOf({
        ...localChannelEnv,
        EMAIL_CHANNEL_PROVIDER: "resend",
        RESEND_CHANNEL_API_KEY: "re_test",
      });
      expect(resend?.provider).toEqual({ kind: "resend", apiKey: "re_test", region: "us-east-1" });
    });

    it("accepts explicit channel settings", () => {
      const env = emailChannelOf({
        ...localChannelEnv,
        EMAIL_CHANNEL_WEBHOOK_SECRET_PREVIOUS: "whsec_cHJldmlvdXM=",
        EMAIL_CHANNEL_WORKERS_ENABLED: "true",
        EMAIL_CHANNEL_TASK_QUEUE_NAME: "email-channel",
      });

      expect(env).toEqual({
        provider: { kind: "local" },
        inboundDomain: "in.localhost.test",
        webhookSecret: "whsec_bG9jYWwtZGV2LXNlY3JldC0wMDAwMDAwMDAwMDA=",
        previousWebhookSecret: "whsec_cHJldmlvdXM=",
        workersEnabled: true,
        taskQueueName: "email-channel",
      });
    });

    it("documents the channel settings in the example environment", async () => {
      const example = await readFile(new URL("../../../.env.example", import.meta.url), "utf8");

      for (const setting of [
        "EMAIL_CHANNEL_PROVIDER",
        "EMAIL_CHANNEL_INBOUND_DOMAIN",
        "EMAIL_CHANNEL_WEBHOOK_SECRET",
        "EMAIL_CHANNEL_WEBHOOK_SECRET_PREVIOUS",
        "EMAIL_CHANNEL_WORKERS_ENABLED",
        "EMAIL_CHANNEL_TASK_QUEUE_NAME",
        "RESEND_CHANNEL_API_KEY",
        "RESEND_CHANNEL_REGION",
        "LETTERMINT_TEAM_TOKEN",
        "LETTERMINT_PROJECT_ID",
      ]) {
        expect(example).toMatch(new RegExp(`^${setting}=`, "m"));
      }
    });
  });
});
