import { describe, expect, it } from "vitest";
import { parseRealtimeConfig } from "../../../src/modules/realtime/infrastructure/config.js";

const base = { REALTIME_MODE: "disabled" };

describe("realtime config", () => {
  it("supports disabled mode without broker credentials", () => {
    expect(parseRealtimeConfig(base).mode).toBe("disabled");
  });

  it("validates standalone and hosted cluster broker modes", () => {
    expect(parseRealtimeConfig({ ...base, REALTIME_MODE: "standalone", REALTIME_REDIS_URL: "redis://localhost:6379" }).mode).toBe("standalone");
    expect(parseRealtimeConfig({ ...base, REALTIME_MODE: "redis-cluster", REALTIME_REDIS_SEEDS: "redis://one:6379,redis://two:6379", REALTIME_REDIS_TLS: "true", REALTIME_REDIS_IAM: "true" }).redis?.iam).toBe(true);
  });

  it("uses the complete bounded capacity defaults", () => {
    const config = parseRealtimeConfig(base);
    expect(config.producer).toMatchObject({ maxPendingWorkspaces: 4096, flushBatchSize: 256, publishConcurrency: 32, cadenceMs: 100 });
    expect(config.gateway).toMatchObject({
      maxConnections: 900, streamAgeMinMs: 720_000, streamAgeMaxMs: 840_000, dbPoolMax: 1,
      authTimeoutMs: 2_000, subscribeTimeoutMs: 3_000, edgeTimeoutMs: 1_200_000,
      transportLossGraceMs: 20_000, blockedDurationMs: 10_000, blockedWritableBytes: 262_144,
      maxWorkspaceInterests: 900, interestReleaseGraceMs: 5_000, shutdownDrainMs: 8_000,
      dbApplicationName: "radioso-realtime",
    });
    expect(config.admission).toMatchObject({ accountLimit: 10_000, workspaceLimit: 5_000, principalLimit: 5, leaseTtlMs: 90_000, renewalMs: 30_000, safetyMs: 20_000, cleanupLimit: 128, renewalJitterPercent: 20, closeJitterMaxMs: 5_000 });
    expect(config.reconnect).toMatchObject({ principalPerMinute: 12, principalBurst: 4, workspacePerMinute: 2_000, workspaceBurst: 200, accountPerMinute: 5_000, accountBurst: 500 });
    expect(config.redis).toMatchObject({ queuedCommands: 4096, connectTimeoutMs: 2_000, commandTimeoutMs: 2_000 });
  });

  it("rejects unsafe relational and rollout combinations", () => {
    expect(() => parseRealtimeConfig({ ...base, REALTIME_MAX_CONNECTIONS: "1000" })).toThrow(/below platform/i);
    expect(() => parseRealtimeConfig({ ...base, REALTIME_STREAM_AGE_MAX_MS: "900000" })).toThrow(/15 minutes/i);
    expect(() => parseRealtimeConfig({ ...base, REALTIME_MODE: "standalone" })).toThrow(/REDIS_URL/i);
    expect(() => parseRealtimeConfig({ ...base, REALTIME_ROLLOUT_MODE: "allowlist", REALTIME_ROLLOUT_ACCOUNT_IDS: "" })).toThrow(/allowlist/i);
    expect(() => parseRealtimeConfig({ ...base, REALTIME_REDIS_TLS: "definitely" })).toThrow();
    expect(() => parseRealtimeConfig({ ...base, REALTIME_MODE: "disabled", REALTIME_REDIS_TLS: "true" })).toThrow(/disabled/i);
    expect(() => parseRealtimeConfig({ ...base, REALTIME_MODE: "standalone", REALTIME_REDIS_URL: "redis://localhost", REALTIME_REDIS_IAM: "true" })).toThrow(/TLS/i);
    expect(() => parseRealtimeConfig({ ...base, REALTIME_MODE: "standalone", REALTIME_REDIS_URL: "redis://localhost", REALTIME_ROLLOUT_MODE: "allowlist", REALTIME_ROLLOUT_ACCOUNT_IDS: "not-a-uuid" })).toThrow(/UUID/i);
    expect(() => parseRealtimeConfig({ ...base, REALTIME_MODE: "disabled", REALTIME_ROLLOUT_MODE: "internal" })).toThrow(/rollout/i);
    expect(() => parseRealtimeConfig({ ...base, REALTIME_ADMISSION_RENEWAL_MS: "80000" })).toThrow(/renewal/i);
  });

  it("enforces jitter, rate, timeout, capacity, Redis, and bounded account rollout invariants", () => {
    expect(() => parseRealtimeConfig({ ...base, REALTIME_HEARTBEAT_MS: "60000" })).toThrow(/heartbeat/i);
    expect(() => parseRealtimeConfig({ ...base, REALTIME_SHUTDOWN_DRAIN_MS: "10000" })).toThrow(/shutdown/i);
    expect(() => parseRealtimeConfig({ ...base, REALTIME_ADMISSION_RENEWAL_MS: "60000" })).toThrow(/renewal/i);
    expect(() => parseRealtimeConfig({ ...base, REALTIME_ADMISSION_CLOSE_JITTER_MAX_MS: "20001" })).toThrow(/close jitter/i);
    expect(() => parseRealtimeConfig({ ...base, REALTIME_TRANSPORT_LOSS_GRACE_MS: "20001" })).toThrow(/transport loss/i);
    expect(() => parseRealtimeConfig({ ...base, REALTIME_ACCOUNT_CONNECTION_LIMIT: "10", REALTIME_WORKSPACE_CONNECTION_LIMIT: "11" })).toThrow(/ordered/i);
    expect(() => parseRealtimeConfig({ ...base, REALTIME_PRODUCER_FLUSH_BATCH_SIZE: "5000" })).toThrow(/producer capacity/i);
    expect(() => parseRealtimeConfig({ ...base, REALTIME_BLOCKED_WRITABLE_BYTES: String(8 * 1024) })).toThrow(/frame caps/i);
    expect(() => parseRealtimeConfig({ ...base, REALTIME_RECONNECT_PRINCIPAL_PER_MINUTE: "1", REALTIME_RECONNECT_PRINCIPAL_BURST: "2" })).toThrow(/burst/i);
    expect(() => parseRealtimeConfig({ ...base, REALTIME_MODE: "redis-cluster", REALTIME_REDIS_SEEDS: "," })).toThrow(/seeds|Redis/i);
    expect(() => parseRealtimeConfig({ ...base, REALTIME_MODE: "redis-cluster", REALTIME_REDIS_SEEDS: "redis://one:6379,http://two:6379" })).toThrow(/Redis URLs/i);
    expect(() => parseRealtimeConfig({ ...base, REALTIME_MODE: "standalone", REALTIME_REDIS_URL: "http://localhost" })).toThrow(/Redis URLs/i);
    expect(() => parseRealtimeConfig({ ...base, REALTIME_CHANNEL_PREFIX: "bad prefix" })).toThrow(/channel prefix/i);
    for (const internalUrl of [
      "file:///tmp/realtime",
      "https://user:secret@realtime.internal",
      "https://realtime.internal?target=other",
      "https://realtime.internal#fragment",
    ]) {
      expect(() => parseRealtimeConfig({ ...base, REALTIME_INTERNAL_URL: internalUrl })).toThrow(/HTTP\(S\)/i);
    }
    const config = parseRealtimeConfig({ ...base, REALTIME_MODE: "standalone", REALTIME_REDIS_URL: "redis://localhost", REALTIME_ROLLOUT_MODE: "allowlist", REALTIME_ROLLOUT_ACCOUNT_IDS: "4d7293c8-d241-4f8f-a4db-3df5b88da44c,4d7293c8-d241-4f8f-a4db-3df5b88da44c" });
    expect(config.rollout.accountIds).toEqual(["4d7293c8-d241-4f8f-a4db-3df5b88da44c"]);
    const oversizedAllowlist = Array.from({ length: 1025 }, (_, index) => `00000000-0000-4000-8000-${index.toString().padStart(12, "0")}`).join(",");
    expect(() => parseRealtimeConfig({ ...base, REALTIME_MODE: "standalone", REALTIME_REDIS_URL: "redis://localhost", REALTIME_ROLLOUT_MODE: "allowlist", REALTIME_ROLLOUT_ACCOUNT_IDS: oversizedAllowlist })).toThrow(/1024/i);
  });
});
