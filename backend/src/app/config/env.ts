import { z } from "zod";

const emptyStringToUndefined = <T extends z.ZodTypeAny>(schema: T) =>
  z.preprocess((value) => (value === "" ? undefined : value), schema.optional());

const envSchema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  PORT: z.coerce.number().int().positive().default(8080),
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
  APP_BASE_URL: z.string().url().default("http://localhost:3000"),
  PASSWORD_RESET_TOKEN_TTL_MINUTES: z.coerce.number().int().positive().default(30),
  PASSWORD_RESET_RATE_LIMIT_MAX_ATTEMPTS: z.coerce.number().int().positive().default(5),
  MAIL_DRIVER: z.enum(["noop", "log", "smtp"]).default("log"),
  MAIL_FROM_EMAIL: z.string().email().default("noreply@example.com"),
  MAIL_FROM_NAME: z.string().min(1).default("Radioso"),
  MAIL_SMTP_HOST: emptyStringToUndefined(z.string().min(1)),
  MAIL_SMTP_PORT: z.coerce.number().int().positive().default(587),
  MAIL_SMTP_SECURE: z
    .union([z.boolean(), z.enum(["true", "false"])])
    .transform((value) => value === true || value === "true")
    .default(false),
  MAIL_SMTP_USERNAME: emptyStringToUndefined(z.string().min(1)),
  MAIL_SMTP_PASSWORD: emptyStringToUndefined(z.string().min(1)),
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

  if (value.MAIL_DRIVER === "smtp") {
    for (const [field, message] of [
      ["MAIL_SMTP_HOST", "MAIL_SMTP_HOST is required when MAIL_DRIVER is smtp"],
      ["MAIL_SMTP_USERNAME", "MAIL_SMTP_USERNAME is required when MAIL_DRIVER is smtp"],
      ["MAIL_SMTP_PASSWORD", "MAIL_SMTP_PASSWORD is required when MAIL_DRIVER is smtp"],
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

export type Env = z.infer<typeof envSchema>;

let cachedEnv: Env | null = null;

export const getEnv = (source: NodeJS.ProcessEnv = process.env): Env => {
  if (!cachedEnv || source !== process.env) {
    cachedEnv = envSchema.parse(source);
  }

  return cachedEnv;
};
