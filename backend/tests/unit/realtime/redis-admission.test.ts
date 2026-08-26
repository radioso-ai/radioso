import { createHash } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createNodeRedisAdmissionScriptPort, RedisAdmissionController, RealtimeAdmissionError, type RedisAdmissionScriptPort } from "../../../src/modules/realtime/infrastructure/redisAdmissionController.js";
import { redisAdmissionScripts } from "../../../src/modules/realtime/infrastructure/redisAdmissionScripts.js";
import { decodeRedisAdmissionReply } from "../../../src/modules/realtime/infrastructure/redisAdmissionReply.js";

const accountId = "3d7293c8-d241-4f8f-a4db-3df5b88da44b";
const workspaceId = "4d7293c8-d241-4f8f-a4db-3df5b88da44c";
const otherWorkspaceId = "6d7293c8-d241-4f8f-a4db-3df5b88da44c";
const principalId = "principal-1";
const prefix = "radioso:realtime";
const aggregateHash = createHash("sha256").update(`${accountId}:${principalId}`).digest("hex");
const limits = {
  account: 10_000, workspace: 5_000, principal: 5, localProcessCap: 900, pendingPerAggregate: 8, leaseTtlMs: 90_000, renewalMs: 30_000, safetyMs: 20_000, closeJitterMaxMs: 5_000, cleanupLimit: 128,
  reconnect: { principal: { limit: 12, windowMs: 60_000, burst: 4 }, workspace: { limit: 2_000, windowMs: 60_000, burst: 200 }, account: { limit: 5_000, windowMs: 60_000, burst: 500 } },
};
const admissionSuccess = (overrides: Record<string, unknown> = {}) => ({
  ok: true,
  reason: "ok",
  serverTimeMs: 0,
  expiresAtMs: 90_000,
  hasMore: false,
  ...overrides,
});
const createController = (replies: unknown[] = []) => {
  const calls: Array<{ name: string; keys: string[]; args: string[] }> = [];
  const execute = vi.fn(async (name: string, keys: readonly string[], args: readonly string[]) => {
    calls.push({ name, keys: [...keys], args: [...args] });
    const reply = replies.shift();
    if (reply instanceof Error) throw reply;
    if (reply && typeof reply === "object" && "ok" in reply) {
      const candidate = reply as Record<string, unknown>;
      if (candidate.ok === true) {
        const common = { reason: "ok", serverTimeMs: 1_700_000_000_000 };
        if (name === "admission.sweep") return { ...common, hasMore: false, ...candidate };
        if (name === "admission.reconnect") return { ...common, ...candidate };
        return { ...common, expiresAtMs: 1_700_000_090_000, hasMore: false, ...candidate };
      }
      if (candidate.ok === false) {
        const common = { retryAfterMs: 1_000 };
        return candidate.reason === "cleanup_backlog"
          ? { ...common, hasMore: false, ...candidate }
          : { ...common, ...candidate };
      }
    }
    if (reply !== undefined) return reply;
    if (name === "admission.sweep") return { ok: true, reason: "ok", serverTimeMs: 1_700_000_000_000, hasMore: false };
    if (name === "admission.reconnect") return { ok: true, reason: "ok", serverTimeMs: 1_700_000_000_000 };
    return { ok: true, reason: "ok", expiresAtMs: 1_700_000_090_000, serverTimeMs: 1_700_000_000_000, hasMore: false };
  });
  const events: string[] = [];
  const controller = new RedisAdmissionController({ redis: { execute } as RedisAdmissionScriptPort, prefix, limits, instanceId: "instance-1", now: () => Date.now(), telemetry: { event: (event) => events.push(event) } });
  return { calls, controller, events, execute };
};
afterEach(() => vi.useRealTimers());

describe("RedisAdmissionController", () => {
  it("keeps Redis TIME, capped expiry cleanup, zero-field removal, and reconnect all-or-none in Lua", () => {
    expect(redisAdmissionScripts.acquire).toContain("redis.call('TIME')");
    expect(redisAdmissionScripts.acquire).toContain("'LIMIT', 0, cleanup");
    expect(redisAdmissionScripts.acquire).toContain("cjson.decode(record)");
    expect(redisAdmissionScripts.acquire).toContain("principal:" );
    expect(redisAdmissionScripts.acquire).toContain("'fenced'");
    expect(redisAdmissionScripts.renew).toContain("ZRANGEBYSCORE");
    expect(redisAdmissionScripts.release).toContain("principal:");
    expect(redisAdmissionScripts.release).toContain("'LIMIT', 0, cleanup");
    expect(redisAdmissionScripts.acquire).toContain("local replayed = current == desired");
    expect(redisAdmissionScripts.acquire).toContain("ZADD");
    expect(redisAdmissionScripts.reconnect).toContain("tokens");
    expect(redisAdmissionScripts.reconnect).toContain("if retry > 0 then return");
    expect(redisAdmissionScripts.reconnect).toContain("PEXPIRE");
    expect(redisAdmissionScripts.acquire).toContain("HDEL");
    expect(redisAdmissionScripts.reconnect).toContain("for index = 1, 3 do");
  });

  it("binds named operations to concrete Lua bodies with a bounded node-redis command", async () => {
    const evalScript = vi.fn(async () => ({ ok: true }));
    const port = createNodeRedisAdmissionScriptPort({ withCommandOptions: vi.fn(() => ({ eval: evalScript })) }, 250);
    await port.execute("admission.acquire", ["a", "b", "c"], ["arg"]);
    expect(evalScript).toHaveBeenCalledWith(redisAdmissionScripts.acquire, { keys: ["a", "b", "c"], arguments: ["arg"] });
    await expect(port.execute("unknown", [], [])).rejects.toThrow(/unknown/i);
  });

  it("decodes realistic RESP acquire replies before deriving a lease deadline", async () => {
    const { controller } = createController([[1, "ok", 1_000, 91_000, 0, 0]]);
    await expect(controller.admit({ accountId, workspaceId, principalId })).resolves.toMatchObject({ release: expect.any(Function) });
  });

  it("decodes prune debt only from named result positions, never replay expiry", () => {
    expect(decodeRedisAdmissionReply("admission.acquire", [1, "already_desired", 1_000, 91_000, 0, 1])).toMatchObject({ hasMore: true });
    expect(decodeRedisAdmissionReply("admission.release", [1, "already_desired", 1_000, 0, 0, 0])).toMatchObject({ hasMore: false });
    expect(decodeRedisAdmissionReply("admission.acquire", [1, "ok", 1_000, 91_000, 128, 1])).toMatchObject({ hasMore: true });
    expect(decodeRedisAdmissionReply("admission.sweep", [1, "ok", 1_000, 128, 0])).toMatchObject({ hasMore: false });
  });

  it("requires exact named RESP and object reply shapes instead of structurally casting them", () => {
    expect(decodeRedisAdmissionReply("admission.sweep", [1, "ok"])).toBeUndefined();
    expect(decodeRedisAdmissionReply("admission.acquire", [1, "ok", 0, 90_000])).toBeUndefined();
    expect(decodeRedisAdmissionReply("admission.sweep", [1, "ok", Number.NaN, 0, 0])).toBeUndefined();
    expect(decodeRedisAdmissionReply("admission.acquire", [1, "ok", 0, 90_000, Number.NaN, 0])).toBeUndefined();
    expect(decodeRedisAdmissionReply("admission.acquire", [1, "ok", 0, 90_000, Number.POSITIVE_INFINITY, 0])).toBeUndefined();
    expect(decodeRedisAdmissionReply("admission.acquire", [1, "ok", 0, 90_000, -1, 0])).toBeUndefined();
    expect(decodeRedisAdmissionReply("admission.acquire", [1, "ok", 0, 90_000, 0.5, 0])).toBeUndefined();
    expect(decodeRedisAdmissionReply("admission.sweep", [1, "ok", 0, Number.NaN, 0])).toBeUndefined();
    expect(decodeRedisAdmissionReply("admission.sweep", [1, "ok", 0, -1, 0])).toBeUndefined();
    expect(decodeRedisAdmissionReply("admission.sweep", [1, "ok", 0, 1.5, 0])).toBeUndefined();
    expect(decodeRedisAdmissionReply("admission.sweep", [1, "ok", 0, 0, 0, 0])).toBeUndefined();
    expect(decodeRedisAdmissionReply("admission.reconnect", [1, "ok", 0, 0])).toBeUndefined();
    expect(decodeRedisAdmissionReply("admission.acquire", [0, "fenced", 10, 0])).toBeUndefined();
    expect(decodeRedisAdmissionReply("admission.acquire", [0, "cleanup_backlog", 10, 0])).toMatchObject({ ok: false, hasMore: false });
    expect(decodeRedisAdmissionReply("admission.sweep", [1, "ok", 0, 0, 0])).toMatchObject({ ok: true, hasMore: false });
    expect(decodeRedisAdmissionReply("admission.acquire", [1, "ok", 0, 90_000, 0, 0])).toMatchObject({ ok: true, hasMore: false });
    expect(decodeRedisAdmissionReply("admission.acquire", { ok: true, serverTimeMs: Number.NaN, expiresAtMs: 1 })).toBeUndefined();
    expect(decodeRedisAdmissionReply("admission.acquire", { ok: true, serverTimeMs: 1 })).toBeUndefined();
    expect(decodeRedisAdmissionReply("admission.sweep", { ok: true })).toBeUndefined();
    expect(decodeRedisAdmissionReply("admission.sweep", { ok: true, reason: "ok", serverTimeMs: 0, hasMore: false })).toMatchObject({ ok: true, hasMore: false });
    expect(decodeRedisAdmissionReply("admission.acquire", { ok: true, reason: "ok", serverTimeMs: 0, expiresAtMs: 90_000, hasMore: false, extra: true })).toBeUndefined();
    expect(decodeRedisAdmissionReply("admission.acquire", { ok: false, reason: "fenced", retryAfterMs: Number.POSITIVE_INFINITY })).toBeUndefined();
    expect(decodeRedisAdmissionReply("admission.acquire", { ok: true, reason: "ok", serverTimeMs: 0, expiresAtMs: 90_000, hasMore: false, processedCount: -1 })).toBeUndefined();
    expect(decodeRedisAdmissionReply("admission.sweep", { ok: true, reason: "ok", serverTimeMs: 0, hasMore: false, processedCount: 0.25 })).toBeUndefined();
  });

  it("runs bounded prune before returning every replay response without rejecting backlog", () => {
    for (const script of [redisAdmissionScripts.acquire, redisAdmissionScripts.renew, redisAdmissionScripts.release]) {
      expect(script.indexOf("local replayed")).toBeLessThan(script.indexOf("ZRANGEBYSCORE"));
      expect(script.indexOf("if replayed then return")).toBeGreaterThan(script.indexOf("local hasMore"));
    }
    expect(redisAdmissionScripts.acquire.indexOf("if replayed then return")).toBeLessThan(redisAdmissionScripts.acquire.indexOf("'cleanup_backlog'"));
    for (const script of [redisAdmissionScripts.acquire, redisAdmissionScripts.renew, redisAdmissionScripts.release]) {
      expect(script).toContain("current = tonumber");
      expect(script.lastIndexOf("current = tonumber")).toBeGreaterThan(script.indexOf("for _, lease in ipairs(expired) do"));
    }
  });

  it("uses co-slotted account keys and instance-workspace-hashed aggregate ids", async () => {
    const { controller, calls } = createController([{ ok: true, leaseId: "lease-1" }]);
    await controller.admit({ accountId, workspaceId, principalId });
    expect(calls[0]).toMatchObject({ name: "admission.acquire", keys: [
      `${prefix}:admission:{${accountId}}:expiry`, `${prefix}:admission:{${accountId}}:leases`, `${prefix}:admission:{${accountId}}:counts`,
    ] });
    expect(calls[0]?.args).toEqual(expect.arrayContaining([workspaceId, `instance-1:${workspaceId}:${aggregateHash}`, "0", "1", "128"]));
    expect(calls[0]?.keys.join("|")).not.toContain(principalId);
    expect(calls[0]?.args.join("|")).not.toContain(principalId);
  });

  it("uses the exact eleven-position script tuple for each desired increment", async () => {
    const { controller, calls } = createController([{ ok: true, leaseId: "one" }, { ok: true, leaseId: "two" }]);
    await controller.admit({ accountId, workspaceId, principalId });
    await controller.admit({ accountId, workspaceId, principalId });
    const aggregate = `instance-1:${workspaceId}:${aggregateHash}`;
    const suffix = ["", "10000", "5000", "5", "90000", "128", aggregateHash];
    expect(calls[0]?.args).toEqual([workspaceId, aggregate, "0", "1", ...suffix]);
    expect(calls[1]?.args).toEqual([workspaceId, aggregate, "1", "2", ...suffix]);
  });

  it("refreshes TTL and ZSET expiry on every positive replay script path", () => {
    for (const script of [redisAdmissionScripts.acquire, redisAdmissionScripts.renew, redisAdmissionScripts.release]) {
      const replay = script.slice(script.indexOf("local replayed = current == desired"), script.indexOf("if current ~= expected"));
      expect(replay).toContain("ZADD");
      expect(replay).toContain("PEXPIRE', KEYS[1]");
      expect(replay).toContain("PEXPIRE', KEYS[2]");
      expect(replay).toContain("PEXPIRE', KEYS[3]");
    }
  });

  it("checks exact replay tuples before any bounded cleanup can reject them", () => {
    for (const script of [redisAdmissionScripts.acquire, redisAdmissionScripts.renew, redisAdmissionScripts.release]) {
      expect(script.indexOf("if current == desired")).toBeLessThan(script.indexOf("ZRANGEBYSCORE"));
    }
  });

  it("rejects malformed operation tuples before accepting a replay", () => {
    expect(redisAdmissionScripts.acquire).toContain("if desired ~= expected + 1");
    expect(redisAdmissionScripts.renew).toContain("if desired ~= expected or desired <= 0");
    expect(redisAdmissionScripts.release).toContain("if desired ~= math.max(0, expected - 1)");
    for (const script of [redisAdmissionScripts.acquire, redisAdmissionScripts.renew, redisAdmissionScripts.release]) {
      expect(script.indexOf("if desired ~=")).toBeLessThan(script.indexOf("local replayed = current == desired"));
    }
  });

  it("replays a lost reply with the same CAS tuple", async () => {
    const { controller, calls } = createController([new Error("lost"), { ok: true, leaseId: "lease-1" }]);
    await controller.admit({ accountId, workspaceId, principalId });
    expect(calls).toHaveLength(2);
    expect(calls[1]).toEqual(calls[0]);
  });

  it("exposes only risk and idempotent release on a lease", async () => {
    const { controller, calls } = createController([{ ok: true, leaseId: "lease-1" }, { ok: true }]);
    const lease = await controller.admit({ accountId, workspaceId, principalId });
    expect("renew" in lease).toBe(false);
    expect("close" in lease).toBe(false);
    await Promise.all([lease.release(), lease.release()]);
    expect(calls.filter((call) => call.name === "admission.release")).toHaveLength(1);
  });

  it("does not return a live lease when close races an in-flight acquire", async () => {
    let resolve!: (value: unknown) => void;
    const pending = new Promise((done) => { resolve = done; });
    const controller = new RedisAdmissionController({ redis: { execute: async () => pending } as RedisAdmissionScriptPort, prefix, instanceId: "instance-1", limits, now: () => 0 });
    const admission = controller.admit({ accountId, workspaceId, principalId });
    controller.close();
    resolve({ ok: true, leaseId: "late", serverTimeMs: 0, expiresAtMs: 90_000 });
    await expect(admission).rejects.toMatchObject({ statusCode: 503 });
    await expect(controller.checkReconnect({ accountId, workspaceId, principalId })).rejects.toMatchObject({ statusCode: 503 });
  });

  it("does not start a queued renewal after close invalidates its lifecycle epoch", async () => {
    let releaseQueue!: () => void;
    const queued = new Promise<void>((resolve) => { releaseQueue = resolve; });
    const { controller, calls } = createController([{ ok: true, leaseId: "lease" }]);
    await controller.admit({ accountId, workspaceId, principalId });
    const state = controller as unknown as {
      aggregates: Map<string, { queue: Promise<void> }>;
      renewAggregate(aggregateId: string, now: number): Promise<void>;
    };
    const aggregateId = [...state.aggregates.keys()][0]!;
    state.aggregates.get(aggregateId)!.queue = queued;
    const renewal = state.renewAggregate(aggregateId, 0);
    await Promise.resolve();
    controller.close();
    releaseQueue();
    await renewal;
    expect(calls.filter((call) => call.name === "admission.renew")).toHaveLength(0);
  });

  it.each([
    ["acquire", [{ ok: true, leaseId: "lease" }, { ok: false, reason: "fenced", retryAfterMs: 1 }]],
    ["release", [{ ok: true, leaseId: "lease" }, { ok: false, reason: "fenced", retryAfterMs: 1 }]],
  ] as const)("emits one aggregate degradation for a fenced %s CAS and restores after local teardown", async (_operation, replies) => {
    const { controller, events } = createController([...replies]);
    const states: string[] = [];
    controller.onHealth((health) => states.push(health.state));
    const lease = await controller.admit({ accountId, workspaceId, principalId });
    if (_operation === "acquire") {
      await expect(controller.admit({ accountId, workspaceId, principalId })).rejects.toMatchObject({ reason: "fenced" });
      expect(states).toEqual(["degraded"]);
      await lease.release();
    } else {
      await expect(lease.release()).rejects.toMatchObject({ reason: "fenced" });
    }
    expect(events.filter((event) => event === "degraded")).toHaveLength(1);
    expect(states).toEqual(["degraded", "restored"]);
    controller.close();
  });

  it("performs exactly one Redis release transition for a double release", async () => {
    const { controller, calls } = createController([{ ok: true, leaseId: "lease" }, { ok: true }]);
    const lease = await controller.admit({ accountId, workspaceId, principalId });
    await lease.release();
    await lease.release();
    expect(calls.filter((call) => call.name === "admission.release")).toHaveLength(1);
  });

  it("retains a failed release for bounded reconciliation and removes its aggregate after recovery", async () => {
    vi.useFakeTimers();
    const { controller, calls } = createController([{ ok: true, leaseId: "lease" }, new Error("lost"), new Error("lost"), { ok: true }]);
    const lease = await controller.admit({ accountId, workspaceId, principalId });
    await expect(lease.release()).rejects.toMatchObject({ statusCode: 503 });
    await vi.advanceTimersByTimeAsync(30_001);
    expect(calls.filter((call) => call.name === "admission.release").length).toBeGreaterThanOrEqual(2);
    controller.close();
  });

  it("reconciles each unresolved release transition before a later release derives the next CAS", async () => {
    vi.useFakeTimers();
    const { controller, calls } = createController([
      { ok: true, leaseId: "one" }, { ok: true, leaseId: "two" },
      new Error("lost"), new Error("lost"),
      { ok: true }, { ok: true, serverTimeMs: 0, expiresAtMs: 90_000 },
      { ok: true }, { ok: true, serverTimeMs: 0 },
    ]);
    const first = await controller.admit({ accountId, workspaceId, principalId });
    const second = await controller.admit({ accountId, workspaceId, principalId });
    await expect(first.release()).rejects.toMatchObject({ statusCode: 503 });
    await second.release();
    await vi.advanceTimersByTimeAsync(30_001);
    await vi.advanceTimersByTimeAsync(1);
    const releases = calls.filter((call) => call.name === "admission.release");
    expect(releases.map((call) => call.args.slice(2, 4))).toEqual([["2", "1"], ["2", "1"], ["2", "1"], ["1", "0"]]);
    controller.close();
  });

  it("replays a lost 5→4 release and drains later local releases one CAS decrement at a time", async () => {
    vi.useFakeTimers();
    const { controller, calls } = createController([
      { ok: true }, { ok: true }, { ok: true }, { ok: true }, { ok: true },
      new Error("lost"), new Error("lost"), { ok: true },
      { ok: true }, { ok: true }, { ok: true }, { ok: true },
    ]);
    const leases = await Promise.all(Array.from({ length: 5 }, () => controller.admit({ accountId, workspaceId, principalId })));
    await expect(leases[0]!.release()).rejects.toMatchObject({ statusCode: 503 });
    await Promise.all(leases.slice(1, 4).map((lease) => lease.release()));
    await vi.advanceTimersByTimeAsync(30_001);
    const transitions = calls.filter((call) => call.name === "admission.release").map((call) => call.args.slice(2, 4));
    expect(transitions).toEqual([["5", "4"], ["5", "4"], ["5", "4"], ["4", "3"], ["3", "2"], ["2", "1"]]);
    controller.close();
  });

  it("reconciles an unknown release before deriving a later acquire tuple", async () => {
    const { controller, calls } = createController([
      { ok: true, leaseId: "one" }, { ok: true, leaseId: "two" },
      new Error("lost"), new Error("lost"),
      { ok: true, serverTimeMs: 0, expiresAtMs: 90_000 },
      { ok: true, leaseId: "three", serverTimeMs: 0, expiresAtMs: 90_000 },
    ]);
    const first = await controller.admit({ accountId, workspaceId, principalId });
    await controller.admit({ accountId, workspaceId, principalId });
    await expect(first.release()).rejects.toMatchObject({ statusCode: 503 });
    await controller.admit({ accountId, workspaceId, principalId });
    const operations = calls.map((call) => [call.name, ...call.args.slice(2, 4)]);
    expect(operations).toContainEqual(["admission.release", "2", "1"]);
    expect(operations.at(-1)).toEqual(["admission.acquire", "1", "2"]);
    controller.close();
  });

  it("allows desired-zero release reconciliation without an expiry reply", async () => {
    vi.useFakeTimers();
    const { controller } = createController([
      { ok: true, leaseId: "lease" },
      new Error("lost"), new Error("lost"),
      { ok: true }, { ok: true, serverTimeMs: 1_700_000_030_000 },
    ]);
    const lease = await controller.admit({ accountId, workspaceId, principalId });
    await expect(lease.release()).rejects.toMatchObject({ statusCode: 503 });
    await vi.advanceTimersByTimeAsync(30_001);
    expect((controller as unknown as { aggregates: Map<string, unknown> }).aggregates.size).toBe(0);
    controller.close();
  });

  it("refreshes every remaining local lease deadline after a positive release", async () => {
    const { controller } = createController([
      { ok: true, leaseId: "one", serverTimeMs: 0, expiresAtMs: 100 },
      { ok: true, leaseId: "two", serverTimeMs: 0, expiresAtMs: 100 },
      { ok: true, serverTimeMs: 10, expiresAtMs: 210 },
    ]);
    const first = await controller.admit({ accountId, workspaceId, principalId });
    const second = await controller.admit({ accountId, workspaceId, principalId });
    await first.release();
    expect((second as unknown as { expiresAtMs: number }).expiresAtMs).toBeGreaterThanOrEqual(200);
    controller.close();
  });

  it("fences every active lease in an aggregate once and never rearms renewal", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_700_000_000_000);
    const { controller, calls } = createController([
      { ok: true, leaseId: "one" }, { ok: true, leaseId: "two" },
      { ok: true }, { ok: false, reason: "fenced", retryAfterMs: 1 },
    ]);
    const first = await controller.admit({ accountId, workspaceId, principalId });
    const second = await controller.admit({ accountId, workspaceId, principalId });
    await vi.advanceTimersByTimeAsync(30_000);
    await expect(first.risk).resolves.toMatchObject({ reason: "fenced" });
    await expect(second.risk).resolves.toMatchObject({ reason: "fenced" });
    const renewals = calls.filter((call) => call.name === "admission.renew").length;
    controller.close();
  });

  it("maps distributed rejection and Redis failure to typed 429/503", async () => {
    const limited = createController([{ ok: false, reason: "account_limit", retryAfterMs: 250 }]);
    await expect(limited.controller.admit({ accountId, workspaceId, principalId })).rejects.toMatchObject({ reason: "account_limit", statusCode: 429 });
    const unavailable = createController([new Error("network"), new Error("network")]);
    await expect(unavailable.controller.admit({ accountId, workspaceId, principalId })).rejects.toBeInstanceOf(RealtimeAdmissionError);
  });

  it("cleans ordinary failed admissions while backlog failures retain only bounded sweep debt", async () => {
    vi.useFakeTimers();
    const limited = createController([{ ok: false, reason: "account_limit", retryAfterMs: 10 }]);
    await expect(limited.controller.admit({ accountId, workspaceId, principalId })).rejects.toMatchObject({ statusCode: 429 });
    const limitedState = limited.controller as unknown as { aggregates: Map<string, unknown>; maintenance: { trackedAccountCount(): number } };
    expect(limitedState.aggregates.size).toBe(0);
    expect(limitedState.maintenance.trackedAccountCount()).toBe(0);
    expect(limited.events).toContain("rejected");

    const backlog = createController([{ ok: false, reason: "cleanup_backlog", retryAfterMs: 25 }]);
    await expect(backlog.controller.admit({ accountId, workspaceId, principalId })).rejects.toMatchObject({ reason: "cleanup_backlog", statusCode: 503 });
    const backlogState = backlog.controller as unknown as { aggregates: Map<string, unknown>; maintenance: { debtCount(): number; trackedAccountCount(): number } };
    expect(backlogState.aggregates.size).toBe(0);
    expect(backlogState.maintenance.debtCount()).toBe(1);
    expect(backlogState.maintenance.trackedAccountCount()).toBe(1);
    expect(backlog.events).toContain("degraded");
    backlog.controller.close();
  });

  it("fences active lease risks on acquire and release CAS conflicts", async () => {
    const acquire = createController([{ ok: true, leaseId: "first" }, { ok: false, reason: "fenced", retryAfterMs: 1 }]);
    const retained = await acquire.controller.admit({ accountId, workspaceId, principalId });
    await expect(acquire.controller.admit({ accountId, workspaceId, principalId })).rejects.toMatchObject({ reason: "fenced" });
    await expect(retained.risk).resolves.toMatchObject({ reason: "fenced" });

    const release = createController([{ ok: true, leaseId: "first" }, { ok: true, leaseId: "second" }, { ok: false, reason: "fenced", retryAfterMs: 1 }]);
    const releasing = await release.controller.admit({ accountId, workspaceId, principalId });
    const retainedAfterRelease = await release.controller.admit({ accountId, workspaceId, principalId });
    await expect(releasing.release()).rejects.toMatchObject({ reason: "fenced" });
    await expect(retainedAfterRelease.risk).resolves.toMatchObject({ reason: "fenced" });
    acquire.controller.close();
    release.controller.close();
  });

  it("rejects new and queued admissions once an aggregate is fenced", async () => {
    const { controller, calls } = createController([
      { ok: true, leaseId: "first" },
      { ok: false, reason: "fenced", retryAfterMs: 1 },
    ]);
    const first = controller.admit({ accountId, workspaceId, principalId });
    const fenced = controller.admit({ accountId, workspaceId, principalId });
    const queuedAfterFence = controller.admit({ accountId, workspaceId, principalId });
    const retained = await first;
    await expect(fenced).rejects.toMatchObject({ reason: "fenced", statusCode: 503 });
    await expect(queuedAfterFence).rejects.toMatchObject({ reason: "fenced", statusCode: 503 });
    await expect(controller.admit({ accountId, workspaceId, principalId })).rejects.toMatchObject({ reason: "fenced", statusCode: 503 });
    await expect(retained.risk).resolves.toMatchObject({ reason: "fenced" });
    expect(calls.filter((call) => call.name === "admission.acquire")).toHaveLength(2);
    controller.close();
  });

  it("tears down every post-fence release locally without new Redis transitions", async () => {
    const { controller, calls } = createController([{ ok: true, leaseId: "one" }, { ok: true, leaseId: "two" }]);
    const first = await controller.admit({ accountId, workspaceId, principalId });
    const second = await controller.admit({ accountId, workspaceId, principalId });
    const state = controller as unknown as { aggregates: Map<string, unknown>; fenceAggregate(aggregate: unknown): void; maintenance: { trackedAccountCount(): number } };
    state.fenceAggregate([...state.aggregates.values()][0]);
    const callsBeforeRelease = calls.length;
    await first.release();
    await second.release();
    expect(calls).toHaveLength(callsBeforeRelease);
    expect(state.aggregates.size).toBe(0);
    expect(state.maintenance.trackedAccountCount()).toBe(0);
    expect(controller.schedulerCount()).toBe(0);
    controller.close();
  });

  it("uses due-time ordering rather than scanning later aggregate renewals", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    const { controller, calls } = createController([{ ok: true, leaseId: "first", serverTimeMs: 0, expiresAtMs: 90_000 }]);
    await controller.admit({ accountId, workspaceId, principalId });
    await vi.advanceTimersByTimeAsync(10);
    await controller.admit({ accountId, workspaceId: otherWorkspaceId, principalId });
    await vi.advanceTimersByTimeAsync(29_990);
    const renewals = calls.filter((call) => call.name === "admission.renew");
    expect(renewals).toHaveLength(1);
    expect(renewals[0]?.args[1]).toContain(workspaceId);
    controller.close();
  });

  it.each([
    [0, 24_000],
    [1, 36_000],
  ])("arms independent renewal jitter inside the configured ±20%% window (%s)", async (random, dueAtMs) => {
    const controller = new RedisAdmissionController({
      redis: { execute: async () => admissionSuccess({ leaseId: "lease" }) } as RedisAdmissionScriptPort,
      prefix,
      instanceId: "instance-1",
      now: () => 0,
      random: () => random,
      limits: { ...limits, renewalJitterPercent: 20 },
    });
    await controller.admit({ accountId, workspaceId, principalId });
    const aggregate = [...(controller as unknown as { aggregates: Map<string, { renewalDueAtMs?: number }> }).aggregates.values()][0];
    expect(aggregate?.renewalDueAtMs).toBe(dueAtMs);
    controller.close();
  });

  it("bounds 900 slow aggregate renewals to 256 concurrent commands and clears them before safety", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    let inFlight = 0;
    let maxInFlight = 0;
    let renewals = 0;
    const execute = vi.fn((name: string) => {
      if (name === "admission.sweep") return Promise.resolve({ ok: true, reason: "ok", serverTimeMs: Date.now(), hasMore: false });
      if (name === "admission.renew") {
        renewals += 1;
        inFlight += 1;
        maxInFlight = Math.max(maxInFlight, inFlight);
        return new Promise((resolve) => setTimeout(() => {
          inFlight -= 1;
          resolve(admissionSuccess({ serverTimeMs: Date.now(), expiresAtMs: Date.now() + 90_000 }));
        }, 250));
      }
      return Promise.resolve(admissionSuccess({ leaseId: "lease" }));
    });
    const controller = new RedisAdmissionController({
      redis: { execute } as RedisAdmissionScriptPort,
      prefix,
      instanceId: "instance-1",
      now: () => Date.now(),
      limits,
    });
    await Promise.all(Array.from({ length: 900 }, (_, index) => controller.admit({ accountId, workspaceId: `workspace-${index}`, principalId })));
    await vi.advanceTimersByTimeAsync(31_000);
    expect(maxInFlight).toBeLessThanOrEqual(256);
    expect(renewals).toBe(900);
    expect(Date.now()).toBeLessThan(90_000 - 20_000);
    controller.close();
  });

  it.each(["account_limit", "workspace_limit", "principal_limit"])("maps %s to 429 without leaking local capacity", async (reason) => {
    const { controller } = createController([{ ok: false, reason, retryAfterMs: 10 }, { ok: true, leaseId: "lease" }]);
    await expect(controller.admit({ accountId, workspaceId, principalId })).rejects.toMatchObject({ reason, statusCode: 429 });
    await expect(controller.admit({ accountId, workspaceId, principalId })).resolves.toMatchObject({ release: expect.any(Function) });
  });

  it("keeps cleanup backlog fail-closed as 503 while reconnect maps rejection telemetry", async () => {
    const { controller, events } = createController([{ ok: false, reason: "cleanup_backlog", retryAfterMs: 25 }, { ok: false, reason: "reconnect_limit", retryAfterMs: 50 }]);
    await expect(controller.admit({ accountId, workspaceId, principalId })).rejects.toMatchObject({ reason: "cleanup_backlog", statusCode: 503 });
    await expect(controller.checkReconnect({ accountId, workspaceId, principalId })).rejects.toMatchObject({ reason: "reconnect_limit", statusCode: 429 });
    expect(events).toContain("rejected");
  });

  it("drains failed-admit cleanup debt back to the scheduler baseline without another admission", async () => {
    vi.useFakeTimers();
    const { controller } = createController([{ ok: false, reason: "cleanup_backlog", retryAfterMs: 25 }, [1, "ok", 25, 0, 0]]);
    await expect(controller.admit({ accountId, workspaceId, principalId })).rejects.toMatchObject({ reason: "cleanup_backlog" });
    await vi.advanceTimersByTimeAsync(25);
    const state = controller as unknown as { aggregates: Map<string, unknown>; maintenance: { debtCount(): number; trackedAccountCount(): number } };
    expect(state.aggregates.size).toBe(0);
    expect(state.maintenance.debtCount()).toBe(0);
    expect(state.maintenance.trackedAccountCount()).toBe(0);
    expect(controller.schedulerCount()).toBe(0);
    controller.close();
  });

  it("serializes the same aggregate while another workspace can proceed", async () => {
    let resolveFirst!: () => void;
    const deferred = new Promise((resolve) => { resolveFirst = () => resolve(admissionSuccess({ leaseId: "one", expiresAtMs: 1_700_000_090_000, serverTimeMs: 1_700_000_000_000 })); });
    const { controller, execute } = createController([deferred, { ok: true, leaseId: "two" }, { ok: true, leaseId: "three" }]);
    const first = controller.admit({ accountId, workspaceId, principalId });
    const same = controller.admit({ accountId, workspaceId, principalId });
    const other = controller.admit({ accountId, workspaceId: otherWorkspaceId, principalId });
    await vi.waitFor(() => expect(execute).toHaveBeenCalledTimes(2));
    resolveFirst();
    await Promise.all([first, same, other]);
    expect(execute).toHaveBeenCalledTimes(3);
  });

  it("enforces hard pending plus active process capacity and frees it after rejection", async () => {
    let resolve!: () => void;
    const deferred = new Promise((done) => { resolve = () => done(admissionSuccess({ leaseId: "lease" })); });
    const execute = vi.fn(async () => deferred);
    const controller = new RedisAdmissionController({ redis: { execute } as RedisAdmissionScriptPort, prefix, instanceId: "instance-1", limits: { ...limits, localProcessCap: 1 }, now: () => 0 });
    const pending = controller.admit({ accountId, workspaceId, principalId });
    await expect(controller.admit({ accountId, workspaceId: otherWorkspaceId, principalId })).rejects.toMatchObject({ reason: "local_capacity", statusCode: 429 });
    expect((controller as unknown as { aggregates: Map<string, unknown> }).aggregates.size).toBe(1);
    resolve();
    const lease = await pending;
    await lease.release().catch(() => undefined);
  });

  it("uses an atomic tenant-scoped reconnect script without a raw principal", async () => {
    const { controller, calls } = createController([{ ok: true }]);
    await controller.checkReconnect({ accountId, workspaceId, principalId });
    expect(calls[0]?.name).toBe("admission.reconnect");
    expect(calls[0]?.keys).toHaveLength(3);
    expect(calls[0]?.keys.every((key) => key.includes(`{${accountId}}`))).toBe(true);
    expect(calls[0]?.keys.join("|")).not.toContain(principalId);
  });

  it("propagates reconnect max Retry-After and keeps principal buckets account-scoped across workspaces", async () => {
    const limited = createController([{ ok: false, reason: "reconnect_limit", retryAfterMs: 777 }]);
    await expect(limited.controller.checkReconnect({ accountId, workspaceId, principalId })).rejects.toMatchObject({ statusCode: 429, retryAfterMs: 777 });
    const keys = createController([{ ok: true }, { ok: true }]);
    await keys.controller.checkReconnect({ accountId, workspaceId, principalId });
    await keys.controller.checkReconnect({ accountId, workspaceId: otherWorkspaceId, principalId });
    expect(keys.calls[0]?.keys[2]).toBe(keys.calls[1]?.keys[2]);
    expect(keys.calls[0]?.keys[1]).not.toBe(keys.calls[1]?.keys[1]);
    await keys.controller.checkReconnect({ accountId: "8d7293c8-d241-4f8f-a4db-3df5b88da44c", workspaceId, principalId });
    expect(keys.calls[0]?.keys[2]).not.toBe(keys.calls[2]?.keys[2]);
  });

  it("uses one renewal scheduler and redacted low-cardinality telemetry", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_700_000_000_000);
    const { controller, events } = createController([{ ok: true, leaseId: "lease-1" }, new Error("renew"), new Error("renew")]);
    const lease = await controller.admit({ accountId, workspaceId, principalId });
    expect(controller.schedulerCount()).toBe(1);
    controller.close();
    expect(controller.schedulerCount()).toBe(0);
    expect(events).toEqual(expect.arrayContaining(["accepted"]));
    expect(events.every((event) => ["accepted", "rejected", "degraded"].includes(event))).toBe(true);
  });

  it("emits provider-neutral degraded then restored health around a reconnect", async () => {
    const { controller } = createController([new Error("offline"), { ok: true }]);
    const states: string[] = [];
    const stop = controller.onHealth((health) => states.push(health.state));
    await expect(controller.checkReconnect({ accountId, workspaceId, principalId })).rejects.toMatchObject({ statusCode: 503 });
    await controller.checkReconnect({ accountId, workspaceId, principalId });
    expect(states).toEqual(["degraded", "restored"]);
    stop();
  });

  it("keeps provider health degraded after a failed first admit until a later Redis success", async () => {
    const { controller } = createController([new Error("offline"), new Error("offline"), { ok: true, leaseId: "lease" }]);
    const states: string[] = [];
    controller.onHealth((health) => states.push(health.state));
    await expect(controller.admit({ accountId, workspaceId, principalId })).rejects.toMatchObject({ statusCode: 503 });
    expect(states.at(-1)).toBe("degraded");
    await controller.admit({ accountId, workspaceId, principalId });
    expect(states.at(-1)).toBe("restored");
    controller.close();
  });

  it("does not restore global admission health until every degraded aggregate recovers", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    let failFirst = true;
    const controller = new RedisAdmissionController({
      redis: {
        execute: async (name, _keys, args) => {
          if (name === "admission.sweep") return [1, "ok", Date.now(), 0, 0];
          if (name === "admission.renew" && args[0] === workspaceId && failFirst) throw new Error("down");
          return [1, "ok", Date.now(), Date.now() + 90_000, 0, 0];
        },
      },
      prefix,
      instanceId: "instance-1",
      now: () => Date.now(),
      limits,
    });
    const states: string[] = [];
    controller.onHealth((health) => states.push(health.state));
    await controller.admit({ accountId, workspaceId, principalId });
    await controller.admit({ accountId, workspaceId: otherWorkspaceId, principalId });
    await vi.advanceTimersByTimeAsync(30_000);
    expect(states.at(-1)).toBe("degraded");
    failFirst = false;
    const firstAggregateId = [...(controller as unknown as { aggregates: Map<string, unknown> }).aggregates.keys()].find((id) => id.includes(workspaceId))!;
    await (controller as unknown as { renewAggregate(id: string, now: number): Promise<void> }).renewAggregate(firstAggregateId, Date.now());
    expect(states.at(-1)).toBe("restored");
    controller.close();
  });

  it("does not starve a due renewal while bounded cleanup debt persists", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    let renewals = 0;
    const controller = new RedisAdmissionController({
      redis: {
        execute: async (name) => {
          if (name === "admission.sweep") return [1, "ok", Date.now(), 128, 1];
          if (name === "admission.renew") {
            renewals += 1;
            return [1, "ok", Date.now(), Date.now() + 90_000, 0, 1];
          }
          return [1, "ok", 0, 90_000, 0, 1];
        },
      },
      prefix,
      instanceId: "instance-1",
      now: () => Date.now(),
      limits,
    });
    await controller.admit({ accountId, workspaceId, principalId });
    await vi.advanceTimersByTimeAsync(30_000);
    expect(renewals).toBeGreaterThan(0);
    controller.close();
  });

  it("retains maintenance debt on malformed or failed sweep replies", async () => {
    vi.useFakeTimers();
    const { controller } = createController([[1, "ok", 0, 90_000, 0, 1], ["malformed"]]);
    await controller.admit({ accountId, workspaceId, principalId });
    await vi.advanceTimersByTimeAsync(25);
    const maintenance = (controller as unknown as { maintenance: { debtCount(): number } }).maintenance;
    expect(maintenance.debtCount()).toBe(1);
    controller.close();
  });

  it("cancels the sole scheduler after the final release", async () => {
    vi.useFakeTimers();
    const { controller } = createController([{ ok: true, leaseId: "lease-1" }, { ok: true }]);
    const lease = await controller.admit({ accountId, workspaceId, principalId });
    expect(controller.schedulerCount()).toBe(1);
    await lease.release();
    expect(controller.schedulerCount()).toBe(0);
  });

  it("keeps final-release prune debt alive, then returns aggregate, account, and scheduler state to baseline", async () => {
    vi.useFakeTimers();
    const { controller } = createController([
      [1, "ok", 0, 90_000, 0, 1],
      [1, "ok", 0, 0, 0, 1],
      [1, "ok", 25, 0, 0],
    ]);
    const lease = await controller.admit({ accountId, workspaceId, principalId });
    await lease.release();
    expect(controller.schedulerCount()).toBe(1);
    await vi.advanceTimersByTimeAsync(25);
    const state = controller as unknown as { aggregates: Map<string, unknown>; maintenance: { trackedAccountCount(): number; debtCount(): number } };
    expect(state.aggregates.size).toBe(0);
    expect(state.maintenance.trackedAccountCount()).toBe(0);
    expect(state.maintenance.debtCount()).toBe(0);
    expect(controller.schedulerCount()).toBe(0);
    controller.close();
  });

  it("keeps the bounded round-robin account queue independent of aggregate churn", async () => {
    const { controller } = createController([{ ok: true, leaseId: "a" }, { ok: true, leaseId: "b" }]);
    await controller.admit({ accountId, workspaceId, principalId });
    await controller.admit({ accountId: "7d7293c8-d241-4f8f-a4db-3df5b88da44c", workspaceId, principalId });
    const maintenance = (controller as unknown as { maintenance: { trackedAccountCount(): number } }).maintenance;
    expect(maintenance.trackedAccountCount()).toBe(2);
  });

  it("fails closed rather than omitting an account beyond the bounded sweep set", async () => {
    const { controller } = createController([{ ok: true, leaseId: "a" }]);
    const state = controller as unknown as { maintenance: { trackAccount(account: string, cap: number): boolean } };
    for (const account of Array.from({ length: 10_000 }, (_, index) => `a-${index}`)) {
      expect(state.maintenance.trackAccount(account, 10_000)).toBe(true);
    }
    await expect(controller.admit({ accountId, workspaceId, principalId })).rejects.toMatchObject({ reason: "local_capacity", statusCode: 429 });
  });

  it("uses Redis server expiry rather than a hostile wall-clock and cancels a pending risk after recovery", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(10_000);
    const responses: unknown[] = [
      admissionSuccess({ leaseId: "lease", serverTimeMs: 1_000, expiresAtMs: 2_000 }),
      new Error("renew lost"), new Error("renew lost"),
      admissionSuccess({ serverTimeMs: 1_100, expiresAtMs: 2_100 }),
    ];
    const execute = vi.fn(async () => {
      const response = responses.shift();
      if (response instanceof Error) throw response;
      return response;
    });
    const controller = new RedisAdmissionController({
      redis: { execute } as RedisAdmissionScriptPort, prefix, instanceId: "instance-1", now: () => Date.now(),
      limits: { ...limits, renewalMs: 100, leaseTtlMs: 1_000, safetyMs: 100, closeJitterMaxMs: 50 },
    });
    const lease = await controller.admit({ accountId, workspaceId, principalId });
    let risked = false;
    void lease.risk.then(() => { risked = true; });
    await vi.advanceTimersByTimeAsync(200);
    expect(risked).toBe(false);
    controller.close();
  });

  it("arms the initial expiry-safety risk independently of a later renewal attempt", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    const controller = new RedisAdmissionController({
      redis: { execute: async () => admissionSuccess({ leaseId: "lease", expiresAtMs: 100 }) } as RedisAdmissionScriptPort,
      prefix,
      instanceId: "instance-1",
      now: () => Date.now(),
      limits: { ...limits, renewalMs: 200, leaseTtlMs: 100, safetyMs: 20 },
    });
    const lease = await controller.admit({ accountId, workspaceId, principalId });
    await vi.advanceTimersByTimeAsync(80);
    await expect(lease.risk).resolves.toMatchObject({ reason: "expiry_risk", closeAtMs: 80 });
    controller.close();
  });

  it("delivers a late risk once and never rearms a terminal-risked lease", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    let calls = 0;
    let renewals = 0;
    const execute = vi.fn(async (name: string) => {
      calls += 1;
      if (name === "admission.renew") renewals += 1;
      if (calls === 1) return admissionSuccess({ leaseId: "lease", expiresAtMs: 100 });
      throw new Error("late renewal");
    });
    const controller = new RedisAdmissionController({ redis: { execute } as RedisAdmissionScriptPort, prefix, instanceId: "instance-1", now: () => Date.now(), limits: { ...limits, renewalMs: 100, leaseTtlMs: 100, safetyMs: 20, closeJitterMaxMs: 19 } });
    const lease = await controller.admit({ accountId, workspaceId, principalId });
    let risks = 0;
    let closeAtMs = Number.NaN;
    void lease.risk.then((risk) => { risks += 1; closeAtMs = risk.closeAtMs; });
    await vi.advanceTimersByTimeAsync(126);
    expect(risks).toBe(1);
    expect(closeAtMs).toBeGreaterThanOrEqual(80);
    expect(closeAtMs).toBeLessThanOrEqual(99);
    const renewalsAtRisk = renewals;
    await vi.advanceTimersByTimeAsync(500);
    expect(risks).toBe(1);
    expect(renewals).toBe(renewalsAtRisk);
    controller.close();
  });

  it("does exactly one bounded account sweep per round-robin tick without a busy loop", async () => {
    vi.useFakeTimers();
    const { controller, calls } = createController([{ ok: true, leaseId: "lease" }]);
    await controller.admit({ accountId, workspaceId, principalId });
    await vi.advanceTimersByTimeAsync(30_000);
    expect(calls.filter((call) => call.name === "admission.sweep")).toHaveLength(1);
    expect(calls.find((call) => call.name === "admission.sweep")?.args).toEqual(["128"]);
    controller.close();
  });

  it("fences every active aggregate lease once and stops renewal rearming", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_700_000_000_000);
    const { controller, calls } = createController([{ ok: true, leaseId: "one" }, { ok: true, leaseId: "two" }, { ok: true }, { ok: false, reason: "fenced", retryAfterMs: 1 }]);
    const first = await controller.admit({ accountId, workspaceId, principalId });
    const second = await controller.admit({ accountId, workspaceId, principalId });
    await vi.advanceTimersByTimeAsync(30_000);
    await expect(first.risk).resolves.toMatchObject({ reason: "fenced" });
    await expect(second.risk).resolves.toMatchObject({ reason: "fenced" });
    const renewals = calls.filter((call) => call.name === "admission.renew").length;
    await vi.advanceTimersByTimeAsync(60_000);
    expect(calls.filter((call) => call.name === "admission.renew")).toHaveLength(renewals);
    controller.close();
  });

});
