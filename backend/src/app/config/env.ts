import { z } from "zod";

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

const mcpToolList = emptyStringToUndefined(z.string().min(1));
const otelTraceSampler = emptyStringToUndefined(z.enum([
  "always_on",
  "always_off",
  "traceidratio",
  "parentbased_always_on",
  "parentbased_always_off",
  "parentbased_traceidratio",
]));

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
  PRODUCT_ANALYTICS_SINKS: z.string().min(1).default("audit"),
  ERROR_SINKS: z.string().min(1).default("audit"),
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
  PUBLIC_CHAT_SESSION_SECRET: emptyStringToUndefined(z.string().min(16)),
  RADIOSO_MCP_SIGNING_SECRET: emptyStringToUndefined(z.string().min(16)),
  SESSION_TTL_HOURS: z.coerce.number().int().positive().default(168),
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
  AUTH_RATE_LIMIT_WINDOW_MS: z.coerce.number().int().positive().default(60_000),
  AUTH_RATE_LIMIT_MAX_ATTEMPTS: z.coerce.number().int().positive().default(10),
  PASSWORD_RESET_TOKEN_TTL_MINUTES: z.coerce.number().int().positive().default(30),
  EMAIL_VERIFICATION_TOKEN_TTL_MINUTES: z.coerce.number().int().positive().default(30),
  UPLOAD_RATE_LIMIT_MAX_ATTEMPTS: z.coerce.number().int().positive().default(20),
  WORKSPACE_RATE_LIMIT_MAX_ATTEMPTS: z.coerce.number().int().positive().default(30),
  EXPENSIVE_AUTHENTICATED_RATE_LIMIT_WINDOW_MS: z.coerce.number().int().positive().default(60_000),
  EXPENSIVE_AUTHENTICATED_RATE_LIMIT_MAX_ATTEMPTS: z.coerce.number().int().positive().default(60),
  PUBLIC_CHAT_RATE_LIMIT_WINDOW_MS: z.coerce.number().int().positive().default(60_000),
  PUBLIC_CHAT_SESSION_RATE_LIMIT_MAX_ATTEMPTS: z.coerce.number().int().positive().default(10),
  PUBLIC_CHAT_GLOBAL_RATE_LIMIT_MAX_ATTEMPTS: z.coerce.number().int().positive().default(600),
  DOCUMENT_STORAGE_DRIVER: z.enum(["local", "gcs"]).default("local"),
  DOCUMENT_STORAGE_LOCAL_PATH: z.string().min(1).default("../.context/document-storage"),
  DOCUMENT_STORAGE_BUCKET: emptyStringToUndefined(z.string().min(1)),
  DOCUMENT_UPLOAD_MAX_BYTES: z.coerce.number().int().positive().default(10 * 1024 * 1024),
  WORKER_DISPATCH_DRIVER: z.enum(["noop", "cloud-tasks", "amqp"]).default("noop"),
  WORKER_TASKS_QUEUE_LOCATION: emptyStringToUndefined(z.string().min(1)),
  WORKER_TASKS_QUEUE_NAME: emptyStringToUndefined(z.string().min(1)),
  WORKER_TASKS_CRAWL_QUEUE_NAME: emptyStringToUndefined(z.string().min(1)),
  WORKER_TASKS_SERVICE_URL: emptyStringToUndefined(z.string().url()),
  WORKER_TASKS_CRAWL_SERVICE_URL: emptyStringToUndefined(z.string().url()),
  WORKER_TASKS_INVOKER_SERVICE_ACCOUNT: emptyStringToUndefined(z.string().email()),
  WORKER_AMQP_URL: emptyStringToUndefined(z.string().url()),
  WORKER_AMQP_QUEUE_NAME: emptyStringToUndefined(z.string().min(1)),
  WORKER_AMQP_CRAWL_QUEUE_NAME: emptyStringToUndefined(z.string().min(1)),
  WORKER_AMQP_DLQ_NAME: emptyStringToUndefined(z.string().min(1)),
  WORKER_AMQP_CRAWL_DLQ_NAME: emptyStringToUndefined(z.string().min(1)),
  WORKER_AMQP_PREFETCH: z.coerce.number().int().positive().default(1),
  DOCUMENT_PROCESSING_JOB_LEASE_MS: z.coerce.number().int().positive().default(300_000),
  WEBSITE_CRAWL_JOB_LEASE_MS: z.coerce.number().int().positive().default(900_000),
  WEBSITE_CRAWL_WORKER_POLL_INTERVAL_MS: z.coerce.number().int().positive().default(5_000),
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
  RADIOSO_BASE_URL: emptyStringToUndefined(z.string().url()),
  RADIOSO_MCP_ENABLED: booleanish(false),
  RADIOSO_MCP_STANDALONE: booleanish(false),
  RADIOSO_MCP_MOUNT_PATH: z.string().min(1).default("/mcp").refine((value) => value.startsWith("/"), {
    message: "RADIOSO_MCP_MOUNT_PATH must start with /",
  }),
  RADIOSO_MCP_MERGED_CORS_ORIGINS: z.string().min(1).default("*"),
  RADIOSO_MCP_ACCESS_TOKEN_TTL_SECONDS: z.coerce.number().int().positive().default(900),
  RADIOSO_MCP_ALLOWED_READ_TOOLS: mcpToolList,
  RADIOSO_MCP_ALLOWED_WRITE_TOOLS: mcpToolList,
  RADIOSO_MCP_APPROVAL_REQUIRED_WRITE_TOOLS: mcpToolList,
  RADIOSO_MCP_AUDIT_LOG_PATH: emptyStringToUndefined(z.string().min(1)),
  RADIOSO_MCP_BIND_HOST: z.string().min(1).default("127.0.0.1"),
  RADIOSO_MCP_BIND_PORT: z.coerce.number().int().min(1).max(65535).default(8787),
  RADIOSO_MCP_REDIS_KEY_PREFIX: z.string().min(1).default("radioso-mcp"),
  RADIOSO_MCP_REDIS_URL: emptyStringToUndefined(z.string().url()),
  RADIOSO_MCP_REQUEST_TIMEOUT_MS: z.coerce.number().int().positive().max(120_000).default(30_000),
  RADIOSO_MCP_SERVER_NAME: z.string().min(1).default("radioso-context"),
  RADIOSO_MCP_WORKSPACE_POLICIES_PATH: emptyStringToUndefined(z.string().min(1)),
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

  if (value.RADIOSO_MCP_ENABLED && !value.RADIOSO_MCP_STANDALONE && !value.RADIOSO_BASE_URL && !value.APP_BASE_URL) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["RADIOSO_BASE_URL"],
      message: "RADIOSO_BASE_URL or APP_BASE_URL is required when backend MCP is enabled",
    });
  }

  if (value.RADIOSO_MCP_ENABLED && !value.RADIOSO_MCP_STANDALONE && !value.RADIOSO_MCP_SIGNING_SECRET) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["RADIOSO_MCP_SIGNING_SECRET"],
      message: "RADIOSO_MCP_SIGNING_SECRET is required when backend MCP is enabled",
    });
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
