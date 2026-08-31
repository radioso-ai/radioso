import { z } from "zod";

import {
  DEFAULT_ALLOWED_READ_TOOLS,
  DEFAULT_ALLOWED_WRITE_TOOLS,
  DEFAULT_APPROVAL_REQUIRED_WRITE_TOOLS,
} from "./policy/capabilityPolicy.js";

const toolListSchema = z
  .string()
  .trim()
  .transform((value) =>
    value
      .split(",")
      .map((part) => part.trim())
      .filter((part) => part.length > 0),
  );

const configSchema = z.object({
  RADIOSO_BASE_URL: z
    .string()
    .trim()
    .url()
    .refine((value) => value.startsWith("http://") || value.startsWith("https://"), {
      message: "RADIOSO_BASE_URL must be an http or https URL.",
    }),
  RADIOSO_MCP_ACCESS_TOKEN_TTL_SECONDS: z.coerce.number().int().positive().optional(),
  RADIOSO_MCP_ALLOWED_READ_TOOLS: toolListSchema.optional(),
  RADIOSO_MCP_ALLOWED_WRITE_TOOLS: toolListSchema.optional(),
  RADIOSO_MCP_APPROVAL_REQUIRED_WRITE_TOOLS: toolListSchema.optional(),
  RADIOSO_MCP_AUDIT_LOG_PATH: z.string().trim().min(1).optional(),
  RADIOSO_MCP_BIND_HOST: z.string().trim().min(1).optional(),
  RADIOSO_MCP_BIND_PORT: z.coerce.number().int().min(1).max(65535).optional(),
  RADIOSO_MCP_REDIS_KEY_PREFIX: z.string().trim().min(1).optional(),
  RADIOSO_MCP_REDIS_URL: z.string().trim().url().optional(),
  RADIOSO_MCP_REQUEST_TIMEOUT_MS: z.coerce.number().int().positive().max(120_000).optional(),
  RADIOSO_MCP_SERVER_NAME: z.string().trim().min(1).optional(),
  RADIOSO_MCP_SIGNING_SECRET: z.string().trim().min(1).optional(),
  RADIOSO_MCP_WORKSPACE_POLICIES_PATH: z.string().trim().min(1).optional(),
});

export interface RadiosoMcpConfig {
  accessTokenTtlSeconds: number;
  allowedReadTools: string[];
  allowedWriteTools: string[];
  approvalRequiredWriteTools: string[];
  auditLogPath?: string;
  baseUrl: string;
  bindHost: string;
  bindPort: number;
  redisKeyPrefix: string;
  redisUrl?: string;
  requestTimeoutMs: number;
  serverName: string;
  signingSecret: string;
  workspacePoliciesPath?: string;
  apiToken?: string;
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
    accessTokenTtlSeconds: parsed.RADIOSO_MCP_ACCESS_TOKEN_TTL_SECONDS ?? 900,
    allowedReadTools: parsed.RADIOSO_MCP_ALLOWED_READ_TOOLS ?? DEFAULT_ALLOWED_READ_TOOLS,
    allowedWriteTools: parsed.RADIOSO_MCP_ALLOWED_WRITE_TOOLS ?? DEFAULT_ALLOWED_WRITE_TOOLS,
    approvalRequiredWriteTools:
      parsed.RADIOSO_MCP_APPROVAL_REQUIRED_WRITE_TOOLS ?? DEFAULT_APPROVAL_REQUIRED_WRITE_TOOLS,
    auditLogPath: parsed.RADIOSO_MCP_AUDIT_LOG_PATH,
    baseUrl: parsed.RADIOSO_BASE_URL.replace(/\/+$/, ""),
    bindHost: parsed.RADIOSO_MCP_BIND_HOST ?? "127.0.0.1",
    bindPort: parsed.RADIOSO_MCP_BIND_PORT ?? 8787,
    redisKeyPrefix: parsed.RADIOSO_MCP_REDIS_KEY_PREFIX ?? "radioso-mcp",
    redisUrl: parsed.RADIOSO_MCP_REDIS_URL,
    requestTimeoutMs: parsed.RADIOSO_MCP_REQUEST_TIMEOUT_MS ?? 30_000,
    serverName: parsed.RADIOSO_MCP_SERVER_NAME ?? "radioso-context",
    signingSecret,
    workspacePoliciesPath: parsed.RADIOSO_MCP_WORKSPACE_POLICIES_PATH,
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
