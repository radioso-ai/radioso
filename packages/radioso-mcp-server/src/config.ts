import { z } from "zod";

const configSchema = z.object({
  RADIOSO_BASE_URL: z
    .string()
    .trim()
    .url()
    .refine((value) => value.startsWith("http://") || value.startsWith("https://"), {
      message: "RADIOSO_BASE_URL must be an http or https URL.",
    }),
  RADIOSO_MCP_AUDIT_LOG_PATH: z.string().trim().min(1).optional(),
  RADIOSO_MCP_BIND_HOST: z.string().trim().min(1).optional(),
  RADIOSO_MCP_BIND_PORT: z.coerce.number().int().min(1).max(65535).optional(),
  RADIOSO_MCP_REDIS_KEY_PREFIX: z.string().trim().min(1).optional(),
  RADIOSO_MCP_REDIS_URL: z.string().trim().url().optional(),
  RADIOSO_MCP_REQUEST_TIMEOUT_MS: z.coerce.number().int().positive().max(120_000).optional(),
  RADIOSO_MCP_SERVER_NAME: z.string().trim().min(1).optional(),
  RADIOSO_MCP_SIGNING_SECRET: z.string().trim().min(1).optional(),
});

export interface RadiosoMcpConfig {
  auditLogPath?: string;
  baseUrl: string;
  bindHost: string;
  bindPort: number;
  redisKeyPrefix: string;
  redisUrl?: string;
  requestTimeoutMs: number;
  serverName: string;
  signingSecret: string;
}

const normalizeEnv = (
  env: NodeJS.ProcessEnv | Record<string, string | undefined>,
): Record<string, string | undefined> =>
  Object.fromEntries(
    Object.entries(env).map(([key, value]) => [
      key,
      typeof value === "string" && value.trim().length === 0 ? undefined : value,
    ]),
  );

type ParsedConfig = z.infer<typeof configSchema>;

const buildConfig = (parsed: ParsedConfig, signingSecret: string): RadiosoMcpConfig => {
  const config: RadiosoMcpConfig = {
    auditLogPath: parsed.RADIOSO_MCP_AUDIT_LOG_PATH,
    baseUrl: parsed.RADIOSO_BASE_URL.replace(/\/+$/, ""),
    bindHost: parsed.RADIOSO_MCP_BIND_HOST ?? "127.0.0.1",
    bindPort: parsed.RADIOSO_MCP_BIND_PORT ?? 8787,
    redisKeyPrefix: parsed.RADIOSO_MCP_REDIS_KEY_PREFIX ?? "radioso-mcp",
    redisUrl: parsed.RADIOSO_MCP_REDIS_URL,
    requestTimeoutMs: parsed.RADIOSO_MCP_REQUEST_TIMEOUT_MS ?? 30_000,
    serverName: parsed.RADIOSO_MCP_SERVER_NAME ?? "radioso-context",
    signingSecret,
  };

  return config;
};

const parseConfig = (env: NodeJS.ProcessEnv | Record<string, string | undefined>): ParsedConfig =>
  configSchema.parse(normalizeEnv(env));

export const loadRemoteConfig = (
  env: NodeJS.ProcessEnv | Record<string, string | undefined>,
): RadiosoMcpConfig => {
  const parsed = parseConfig(env);

  if (!parsed.RADIOSO_MCP_SIGNING_SECRET) {
    throw new Error("RADIOSO_MCP_SIGNING_SECRET must be set in remote mode.");
  }

  return buildConfig(parsed, parsed.RADIOSO_MCP_SIGNING_SECRET);
};

export const loadConfig = loadRemoteConfig;
