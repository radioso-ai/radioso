import { z } from "zod";

const envSchema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  PORT: z.coerce.number().int().positive().default(8080),
  DATABASE_URL: z.string().min(1),
  DB_POOL_MAX: z.coerce.number().int().positive().default(10),
  DB_POOL_IDLE_TIMEOUT_MS: z.coerce.number().int().nonnegative().default(30_000),
  DB_POOL_CONNECTION_TIMEOUT_MS: z.coerce.number().int().positive().default(5_000),
  DB_STATEMENT_TIMEOUT_MS: z.coerce.number().int().positive().default(15_000),
  DB_QUERY_TIMEOUT_MS: z.coerce.number().int().positive().default(20_000),
  OPENAI_API_KEY: z.string().min(1).optional(),
  OPENAI_CHAT_MODEL: z.string().min(1).optional(),
  OPENAI_RERANK_MODEL: z.string().min(1).optional(),
  OPENAI_VECTOR_MODEL: z.string().min(1).optional(),
  OPENAI_COMPATIBLE_API_KEY: z.string().min(1).optional(),
  OPENAI_COMPATIBLE_BASE_URL: z.string().url().optional(),
  GEMINI_API_KEY: z.string().min(1).optional(),
  ANTHROPIC_API_KEY: z.string().min(1).optional(),
  LLM_PROVIDER: z.enum(["openai", "openai-compatible", "gemini", "claude"]).optional(),
  LLM_CHAT_PROVIDER: z.enum(["openai", "openai-compatible", "gemini", "claude"]).optional(),
  LLM_CHAT_MODEL: z.string().min(1).optional(),
  LLM_REWRITE_PROVIDER: z.enum(["openai", "openai-compatible", "gemini", "claude"]).optional(),
  LLM_REWRITE_MODEL: z.string().min(1).optional(),
  LLM_RERANK_PROVIDER: z.enum(["openai", "openai-compatible", "gemini", "claude"]).optional(),
  LLM_RERANK_MODEL: z.string().min(1).optional(),
  LLM_EMBEDDING_PROVIDER: z.enum(["openai", "openai-compatible", "gemini", "claude"]).optional(),
  LLM_EMBEDDING_MODEL: z.string().min(1).optional(),
  SESSION_COOKIE_NAME: z.string().min(1).default("radioso_session"),
  SESSION_COOKIE_SECRET: z.string().min(16),
  SESSION_TTL_HOURS: z.coerce.number().int().positive().default(168),
  CONNECTOR_ENCRYPTION_KEY: z.string().min(1).optional(),
  CONNECTOR_PUBLIC_BASE_URL: z.string().url().optional(),
  AUTH_RATE_LIMIT_WINDOW_MS: z.coerce.number().int().positive().default(60_000),
  AUTH_RATE_LIMIT_MAX_ATTEMPTS: z.coerce.number().int().positive().default(10),
  UPLOAD_RATE_LIMIT_MAX_ATTEMPTS: z.coerce.number().int().positive().default(20),
  WORKSPACE_RATE_LIMIT_MAX_ATTEMPTS: z.coerce.number().int().positive().default(30),
  DOCUMENT_STORAGE_BUCKET: z.string().min(1).optional(),
  DOCUMENT_UPLOAD_MAX_BYTES: z.coerce.number().int().positive().default(10 * 1024 * 1024),
  PUBLIC_CHAT_BASE_URL: z.string().min(1).optional(),
});

export type Env = z.infer<typeof envSchema>;

let cachedEnv: Env | null = null;

export const getEnv = (source: NodeJS.ProcessEnv = process.env): Env => {
  if (!cachedEnv || source !== process.env) {
    cachedEnv = envSchema.parse(source);
  }

  return cachedEnv;
};
