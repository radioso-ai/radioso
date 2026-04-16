import { z } from "zod";

const emptyStringToUndefined = <T extends z.ZodTypeAny>(schema: T) =>
  z.preprocess((value) => (value === "" ? undefined : value), schema.optional());

const envSchema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  PORT: z.coerce.number().int().positive().default(8080),
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
  WORKSPACE_TOKEN_SECRET: z.string().min(16),
  WEBSITE_EMBED_SECRET: z.string().min(16),
  SESSION_TTL_HOURS: z.coerce.number().int().positive().default(168),
  CONNECTOR_ENCRYPTION_KEY: emptyStringToUndefined(z.string().min(1)),
  CONNECTOR_PUBLIC_BASE_URL: emptyStringToUndefined(z.string().url()),
  AUTH_RATE_LIMIT_WINDOW_MS: z.coerce.number().int().positive().default(60_000),
  AUTH_RATE_LIMIT_MAX_ATTEMPTS: z.coerce.number().int().positive().default(10),
  UPLOAD_RATE_LIMIT_MAX_ATTEMPTS: z.coerce.number().int().positive().default(20),
  WORKSPACE_RATE_LIMIT_MAX_ATTEMPTS: z.coerce.number().int().positive().default(30),
  DOCUMENT_STORAGE_BUCKET: emptyStringToUndefined(z.string().min(1)),
  DOCUMENT_UPLOAD_MAX_BYTES: z.coerce.number().int().positive().default(10 * 1024 * 1024),
  PUBLIC_CHAT_BASE_URL: emptyStringToUndefined(z.string().min(1)),
});

export type Env = z.infer<typeof envSchema>;

let cachedEnv: Env | null = null;

export const getEnv = (source: NodeJS.ProcessEnv = process.env): Env => {
  if (!cachedEnv || source !== process.env) {
    cachedEnv = envSchema.parse(source);
  }

  return cachedEnv;
};
