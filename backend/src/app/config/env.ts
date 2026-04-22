import { z } from "zod";
import { findInvalidConfiguredSinks, hasConfiguredSink } from "../../shared/observability/configuredSinks.js";

const emptyStringToUndefined = <T extends z.ZodTypeAny>(schema: T) =>
  z.preprocess((value) => (value === "" ? undefined : value), schema.optional());

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

const envSchema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  PORT: z.coerce.number().int().positive().default(8080),
  OBSERVABILITY_ENABLED: booleanish(true),
  OBSERVABILITY_SERVICE_NAME: z.string().min(1).default("radioso-api"),
  OBSERVABILITY_ENVIRONMENT: emptyStringToUndefined(z.string().min(1)),
  OBSERVABILITY_VERSION: emptyStringToUndefined(z.string().min(1)),
  METRICS_ENABLED: booleanish(false),
  METRICS_PATH: z.string().min(1).default("/metrics"),
  METRICS_AUTH_TOKEN: emptyStringToUndefined(z.string().min(16)),
  OTEL_ENABLED: booleanish(false),
  OTEL_EXPORTER_OTLP_ENDPOINT: emptyStringToUndefined(z.string().url()),
  PRODUCT_ANALYTICS_SINKS: z.string().min(1).default("audit"),
  INCIDENT_SINKS: z.string().min(1).default("audit"),
  POSTHOG_HOST: emptyStringToUndefined(z.string().url()),
  POSTHOG_API_KEY: emptyStringToUndefined(z.string().min(1)),
  SENTRY_DSN: emptyStringToUndefined(z.string().url()),
  GOOGLE_CLOUD_PROJECT: emptyStringToUndefined(z.string().min(1)),
  DATABASE_URL: z.string().min(1),
  DB_POOL_MAX: z.coerce.number().int().positive().default(10),
  DB_POOL_IDLE_TIMEOUT_MS: z.coerce.number().int().nonnegative().default(30_000),
  DB_POOL_CONNECTION_TIMEOUT_MS: z.coerce.number().int().positive().default(5_000),
  DB_STATEMENT_TIMEOUT_MS: z.coerce.number().int().positive().default(15_000),
  DB_QUERY_TIMEOUT_MS: z.coerce.number().int().positive().default(20_000),
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
  WEBSITE_EMBED_SECRET: emptyStringToUndefined(z.string().min(16)),
  SESSION_TTL_HOURS: z.coerce.number().int().positive().default(168),
  CONNECTOR_ENCRYPTION_KEY: emptyStringToUndefined(z.string().min(1)),
  CONNECTOR_PUBLIC_BASE_URL: emptyStringToUndefined(z.string().url()),
  AUTH_RATE_LIMIT_WINDOW_MS: z.coerce.number().int().positive().default(60_000),
  AUTH_RATE_LIMIT_MAX_ATTEMPTS: z.coerce.number().int().positive().default(10),
  UPLOAD_RATE_LIMIT_MAX_ATTEMPTS: z.coerce.number().int().positive().default(20),
  WORKSPACE_RATE_LIMIT_MAX_ATTEMPTS: z.coerce.number().int().positive().default(30),
  DOCUMENT_STORAGE_DRIVER: z.enum(["local", "gcs"]).default("local"),
  DOCUMENT_STORAGE_LOCAL_PATH: z.string().min(1).default("../.context/document-storage"),
  DOCUMENT_STORAGE_BUCKET: emptyStringToUndefined(z.string().min(1)),
  DOCUMENT_UPLOAD_MAX_BYTES: z.coerce.number().int().positive().default(10 * 1024 * 1024),
  WORKER_DISPATCH_DRIVER: z.enum(["noop", "cloud-tasks"]).default("noop"),
  WORKER_TASKS_QUEUE_LOCATION: emptyStringToUndefined(z.string().min(1)),
  WORKER_TASKS_QUEUE_NAME: emptyStringToUndefined(z.string().min(1)),
  WORKER_TASKS_SERVICE_URL: emptyStringToUndefined(z.string().url()),
  WORKER_TASKS_INVOKER_SERVICE_ACCOUNT: emptyStringToUndefined(z.string().email()),
  DOCUMENT_PROCESSING_JOB_LEASE_MS: z.coerce.number().int().positive().default(300_000),
  PUBLIC_CHAT_BASE_URL: emptyStringToUndefined(z.string().min(1)),
}).superRefine((value, ctx) => {
  const invalidAnalyticsSinks = findInvalidConfiguredSinks(value.PRODUCT_ANALYTICS_SINKS, ["audit", "posthog"]);
  if (invalidAnalyticsSinks.length > 0) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["PRODUCT_ANALYTICS_SINKS"],
      message: `Unsupported analytics sinks: ${invalidAnalyticsSinks.join(", ")}`,
    });
  }

  const invalidIncidentSinks = findInvalidConfiguredSinks(value.INCIDENT_SINKS, ["audit", "sentry"]);
  if (invalidIncidentSinks.length > 0) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["INCIDENT_SINKS"],
      message: `Unsupported incident sinks: ${invalidIncidentSinks.join(", ")}`,
    });
  }

  if (hasConfiguredSink(value.PRODUCT_ANALYTICS_SINKS, "posthog")) {
    if (!value.POSTHOG_HOST) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["POSTHOG_HOST"],
        message: "POSTHOG_HOST is required when PRODUCT_ANALYTICS_SINKS includes posthog",
      });
    }
    if (!value.POSTHOG_API_KEY) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["POSTHOG_API_KEY"],
        message: "POSTHOG_API_KEY is required when PRODUCT_ANALYTICS_SINKS includes posthog",
      });
    }
  }

  if (hasConfiguredSink(value.INCIDENT_SINKS, "sentry") && !value.SENTRY_DSN) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["SENTRY_DSN"],
      message: "SENTRY_DSN is required when INCIDENT_SINKS includes sentry",
    });
  }

  if (value.METRICS_ENABLED && !value.METRICS_AUTH_TOKEN) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["METRICS_AUTH_TOKEN"],
      message: "METRICS_AUTH_TOKEN is required when METRICS_ENABLED is true",
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
});

type ParsedEnv = z.infer<typeof envSchema>;

export type Env = Omit<ParsedEnv, "OBSERVABILITY_ENVIRONMENT"> & {
  OBSERVABILITY_ENVIRONMENT: string;
};

let cachedEnv: Env | null = null;

export const getEnv = (source: NodeJS.ProcessEnv = process.env): Env => {
  if (!cachedEnv || source !== process.env) {
    const parsed = envSchema.parse(source);
    cachedEnv = {
      ...parsed,
      OBSERVABILITY_ENVIRONMENT: parsed.OBSERVABILITY_ENVIRONMENT ?? parsed.NODE_ENV,
    };
  }

  return cachedEnv;
};
