import { z } from "zod";
import { BROWSER_FRAME_MAX_BYTES, TRANSPORT_ENVELOPE_MAX_BYTES } from "@radioso/workspace-invalidation-contract";

const booleanish = z.preprocess((value) => {
  if (value === true || value === false) return value;
  if (value === "true") return true;
  if (value === "false") return false;
  return value;
}, z.boolean());
const integer = (defaultValue: number) => z.coerce.number().int().positive().default(defaultValue);
const optionalText = z.preprocess((value) => value === "" ? undefined : value, z.string().min(1).optional());

export const realtimeEnvShape = {
  REALTIME_MODE: z.enum(["disabled", "standalone", "redis-cluster"]).default("disabled"),
  REALTIME_PUBLIC_PATH: z.string().startsWith("/").default("/api/v1/events"),
  REALTIME_INTERNAL_URL: optionalText,
  REALTIME_REDIS_URL: optionalText,
  REALTIME_REDIS_SEEDS: optionalText,
  REALTIME_REDIS_TLS: booleanish.default(false),
  REALTIME_REDIS_IAM: booleanish.default(false),
  REALTIME_CHANNEL_PREFIX: z.string().min(1).default("radioso"),
  REALTIME_PRODUCER_MAX_PENDING_WORKSPACES: integer(4096),
  REALTIME_PRODUCER_FLUSH_BATCH_SIZE: integer(256),
  REALTIME_PRODUCER_PUBLISH_CONCURRENCY: integer(32),
  REALTIME_PRODUCER_CADENCE_MS: integer(100),
  REALTIME_PRODUCER_PUBLISH_TIMEOUT_MS: integer(2_000),
  REALTIME_MAX_CONNECTIONS: integer(900),
  REALTIME_PLATFORM_CONCURRENCY: integer(1000),
  REALTIME_STREAM_AGE_MIN_MS: integer(720_000),
  REALTIME_STREAM_AGE_MAX_MS: integer(840_000),
  REALTIME_GATEWAY_TIMEOUT_MS: integer(1_200_000),
  REALTIME_EDGE_TIMEOUT_MS: integer(1_200_000),
  REALTIME_HEARTBEAT_MS: integer(20_000),
  REALTIME_IDLE_TIMEOUT_MS: integer(60_000),
  REALTIME_AUTH_TIMEOUT_MS: integer(2_000),
  REALTIME_SUBSCRIBE_TIMEOUT_MS: integer(3_000),
  REALTIME_TRANSPORT_LOSS_GRACE_MS: integer(20_000),
  REALTIME_BLOCKED_DURATION_MS: integer(10_000),
  REALTIME_BLOCKED_WRITABLE_BYTES: integer(256 * 1024),
  REALTIME_MAX_WORKSPACE_INTERESTS: integer(900),
  REALTIME_INTEREST_RELEASE_GRACE_MS: integer(5_000),
  REALTIME_ACCOUNT_CONNECTION_LIMIT: integer(10_000),
  REALTIME_WORKSPACE_CONNECTION_LIMIT: integer(5_000),
  REALTIME_PRINCIPAL_CONNECTION_LIMIT: integer(5),
  REALTIME_ADMISSION_LEASE_TTL_MS: integer(90_000),
  REALTIME_ADMISSION_RENEWAL_MS: integer(30_000),
  REALTIME_ADMISSION_SAFETY_MS: integer(20_000),
  REALTIME_ADMISSION_CLEANUP_LIMIT: integer(128),
  REALTIME_ADMISSION_RENEWAL_JITTER_PERCENT: z.coerce.number().min(0).max(100).default(20),
  REALTIME_ADMISSION_CLOSE_JITTER_MAX_MS: z.coerce.number().int().nonnegative().default(5_000),
  REALTIME_RECONNECT_PRINCIPAL_PER_MINUTE: integer(12),
  REALTIME_RECONNECT_PRINCIPAL_BURST: integer(4),
  REALTIME_RECONNECT_WORKSPACE_PER_MINUTE: integer(2_000),
  REALTIME_RECONNECT_WORKSPACE_BURST: integer(200),
  REALTIME_RECONNECT_ACCOUNT_PER_MINUTE: integer(5_000),
  REALTIME_RECONNECT_ACCOUNT_BURST: integer(500),
  REALTIME_REDIS_QUEUED_COMMANDS: integer(4_096),
  REALTIME_REDIS_CONNECT_TIMEOUT_MS: integer(2_000),
  REALTIME_REDIS_COMMAND_TIMEOUT_MS: integer(2_000),
  REALTIME_SHUTDOWN_DRAIN_MS: integer(8_000),
  REALTIME_DB_POOL_MAX: integer(1),
  REALTIME_DB_ACQUIRE_TIMEOUT_MS: integer(2_000),
  REALTIME_DB_STATEMENT_TIMEOUT_MS: integer(2_000),
  REALTIME_DB_APPLICATION_NAME: z.string().min(1).max(63).default("radioso-realtime"),
  REALTIME_ROLLOUT_MODE: z.enum(["disabled", "internal", "allowlist", "default-on"]).default("disabled"),
  REALTIME_ROLLOUT_ACCOUNT_IDS: z.string().default(""),
} as const;

const rawRealtimeConfigSchema = z.object(realtimeEnvShape).superRefine((value, ctx) => {
  if (value.REALTIME_MODE === "standalone" && !value.REALTIME_REDIS_URL) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["REALTIME_REDIS_URL"], message: "REALTIME_REDIS_URL is required for standalone mode" });
  }
  if (value.REALTIME_INTERNAL_URL) {
    try {
      const internalUrl = new URL(value.REALTIME_INTERNAL_URL);
      if (
        !["http:", "https:"].includes(internalUrl.protocol)
        || internalUrl.username.length > 0
        || internalUrl.password.length > 0
        || internalUrl.search.length > 0
        || internalUrl.hash.length > 0
      ) {
        throw new Error("unsafe internal URL");
      }
    } catch {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["REALTIME_INTERNAL_URL"],
        message: "REALTIME_INTERNAL_URL must be an HTTP(S) URL without credentials, query, or fragment",
      });
    }
  }
  if (value.REALTIME_MODE === "redis-cluster" && !value.REALTIME_REDIS_SEEDS) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["REALTIME_REDIS_SEEDS"], message: "REALTIME_REDIS_SEEDS is required for redis-cluster mode" });
  }
  const validateRedisUrl = (rawUrl: string, path: "REALTIME_REDIS_URL" | "REALTIME_REDIS_SEEDS") => {
    try {
      const parsed = new URL(rawUrl);
      if (parsed.protocol !== "redis:" && parsed.protocol !== "rediss:") throw new Error("scheme");
    } catch {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: [path], message: "Redis URLs must use redis:// or rediss://" });
    }
  };
  if (value.REALTIME_REDIS_URL) validateRedisUrl(value.REALTIME_REDIS_URL, "REALTIME_REDIS_URL");
  for (const seed of value.REALTIME_REDIS_SEEDS?.split(",").map((item) => item.trim()).filter(Boolean) ?? []) {
    validateRedisUrl(seed, "REALTIME_REDIS_SEEDS");
  }
  if (value.REALTIME_MODE === "redis-cluster" && value.REALTIME_REDIS_SEEDS?.split(",").some((seed) => seed.trim() === "")) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["REALTIME_REDIS_SEEDS"], message: "Redis seeds cannot contain empty values" });
  if (value.REALTIME_MODE === "disabled" && (value.REALTIME_REDIS_TLS || value.REALTIME_REDIS_IAM)) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["REALTIME_MODE"], message: "Redis TLS/IAM cannot be configured while realtime is disabled" });
  }
  if (value.REALTIME_REDIS_IAM && (!value.REALTIME_REDIS_TLS || value.REALTIME_MODE !== "redis-cluster")) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["REALTIME_REDIS_TLS"], message: "REALTIME_REDIS_IAM requires redis-cluster mode and REALTIME_REDIS_TLS" });
  }
  if (value.REALTIME_MAX_CONNECTIONS >= value.REALTIME_PLATFORM_CONCURRENCY) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["REALTIME_MAX_CONNECTIONS"], message: "REALTIME_MAX_CONNECTIONS must remain below platform concurrency" });
  }
  if (value.REALTIME_STREAM_AGE_MAX_MS >= 15 * 60_000 || value.REALTIME_STREAM_AGE_MIN_MS > value.REALTIME_STREAM_AGE_MAX_MS) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["REALTIME_STREAM_AGE_MAX_MS"], message: "stream age must be ordered and strictly below 15 minutes" });
  }
  if (value.REALTIME_STREAM_AGE_MAX_MS >= Math.min(value.REALTIME_GATEWAY_TIMEOUT_MS, value.REALTIME_EDGE_TIMEOUT_MS) - 30_000) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["REALTIME_STREAM_AGE_MAX_MS"], message: "stream age must leave gateway and edge timeout margin" });
  }
  if (value.REALTIME_HEARTBEAT_MS >= value.REALTIME_IDLE_TIMEOUT_MS) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["REALTIME_HEARTBEAT_MS"], message: "heartbeat must be below idle timeout" });
  }
  if (value.REALTIME_DB_POOL_MAX > 2) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["REALTIME_DB_POOL_MAX"], message: "realtime DB pool is limited to 1-2 connections" });
  }
  if (value.REALTIME_ADMISSION_RENEWAL_MS * (1 + value.REALTIME_ADMISSION_RENEWAL_JITTER_PERCENT / 100) + value.REALTIME_ADMISSION_SAFETY_MS >= value.REALTIME_ADMISSION_LEASE_TTL_MS) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["REALTIME_ADMISSION_RENEWAL_MS"], message: "admission renewal plus safety must remain below lease TTL" });
  }
  if (value.REALTIME_ADMISSION_CLOSE_JITTER_MAX_MS > value.REALTIME_ADMISSION_SAFETY_MS) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["REALTIME_ADMISSION_CLOSE_JITTER_MAX_MS"],
      message: "admission close jitter cannot exceed the lease safety window",
    });
  }
  if (value.REALTIME_MAX_WORKSPACE_INTERESTS > value.REALTIME_MAX_CONNECTIONS) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["REALTIME_MAX_WORKSPACE_INTERESTS"], message: "workspace interests cannot exceed local connection cap" });
  }
  if (value.REALTIME_TRANSPORT_LOSS_GRACE_MS > value.REALTIME_ADMISSION_SAFETY_MS) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["REALTIME_TRANSPORT_LOSS_GRACE_MS"], message: "transport loss grace cannot exceed admission safety" });
  }
  if (value.REALTIME_SHUTDOWN_DRAIN_MS >= 10_000) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["REALTIME_SHUTDOWN_DRAIN_MS"], message: "shutdown drain must remain below the platform termination budget" });
  }
  if (value.REALTIME_PRINCIPAL_CONNECTION_LIMIT > value.REALTIME_WORKSPACE_CONNECTION_LIMIT || value.REALTIME_WORKSPACE_CONNECTION_LIMIT > value.REALTIME_ACCOUNT_CONNECTION_LIMIT) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["REALTIME_PRINCIPAL_CONNECTION_LIMIT"], message: "principal, workspace, account limits must be ordered" });
  if (value.REALTIME_PRODUCER_PUBLISH_CONCURRENCY > value.REALTIME_PRODUCER_FLUSH_BATCH_SIZE || value.REALTIME_PRODUCER_FLUSH_BATCH_SIZE > value.REALTIME_PRODUCER_MAX_PENDING_WORKSPACES) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["REALTIME_PRODUCER_PUBLISH_CONCURRENCY"], message: "producer capacity relationship is invalid" });
  if ([value.REALTIME_RECONNECT_PRINCIPAL_BURST, value.REALTIME_RECONNECT_WORKSPACE_BURST, value.REALTIME_RECONNECT_ACCOUNT_BURST].some((burst, index) => burst > [value.REALTIME_RECONNECT_PRINCIPAL_PER_MINUTE, value.REALTIME_RECONNECT_WORKSPACE_PER_MINUTE, value.REALTIME_RECONNECT_ACCOUNT_PER_MINUTE][index]!)) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["REALTIME_RECONNECT_PRINCIPAL_BURST"], message: "reconnect burst cannot exceed rate" });
  if (!/^[A-Za-z0-9:_-]{1,120}$/u.test(value.REALTIME_CHANNEL_PREFIX)) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["REALTIME_CHANNEL_PREFIX"], message: "channel prefix is invalid" });
  if (BROWSER_FRAME_MAX_BYTES >= value.REALTIME_BLOCKED_WRITABLE_BYTES || TRANSPORT_ENVELOPE_MAX_BYTES >= value.REALTIME_BLOCKED_WRITABLE_BYTES) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["REALTIME_BLOCKED_WRITABLE_BYTES"], message: "frame caps must fit below the writer budget" });
  if (value.REALTIME_ROLLOUT_MODE === "allowlist" && value.REALTIME_ROLLOUT_ACCOUNT_IDS.trim() === "") {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["REALTIME_ROLLOUT_ACCOUNT_IDS"], message: "allowlist rollout requires account ids" });
  }
  if (value.REALTIME_MODE === "disabled" && value.REALTIME_ROLLOUT_MODE !== "disabled") {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["REALTIME_ROLLOUT_MODE"], message: "rollout must be disabled when realtime mode is disabled" });
  }
});

export type RealtimeConfig = ReturnType<typeof parseRealtimeConfig>;

export const parseRealtimeConfig = (source: Record<string, unknown>) => {
  const value = rawRealtimeConfigSchema.parse(source);
  const accountIds = [...new Set(value.REALTIME_ROLLOUT_ACCOUNT_IDS.split(",").map((id) => id.trim()).filter(Boolean))];
  if (accountIds.length > 1024) throw new Error("rollout account allowlist exceeds 1024 entries");
  for (const accountId of accountIds) z.string().uuid("rollout account ids must be UUIDs").parse(accountId);
  return {
    mode: value.REALTIME_MODE,
    publicPath: value.REALTIME_PUBLIC_PATH,
    internalUrl: value.REALTIME_INTERNAL_URL,
    redis: {
      url: value.REALTIME_REDIS_URL,
      seeds: value.REALTIME_REDIS_SEEDS?.split(",").map((seed) => seed.trim()).filter(Boolean) ?? [],
      tls: value.REALTIME_REDIS_TLS,
      iam: value.REALTIME_REDIS_IAM,
      channelPrefix: value.REALTIME_CHANNEL_PREFIX,
      queuedCommands: value.REALTIME_REDIS_QUEUED_COMMANDS,
      connectTimeoutMs: value.REALTIME_REDIS_CONNECT_TIMEOUT_MS,
      commandTimeoutMs: value.REALTIME_REDIS_COMMAND_TIMEOUT_MS,
    },
    producer: {
      maxPendingWorkspaces: value.REALTIME_PRODUCER_MAX_PENDING_WORKSPACES,
      flushBatchSize: value.REALTIME_PRODUCER_FLUSH_BATCH_SIZE,
      publishConcurrency: value.REALTIME_PRODUCER_PUBLISH_CONCURRENCY,
      cadenceMs: value.REALTIME_PRODUCER_CADENCE_MS,
      publishTimeoutMs: value.REALTIME_PRODUCER_PUBLISH_TIMEOUT_MS,
    },
    gateway: {
      maxConnections: value.REALTIME_MAX_CONNECTIONS,
      platformConcurrency: value.REALTIME_PLATFORM_CONCURRENCY,
      streamAgeMinMs: value.REALTIME_STREAM_AGE_MIN_MS,
      streamAgeMaxMs: value.REALTIME_STREAM_AGE_MAX_MS,
      timeoutMs: value.REALTIME_GATEWAY_TIMEOUT_MS,
      edgeTimeoutMs: value.REALTIME_EDGE_TIMEOUT_MS,
      heartbeatMs: value.REALTIME_HEARTBEAT_MS,
      idleTimeoutMs: value.REALTIME_IDLE_TIMEOUT_MS,
      authTimeoutMs: value.REALTIME_AUTH_TIMEOUT_MS,
      subscribeTimeoutMs: value.REALTIME_SUBSCRIBE_TIMEOUT_MS,
      transportLossGraceMs: value.REALTIME_TRANSPORT_LOSS_GRACE_MS,
      blockedDurationMs: value.REALTIME_BLOCKED_DURATION_MS,
      blockedWritableBytes: value.REALTIME_BLOCKED_WRITABLE_BYTES,
      maxWorkspaceInterests: value.REALTIME_MAX_WORKSPACE_INTERESTS,
      interestReleaseGraceMs: value.REALTIME_INTEREST_RELEASE_GRACE_MS,
      shutdownDrainMs: value.REALTIME_SHUTDOWN_DRAIN_MS,
      dbPoolMax: value.REALTIME_DB_POOL_MAX,
      dbAcquireTimeoutMs: value.REALTIME_DB_ACQUIRE_TIMEOUT_MS,
      dbStatementTimeoutMs: value.REALTIME_DB_STATEMENT_TIMEOUT_MS,
      dbApplicationName: value.REALTIME_DB_APPLICATION_NAME,
    },
    rollout: {
      mode: value.REALTIME_ROLLOUT_MODE,
      accountIds,
    },
    admission: {
      accountLimit: value.REALTIME_ACCOUNT_CONNECTION_LIMIT,
      workspaceLimit: value.REALTIME_WORKSPACE_CONNECTION_LIMIT,
      principalLimit: value.REALTIME_PRINCIPAL_CONNECTION_LIMIT,
      leaseTtlMs: value.REALTIME_ADMISSION_LEASE_TTL_MS,
      renewalMs: value.REALTIME_ADMISSION_RENEWAL_MS,
      safetyMs: value.REALTIME_ADMISSION_SAFETY_MS,
      cleanupLimit: value.REALTIME_ADMISSION_CLEANUP_LIMIT,
      renewalJitterPercent: value.REALTIME_ADMISSION_RENEWAL_JITTER_PERCENT,
      closeJitterMaxMs: value.REALTIME_ADMISSION_CLOSE_JITTER_MAX_MS,
    },
    reconnect: {
      principalPerMinute: value.REALTIME_RECONNECT_PRINCIPAL_PER_MINUTE,
      principalBurst: value.REALTIME_RECONNECT_PRINCIPAL_BURST,
      workspacePerMinute: value.REALTIME_RECONNECT_WORKSPACE_PER_MINUTE,
      workspaceBurst: value.REALTIME_RECONNECT_WORKSPACE_BURST,
      accountPerMinute: value.REALTIME_RECONNECT_ACCOUNT_PER_MINUTE,
      accountBurst: value.REALTIME_RECONNECT_ACCOUNT_BURST,
    },
  };
};
