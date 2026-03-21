import { z } from "zod";

const envSchema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  PORT: z.coerce.number().int().positive().default(8080),
  DATABASE_URL: z.string().min(1),
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
  SESSION_COOKIE_NAME: z.string().min(1).default("hivec_session"),
  SESSION_COOKIE_SECRET: z.string().min(16),
  SESSION_TTL_HOURS: z.coerce.number().int().positive().default(168),
  CONNECTOR_ENCRYPTION_KEY: z.string().min(1).optional(),
  CONNECTOR_PUBLIC_BASE_URL: z.string().url().optional(),
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
