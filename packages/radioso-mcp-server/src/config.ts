import { z } from "zod";

const booleanish = z.preprocess((value) => {
  if (typeof value !== "string") return value;
  if (value.toLowerCase() === "true") return true;
  if (value.toLowerCase() === "false") return false;
  return value;
}, z.boolean());

const configSchema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
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
  RADIOSO_MCP_SIGNING_SECRET: z.string().trim().min(32).optional(),
  RADIOSO_TRUSTED_PROXY_HOPS: z.coerce.number().int().min(0).max(10).default(0),
  OPERATOR_MCP_ENABLED: booleanish.default(false),
  OPERATOR_MCP_RESOURCE_URL: z.string().trim().url().optional(),
  OPERATOR_MCP_ISSUER_URL: z.string().trim().url().optional(),
  OPERATOR_MCP_INTERNAL_SECRET: z.string().min(32).optional(),
  OPERATOR_MCP_CREDENTIAL_EPOCH: z.string().regex(/^[1-9]\d*$/u).optional(),
  OPERATOR_MCP_ROLLOUT_WORKSPACE_IDS: z.string().trim().optional(),
}).superRefine((value, context) => {
  if (!value.OPERATOR_MCP_ENABLED) return;
  for (const field of [
    "OPERATOR_MCP_RESOURCE_URL",
    "OPERATOR_MCP_ISSUER_URL",
    "OPERATOR_MCP_INTERNAL_SECRET",
    "OPERATOR_MCP_CREDENTIAL_EPOCH",
  ] as const) {
    if (value[field] === undefined) context.addIssue({
      code: z.ZodIssueCode.custom,
      message: `${field} must be set when OPERATOR_MCP_ENABLED is true.`,
      path: [field],
    });
  }
  if (value.OPERATOR_MCP_RESOURCE_URL) {
    const resource = new URL(value.OPERATOR_MCP_RESOURCE_URL);
    if (resource.pathname !== "/operator/mcp" || resource.search || resource.hash) context.addIssue({
      code: z.ZodIssueCode.custom,
      message: "OPERATOR_MCP_RESOURCE_URL must be the canonical /operator/mcp resource without query or fragment.",
      path: ["OPERATOR_MCP_RESOURCE_URL"],
    });
    if (resource.protocol !== "https:" && !(["development", "test"].includes(value.NODE_ENV) && resource.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]", "::1"].includes(resource.hostname))) context.addIssue({
      code: z.ZodIssueCode.custom,
      message: "OPERATOR_MCP_RESOURCE_URL must use HTTPS outside local development and loopback HTTP only in development.",
      path: ["OPERATOR_MCP_RESOURCE_URL"],
    });
  }
  if (value.OPERATOR_MCP_ISSUER_URL) {
    const issuer = new URL(value.OPERATOR_MCP_ISSUER_URL);
    if ((issuer.pathname !== "/" && issuer.pathname !== "") || issuer.search || issuer.hash) context.addIssue({
      code: z.ZodIssueCode.custom,
      message: "OPERATOR_MCP_ISSUER_URL must be an origin without path, query, or fragment.",
      path: ["OPERATOR_MCP_ISSUER_URL"],
    });
    if (issuer.protocol !== "https:" && !(["development", "test"].includes(value.NODE_ENV) && issuer.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]", "::1"].includes(issuer.hostname))) context.addIssue({
      code: z.ZodIssueCode.custom,
      message: "OPERATOR_MCP_ISSUER_URL must use HTTPS outside local development and loopback HTTP only in development.",
      path: ["OPERATOR_MCP_ISSUER_URL"],
    });
  }
  if (value.OPERATOR_MCP_ROLLOUT_WORKSPACE_IDS) {
    for (const candidate of value.OPERATOR_MCP_ROLLOUT_WORKSPACE_IDS.split(",").map((entry) => entry.trim()).filter(Boolean)) {
      if (!z.string().uuid().safeParse(candidate).success) context.addIssue({
        code: z.ZodIssueCode.custom,
        message: "OPERATOR_MCP_ROLLOUT_WORKSPACE_IDS must contain only comma-separated UUIDs.",
        path: ["OPERATOR_MCP_ROLLOUT_WORKSPACE_IDS"],
      });
    }
  }
});

export type OperatorMcpConfig =
  | { enabled: false }
  | {
      credentialEpoch: string;
      enabled: true;
      internalSecret: string;
      issuerUrl: string;
      resourceUrl: string;
      rolloutWorkspaceIds: string[];
    };

export interface RadiosoMcpConfig {
  auditLogPath?: string;
  baseUrl: string;
  bindHost: string;
  bindPort: number;
  redisKeyPrefix: string;
  redisUrl?: string;
  requestTimeoutMs: number;
  serverName: string;
  signingSecret?: string;
  /** Optional for callers constructing configs programmatically; loadConfig always materializes it. */
  operatorMcp?: OperatorMcpConfig;
  trustedProxyHops: number;
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

const buildConfig = (parsed: ParsedConfig): RadiosoMcpConfig => {
  const config: RadiosoMcpConfig = {
    auditLogPath: parsed.RADIOSO_MCP_AUDIT_LOG_PATH,
    baseUrl: parsed.RADIOSO_BASE_URL.replace(/\/+$/, ""),
    bindHost: parsed.RADIOSO_MCP_BIND_HOST ?? "127.0.0.1",
    bindPort: parsed.RADIOSO_MCP_BIND_PORT ?? 8787,
    redisKeyPrefix: parsed.RADIOSO_MCP_REDIS_KEY_PREFIX ?? "radioso-mcp",
    redisUrl: parsed.RADIOSO_MCP_REDIS_URL,
    requestTimeoutMs: parsed.RADIOSO_MCP_REQUEST_TIMEOUT_MS ?? 30_000,
    serverName: parsed.RADIOSO_MCP_SERVER_NAME ?? "radioso-context",
    signingSecret: parsed.RADIOSO_MCP_SIGNING_SECRET,
    operatorMcp: parsed.OPERATOR_MCP_ENABLED
      ? {
      credentialEpoch: parsed.OPERATOR_MCP_CREDENTIAL_EPOCH!,
          enabled: true,
          internalSecret: parsed.OPERATOR_MCP_INTERNAL_SECRET!,
          issuerUrl: parsed.OPERATOR_MCP_ISSUER_URL!.replace(/\/+$/, ""),
          resourceUrl: parsed.OPERATOR_MCP_RESOURCE_URL!.replace(/\/+$/, ""),
          rolloutWorkspaceIds: parsed.OPERATOR_MCP_ROLLOUT_WORKSPACE_IDS
            ? parsed.OPERATOR_MCP_ROLLOUT_WORKSPACE_IDS.split(",").map((value) => value.trim()).filter(Boolean)
            : [],
        }
      : { enabled: false },
    trustedProxyHops: parsed.RADIOSO_TRUSTED_PROXY_HOPS,
  };

  return config;
};

const parseConfig = (env: NodeJS.ProcessEnv | Record<string, string | undefined>): ParsedConfig =>
  configSchema.parse(normalizeEnv(env));

export const loadRemoteConfig = (
  env: NodeJS.ProcessEnv | Record<string, string | undefined>,
): RadiosoMcpConfig => {
  const parsed = parseConfig(env);

  if (parsed.RADIOSO_MCP_REDIS_URL && !parsed.RADIOSO_MCP_SIGNING_SECRET) {
    throw new Error("RADIOSO_MCP_SIGNING_SECRET must be set when RADIOSO_MCP_REDIS_URL is configured.");
  }

  return buildConfig(parsed);
};

export const loadConfig = loadRemoteConfig;
