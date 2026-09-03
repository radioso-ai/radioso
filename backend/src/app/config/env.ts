import { z } from "zod";
import { isProductAnalyticsEventName } from "../../shared/analytics/productAnalyticsTypes.js";
import { hasConfiguredSink, parseConfiguredSinks } from "../../shared/observability/configuredSinks.js";
import { parseRealtimeConfig, realtimeEnvShape } from "../../modules/realtime/infrastructure/config.js";
import {
  COPILOT_CONVERSATION_RETENTION_DAYS_DEFAULT,
  COPILOT_PROBE_BUDGET_PER_TURN_DEFAULT,
} from "../../modules/operatorCopilot/public.js";

const emptyStringToUndefined = <T extends z.ZodTypeAny>(schema: T) =>
  z.preprocess((value) => (value === "" ? undefined : value), schema.optional());
const emptyStringToDefault = <T extends z.ZodTypeAny>(schema: T, defaultValue: z.input<T>) =>
  z.preprocess((value) => (value === "" ? undefined : value), schema.default(defaultValue));

const booleanish = (defaultValue: boolean) =>
  z.preprocess((value) => {
    if (value === undefined || value === null || value === "") {
      return defaultValue;
    }

    if (typeof value === "boolean") {
      return value;
    }

    if (typeof value === "string") {
      return value.toLowerCase() === "true";
    }

    return value;
  }, z.boolean());

const otelTraceSampler = emptyStringToUndefined(z.enum([
  "always_on",
  "always_off",
  "traceidratio",
  "parentbased_always_on",
  "parentbased_always_off",
  "parentbased_traceidratio",
]));
const otelLogsMinLevel = emptyStringToUndefined(z.enum(["trace", "debug", "info", "warn", "error", "fatal"]));
const httpWebhookUrl = z.string().url().refine((value) => {
  try {
    const protocol = new URL(value).protocol;
    return protocol === "http:" || protocol === "https:";
  } catch {
    return false;
  }
}, { message: "must be an HTTP(S) URL" });

const envSchema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  PORT: z.coerce.number().int().positive().default(8080),
  TRUST_PROXY_HOPS: z.coerce.number().int().nonnegative().default(0),
  OBSERVABILITY_ENABLED: booleanish(true),
  OBSERVABILITY_SERVICE_NAME: z.string().min(1).default("radioso-api"),
  OBSERVABILITY_ENVIRONMENT: emptyStringToUndefined(z.string().min(1)),
  OBSERVABILITY_VERSION: emptyStringToUndefined(z.string().min(1)),
  METRICS_ENABLED: booleanish(false),
  METRICS_PATH: z.string().min(1).default("/metrics"),
  METRICS_AUTH_TOKEN: emptyStringToUndefined(z.string().min(16)),
  OTEL_ENABLED: booleanish(false),
  OTEL_EXPORTER_OTLP_ENDPOINT: emptyStringToUndefined(z.string().url()),
  OTEL_TRACES_SAMPLER: otelTraceSampler,
  OTEL_TRACES_SAMPLER_ARG: emptyStringToUndefined(z.string().min(1)),
  OTEL_LOGS_ENABLED: booleanish(false),
  OTEL_EXPORTER_OTLP_LOGS_ENDPOINT: emptyStringToUndefined(z.string().url()),
  OTEL_EXPORTER_OTLP_LOGS_AUTH_BEARER: emptyStringToUndefined(z.string().min(1)),
  OTEL_LOGS_MIN_LEVEL: otelLogsMinLevel,
  PRODUCT_ANALYTICS_SINKS: z.string().min(1).default("audit"),
  ERROR_SINKS: z.string().min(1).default("audit"),
  OPS_EVENT_WEBHOOK_URL: emptyStringToUndefined(httpWebhookUrl),
  OPS_EVENT_WEBHOOK_SECRET: emptyStringToUndefined(z.string().min(16)),
  OPS_EVENT_WEBHOOK_EVENTS: emptyStringToUndefined(z.string().min(1)),
  OPS_EVENT_WEBHOOK_MIN_ERROR_SEVERITY: emptyStringToDefault(z.enum(["info", "warn", "error"]), "error"),
  OPS_EVENT_WEBHOOK_QUEUE_LIMIT: emptyStringToDefault(z.coerce.number().int().positive(), 500),
  RADIOSO_EDITION: z.enum(["oss", "enterprise"]).default("oss"),
  ...realtimeEnvShape,
  GOOGLE_CLOUD_PROJECT: emptyStringToUndefined(z.string().min(1)),
  RADIOSO_CDN_URL_MAP: emptyStringToUndefined(z.string().min(1)),
  DATABASE_URL: z.string().min(1),
  DB_POOL_MAX: z.coerce.number().int().positive().default(10),
  DB_POOL_IDLE_TIMEOUT_MS: z.coerce.number().int().nonnegative().default(30_000),
  DB_POOL_CONNECTION_TIMEOUT_MS: z.coerce.number().int().positive().default(5_000),
  DB_STATEMENT_TIMEOUT_MS: z.coerce.number().int().positive().default(15_000),
  DB_QUERY_TIMEOUT_MS: z.coerce.number().int().positive().default(20_000),
  DB_MIGRATION_LOCK_TIMEOUT_MS: z.coerce.number().int().positive().default(10_000),
  DB_MIGRATION_STATEMENT_TIMEOUT_MS: z.coerce.number().int().positive().default(25_000),
  OPENAI_API_KEY: emptyStringToUndefined(z.string().min(1)),
  OPENAI_CHAT_MODEL: emptyStringToUndefined(z.string().min(1)),
  OPENAI_RERANK_MODEL: emptyStringToUndefined(z.string().min(1)),
  OPENAI_VECTOR_MODEL: emptyStringToUndefined(z.string().min(1)),
  OPENAI_COMPATIBLE_API_KEY: emptyStringToUndefined(z.string().min(1)),
  OPENAI_COMPATIBLE_BASE_URL: emptyStringToUndefined(z.string().url()),
  GEMINI_API_KEY: emptyStringToUndefined(z.string().min(1)),
  ANTHROPIC_API_KEY: emptyStringToUndefined(z.string().min(1)),
  LLM_PROVIDER: emptyStringToUndefined(z.enum(["openai", "openai-compatible", "gemini", "claude"])),
  LLM_CHAT_PROVIDER: emptyStringToUndefined(z.enum(["openai", "openai-compatible", "gemini", "claude"])),
  LLM_CHAT_MODEL: emptyStringToUndefined(z.string().min(1)),
  LLM_REWRITE_PROVIDER: emptyStringToUndefined(z.enum(["openai", "openai-compatible", "gemini", "claude"])),
  LLM_REWRITE_MODEL: emptyStringToUndefined(z.string().min(1)),
  LLM_RERANK_PROVIDER: emptyStringToUndefined(z.enum(["openai", "openai-compatible", "gemini", "claude"])),
  LLM_RERANK_MODEL: emptyStringToUndefined(z.string().min(1)),
  LLM_EMBEDDING_PROVIDER: emptyStringToUndefined(z.enum(["openai", "openai-compatible", "gemini", "claude"])),
  LLM_EMBEDDING_MODEL: emptyStringToUndefined(z.string().min(1)),
  SESSION_COOKIE_NAME: z.string().min(1).default("radioso_session"),
  SESSION_COOKIE_SECRET: z.string().min(16),
  WORKSPACE_TOKEN_SECRET: emptyStringToUndefined(z.string().min(16)),
  WORKSPACE_TOKEN_SECRET_PREVIOUS: emptyStringToUndefined(z.string().min(16)),
  PUBLIC_CHAT_SESSION_SECRET: emptyStringToUndefined(z.string().min(16)),
  WEBSITE_EMBED_SECRET: emptyStringToUndefined(z.string().min(16)),
  SESSION_TTL_HOURS: z.coerce.number().int().positive().default(168),
  AUTH_AUTO_VERIFY_EMAIL: booleanish(false),
  CONNECTOR_ENCRYPTION_KEY: emptyStringToUndefined(
    z
      .string()
      .min(1)
      .refine(
        (value) => {
          try {
            return Buffer.from(value, "base64").length === 32;
          } catch {
            return false;
          }
        },
        {
          message:
            "CONNECTOR_ENCRYPTION_KEY must be base64 of 32 bytes (use `openssl rand -base64 32`). The same key encrypts connector secrets and workspace provider API keys at rest.",
        },
      ),
  ),
  CONNECTOR_PUBLIC_BASE_URL: emptyStringToUndefined(z.string().url()),
  WEBHOOK_DESTINATIONS_ALLOW_HTTP_LOOPBACK: booleanish(false),
  AUTH_RATE_LIMIT_WINDOW_MS: z.coerce.number().int().positive().default(60_000),
  AUTH_RATE_LIMIT_MAX_ATTEMPTS: z.coerce.number().int().positive().default(10),
  PASSWORD_RESET_TOKEN_TTL_MINUTES: z.coerce.number().int().positive().default(30),
  EMAIL_VERIFICATION_TOKEN_TTL_MINUTES: z.coerce.number().int().positive().default(30),
  UPLOAD_RATE_LIMIT_MAX_ATTEMPTS: z.coerce.number().int().positive().default(20),
  WORKSPACE_RATE_LIMIT_MAX_ATTEMPTS: z.coerce.number().int().positive().default(30),
  EXPENSIVE_AUTHENTICATED_RATE_LIMIT_WINDOW_MS: z.coerce.number().int().positive().default(60_000),
  EXPENSIVE_AUTHENTICATED_RATE_LIMIT_MAX_ATTEMPTS: z.coerce.number().int().positive().default(60),
  // Probe-shaped Ray tools spend real provider budget per call (a replayed agent turn, an eval
  // suite run). This bounds how many one turn may spend; the turn's own step budget bounds only
  // how many calls it makes, not what they cost.
  COPILOT_PROBE_BUDGET_PER_TURN: z.coerce.number().int().positive().default(COPILOT_PROBE_BUDGET_PER_TURN_DEFAULT),
  // Days a copilot conversation is kept after its last activity. 0 keeps them indefinitely.
  COPILOT_CONVERSATION_RETENTION_DAYS: z.coerce.number().int().nonnegative().default(COPILOT_CONVERSATION_RETENTION_DAYS_DEFAULT),
  PUBLIC_CHAT_RATE_LIMIT_WINDOW_MS: z.coerce.number().int().positive().default(60_000),
  PUBLIC_CHAT_SESSION_RATE_LIMIT_MAX_ATTEMPTS: z.coerce.number().int().positive().default(10),
  PUBLIC_CHAT_GLOBAL_RATE_LIMIT_MAX_ATTEMPTS: z.coerce.number().int().positive().default(600),
  // Agent-channel turns spend provider and retrieval budget. A single credential
  // cannot exhaust a workspace, and credential rotation cannot evade the shared cap.
  AGENT_CHANNEL_CHAT_RATE_LIMIT_WINDOW_MS: z.coerce.number().int().positive().default(60_000),
  AGENT_CHANNEL_CHAT_SOURCE_RATE_LIMIT_MAX_ATTEMPTS: z.coerce.number().int().positive().default(300),
  AGENT_CHANNEL_CHAT_GRANT_RATE_LIMIT_MAX_ATTEMPTS: z.coerce.number().int().positive().default(30),
  AGENT_CHANNEL_CHAT_WORKSPACE_RATE_LIMIT_MAX_ATTEMPTS: z.coerce.number().int().positive().default(300),
  // MCP session exchange is pre-authentication: source is the bounded gate and
  // a token hash prevents one valid credential from being replayed freely.
  MCP_CONVERSE_SESSION_RATE_LIMIT_WINDOW_MS: z.coerce.number().int().positive().default(60_000),
  MCP_CONVERSE_SESSION_SOURCE_RATE_LIMIT_MAX_ATTEMPTS: z.coerce.number().int().positive().default(60),
  MCP_CONVERSE_SESSION_TOKEN_RATE_LIMIT_MAX_ATTEMPTS: z.coerce.number().int().positive().default(10),
  RADIOSO_MCP_SIGNING_SECRET: emptyStringToUndefined(z.string().min(32)),
  RADIOSO_TRUSTED_PROXY_HOPS: z.coerce.number().int().min(0).max(10).default(0),
  DOCUMENT_STORAGE_DRIVER: z.enum(["local", "gcs"]).default("local"),
  DOCUMENT_STORAGE_LOCAL_PATH: z.string().min(1).default("../.context/document-storage"),
  DOCUMENT_STORAGE_BUCKET: emptyStringToUndefined(z.string().min(1)),
  DOCUMENT_UPLOAD_MAX_BYTES: z.coerce.number().int().positive().default(10 * 1024 * 1024),
  WORKER_DISPATCH_DRIVER: z.enum(["noop", "cloud-tasks", "amqp"]).default("noop"),
  WORKER_TASKS_QUEUE_LOCATION: emptyStringToUndefined(z.string().min(1)),
  WORKER_TASKS_QUEUE_NAME: emptyStringToUndefined(z.string().min(1)),
  WORKER_TASKS_CRAWL_QUEUE_NAME: emptyStringToUndefined(z.string().min(1)),
  // Deliberately independent of the WORKER_DISPATCH_DRIVER=cloud-tasks requiredness
  // check below: unlike document/crawl dispatch, action-outbox push is an optional
  // low-latency accelerant, not the only drain path (the interval-loop poller and the
  // recovery sweep both drain without it). Leaving this unset degrades to
  // NoopActionDrainDispatcher rather than failing startup, so the backend can deploy
  // ahead of the Terraform queue/scheduler that provisions it.
  ACTION_DISPATCH_TASK_QUEUE_NAME: emptyStringToUndefined(z.string().min(1)),
  WORKER_TASKS_SERVICE_URL: emptyStringToUndefined(z.string().url()),
  WORKER_TASKS_CRAWL_SERVICE_URL: emptyStringToUndefined(z.string().url()),
  WORKER_TASKS_INVOKER_SERVICE_ACCOUNT: emptyStringToUndefined(z.string().email()),
  WORKER_TASK_AUTH_TOKEN: emptyStringToUndefined(z.string().min(32)),
  WORKER_AMQP_URL: emptyStringToUndefined(z.string().url()),
  WORKER_AMQP_QUEUE_NAME: emptyStringToUndefined(z.string().min(1)),
  WORKER_AMQP_CRAWL_QUEUE_NAME: emptyStringToUndefined(z.string().min(1)),
  WORKER_AMQP_DLQ_NAME: emptyStringToUndefined(z.string().min(1)),
  WORKER_AMQP_CRAWL_DLQ_NAME: emptyStringToUndefined(z.string().min(1)),
  WORKER_AMQP_PREFETCH: z.coerce.number().int().positive().default(1),
  DOCUMENT_PROCESSING_JOB_LEASE_MS: z.coerce.number().int().positive().default(300_000),
  WEBSITE_CRAWL_JOB_LEASE_MS: z.coerce.number().int().positive().default(900_000),
  WEBSITE_CRAWL_WORKER_POLL_INTERVAL_MS: z.coerce.number().int().positive().default(5_000),
  // Per-message facet extraction is batch analytics drained by a polling claim loop:
  // nothing user-facing waits on it, so the poll interval can be generous.
  FACET_EXTRACTION_WORKER_POLL_INTERVAL_MS: z.coerce.number().int().positive().default(5_000),
  FACET_EXTRACTION_WORKER_BATCH_SIZE: z.coerce.number().int().positive().max(500).default(10),
  FACET_EXTRACTION_JOB_LEASE_MS: z.coerce.number().int().positive().default(300_000),
  WEBSITE_CRAWLER_ENABLED: booleanish(true),
  APP_BASE_URL: emptyStringToUndefined(z.string().url()),
  GOOGLE_MAIL_OAUTH_CLIENT_ID: emptyStringToUndefined(z.string().min(1)),
  GOOGLE_MAIL_OAUTH_CLIENT_SECRET: emptyStringToUndefined(z.string().min(1)),
  MICROSOFT_GRAPH_MAIL_OAUTH_CLIENT_ID: emptyStringToUndefined(z.string().min(1)),
  MICROSOFT_GRAPH_MAIL_OAUTH_CLIENT_SECRET: emptyStringToUndefined(z.string().min(1)),
  SLACK_OAUTH_CLIENT_ID: emptyStringToUndefined(z.string().min(1)),
  SLACK_OAUTH_CLIENT_SECRET: emptyStringToUndefined(z.string().min(1)),
  SLACK_SIGNING_SECRET: emptyStringToUndefined(z.string().min(1)),
  PUBLIC_CHAT_BASE_URL: emptyStringToUndefined(z.string().min(1)),
  RADIOSO_WIDGET_ORIGIN: emptyStringToUndefined(z.string().min(1)),
  RADIOSO_APPLICATION_MODULES: emptyStringToUndefined(z.string().min(1)),
}).superRefine((value, ctx) => {
  if (value.METRICS_ENABLED && !value.METRICS_AUTH_TOKEN) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["METRICS_AUTH_TOKEN"],
      message: "METRICS_AUTH_TOKEN is required when METRICS_ENABLED is true",
    });
  }

  if (value.OTEL_ENABLED && !value.OTEL_EXPORTER_OTLP_ENDPOINT) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["OTEL_EXPORTER_OTLP_ENDPOINT"],
      message: "OTEL_EXPORTER_OTLP_ENDPOINT is required when OTEL_ENABLED is true",
    });
  }

  if (value.OTEL_ENABLED) {
    const samplerNeedsRatio =
      value.OTEL_TRACES_SAMPLER === "traceidratio" ||
      value.OTEL_TRACES_SAMPLER === "parentbased_traceidratio";

    if (samplerNeedsRatio) {
      const ratio = Number(value.OTEL_TRACES_SAMPLER_ARG);
      if (!value.OTEL_TRACES_SAMPLER_ARG || !Number.isFinite(ratio) || ratio < 0 || ratio > 1) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["OTEL_TRACES_SAMPLER_ARG"],
          message: "OTEL_TRACES_SAMPLER_ARG must be a number from 0 to 1 for ratio samplers",
        });
      }
    } else if (value.OTEL_TRACES_SAMPLER_ARG) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["OTEL_TRACES_SAMPLER_ARG"],
        message: "OTEL_TRACES_SAMPLER_ARG is only supported with traceidratio samplers",
      });
    }
  }

  const opsWebhookConfigured =
    hasConfiguredSink(value.PRODUCT_ANALYTICS_SINKS, "ops_webhook") ||
    hasConfiguredSink(value.ERROR_SINKS, "ops_webhook");

  if (opsWebhookConfigured && !value.OPS_EVENT_WEBHOOK_URL) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["OPS_EVENT_WEBHOOK_URL"],
      message: "OPS_EVENT_WEBHOOK_URL is required when a sink list includes ops_webhook",
    });
  }

  if (opsWebhookConfigured && !value.OPS_EVENT_WEBHOOK_SECRET) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["OPS_EVENT_WEBHOOK_SECRET"],
      message: "OPS_EVENT_WEBHOOK_SECRET is required when a sink list includes ops_webhook",
    });
  }

  if (value.OPS_EVENT_WEBHOOK_EVENTS) {
    const unknownEvents = parseConfiguredSinks(value.OPS_EVENT_WEBHOOK_EVENTS)
      .filter((name) => !isProductAnalyticsEventName(name));
    if (unknownEvents.length > 0) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["OPS_EVENT_WEBHOOK_EVENTS"],
        message: `Unknown product analytics event names: ${unknownEvents.join(", ")}`,
      });
    }
  }

  if (value.OTEL_LOGS_ENABLED && !value.OTEL_EXPORTER_OTLP_LOGS_ENDPOINT) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["OTEL_EXPORTER_OTLP_LOGS_ENDPOINT"],
      message: "OTEL_EXPORTER_OTLP_LOGS_ENDPOINT is required when OTEL_LOGS_ENABLED is true",
    });
  }

  if (value.DOCUMENT_STORAGE_DRIVER === "gcs" && !value.DOCUMENT_STORAGE_BUCKET) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["DOCUMENT_STORAGE_BUCKET"],
      message: "DOCUMENT_STORAGE_BUCKET is required when DOCUMENT_STORAGE_DRIVER is gcs",
    });
  }

  if (value.WORKER_DISPATCH_DRIVER === "cloud-tasks") {
    for (const [field, message] of [
      ["WORKER_TASKS_QUEUE_LOCATION", "WORKER_TASKS_QUEUE_LOCATION is required when WORKER_DISPATCH_DRIVER is cloud-tasks"],
      ["GOOGLE_CLOUD_PROJECT", "GOOGLE_CLOUD_PROJECT is required when WORKER_DISPATCH_DRIVER is cloud-tasks"],
      ["WORKER_TASKS_QUEUE_NAME", "WORKER_TASKS_QUEUE_NAME is required when WORKER_DISPATCH_DRIVER is cloud-tasks"],
      ["WORKER_TASKS_SERVICE_URL", "WORKER_TASKS_SERVICE_URL is required when WORKER_DISPATCH_DRIVER is cloud-tasks"],
      [
        "WORKER_TASKS_INVOKER_SERVICE_ACCOUNT",
        "WORKER_TASKS_INVOKER_SERVICE_ACCOUNT is required when WORKER_DISPATCH_DRIVER is cloud-tasks",
      ],
      ["WORKER_TASK_AUTH_TOKEN", "WORKER_TASK_AUTH_TOKEN is required when WORKER_DISPATCH_DRIVER is cloud-tasks"],
    ] as const) {
      if (!value[field]) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: [field],
          message,
        });
      }
    }
  }

  if (value.WORKER_DISPATCH_DRIVER === "amqp") {
    for (const [field, message] of [
      ["WORKER_AMQP_URL", "WORKER_AMQP_URL is required when WORKER_DISPATCH_DRIVER is amqp"],
      ["WORKER_AMQP_QUEUE_NAME", "WORKER_AMQP_QUEUE_NAME is required when WORKER_DISPATCH_DRIVER is amqp"],
    ] as const) {
      if (!value[field]) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: [field],
          message,
        });
      }
    }
  }

  if (value.NODE_ENV === "production" && value.WEBHOOK_DESTINATIONS_ALLOW_HTTP_LOOPBACK) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["WEBHOOK_DESTINATIONS_ALLOW_HTTP_LOOPBACK"],
      message: "WEBHOOK_DESTINATIONS_ALLOW_HTTP_LOOPBACK cannot be enabled in production",
    });
  }

  if (value.NODE_ENV !== "development" && value.AUTH_AUTO_VERIFY_EMAIL) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["AUTH_AUTO_VERIFY_EMAIL"],
      message: "AUTH_AUTO_VERIFY_EMAIL can only be enabled when NODE_ENV is development",
    });
  }

});

type ParsedEnv = z.infer<typeof envSchema>;

type RealtimeEnvInputKey = Extract<keyof ParsedEnv, `REALTIME_${string}`>;

// Realtime is an opt-in runtime: existing API/worker test compositions may omit
// its inputs and the realtime parser supplies the disabled defaults.
export type Env = Omit<ParsedEnv, "OBSERVABILITY_ENVIRONMENT" | RealtimeEnvInputKey> & Partial<Pick<ParsedEnv, RealtimeEnvInputKey>> & {
  OBSERVABILITY_ENVIRONMENT: string;
};

let cachedEnv: Env | null = null;

export const getEnv = (source: NodeJS.ProcessEnv = process.env): Env => {
  if (!cachedEnv || source !== process.env) {
    const parsed = envSchema.parse(source);
    parseRealtimeConfig(parsed);
    cachedEnv = {
      ...parsed,
      OBSERVABILITY_ENVIRONMENT: parsed.OBSERVABILITY_ENVIRONMENT ?? parsed.NODE_ENV,
    };
  }

  return cachedEnv;
};
