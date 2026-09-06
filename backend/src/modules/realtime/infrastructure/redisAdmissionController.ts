import { createHash } from "node:crypto";
import {
  RealtimeAdmissionError,
  type AdmissionLeaseRisk,
  type RealtimeAdmissionHealthListener,
  type RealtimeAdmissionLease,
} from "../domain/contracts.js";
import { redisAdmissionScripts } from "./redisAdmissionScripts.js";
import { decodeRedisAdmissionReply, type RedisAdmissionScriptReply } from "./redisAdmissionReply.js";
import { admissionRedisKeys, admissionScriptArgs, reconnectRedisKeys } from "./redisAdmissionProtocol.js";
import { AdmissionMaintenanceScheduler } from "./admissionMaintenanceScheduler.js";
import { AggregateTransitionState } from "./aggregateTransitionState.js";

export { RealtimeAdmissionError } from "../domain/contracts.js";

/** The only Redis surface the admission domain needs. Scripts use Redis TIME. */
export interface RedisAdmissionScriptPort {
  execute(name: string, keys: readonly string[], args: readonly string[]): Promise<unknown>;
}

/** Adapter-local node-redis bridge: every script call carries the command timeout. */
export const createNodeRedisAdmissionScriptPort = (client: {
  withCommandOptions(options: { timeout: number }): { eval(script: string, options: { keys: string[]; arguments: string[] }): Promise<unknown> };
}, commandTimeoutMs: number): RedisAdmissionScriptPort => ({
  execute: async (name, keys, args) => {
    const script = name === "admission.acquire" ? redisAdmissionScripts.acquire
      : name === "admission.renew" ? redisAdmissionScripts.renew
        : name === "admission.release" ? redisAdmissionScripts.release
          : name === "admission.sweep" ? redisAdmissionScripts.sweep
            : name === "admission.reconnect" ? redisAdmissionScripts.reconnect
              : undefined;
    if (!script) throw new Error(`Unknown Redis admission script: ${name}`);
    return client.withCommandOptions({ timeout: commandTimeoutMs }).eval(script, { keys: [...keys], arguments: [...args] });
  },
});

type AdmissionInput = { accountId: string; workspaceId: string; principalId: string };
type ScriptReply = RedisAdmissionScriptReply & { commandStartedAtMs?: number };
type Aggregate = {
  id: string;
  accountId: string;
  workspaceId: string;
  principalId: string;
  desired: number;
  redisExpected: number;
  reconciliationNeeded: boolean;
  reconciliationTarget: number | undefined;
  transition: AggregateTransitionState;
  degraded: boolean;
  fenced: boolean;
  queue: Promise<void>;
  leases: Set<LeaseHandle>;
  pending: number;
  renewalVersion: number;
  renewalDueAtMs: number | undefined;
};

type Limits = {
  account: number;
  workspace: number;
  principal: number;
  pendingPerAggregate: number;
  leaseTtlMs: number;
  renewalMs: number;
  renewalJitterPercent?: number;
  safetyMs?: number;
  closeJitterMaxMs?: number;
  cleanupLimit: number;
  localProcessCap: number;
  accountSweeperMaxAccounts?: number;
  reconnect: {
    account: { limit: number; windowMs: number; burst: number };
    workspace: { limit: number; windowMs: number; burst: number };
    principal: { limit: number; windowMs: number; burst: number };
  };
};

export type RedisAdmissionTelemetry = { event(outcome: "accepted" | "rejected" | "degraded"): void };

type ControllerInput = {
  redis: RedisAdmissionScriptPort;
  prefix: string;
  limits: Limits;
  instanceId: string;
  now?: () => number;
  random?: () => number;
  telemetry?: RedisAdmissionTelemetry;
};

const aggregateHash = (accountId: string, principalId: string) =>
  createHash("sha256").update(`${accountId}:${principalId}`).digest("hex");

const failure = (reason: string | undefined, retryAfterMs?: number) => {
  const limited = reason === "account_limit" || reason === "workspace_limit" || reason === "principal_limit" || reason === "reconnect_limit" || reason === "local_capacity";
  const preserved = reason === "cleanup_backlog" || reason === "fenced";
  return new RealtimeAdmissionError(
    (limited || preserved ? reason : "redis_unavailable"),
    limited ? 429 : 503,
    Math.max(1, retryAfterMs ?? 1_000),
  );
};

class LeaseHandle implements RealtimeAdmissionLease {
  private released = false;
  private risked = false;
  private riskDeadlineMs: number | undefined;
  private resolveRisk!: (risk: AdmissionLeaseRisk) => void;
  expiresAtMs: number;
  readonly risk = new Promise<AdmissionLeaseRisk>((resolve) => { this.resolveRisk = resolve; });

  constructor(
    readonly input: AdmissionInput,
    readonly aggregateId: string,
    readonly leaseId: string,
    expiresAtMs: number,
    private readonly controller: RedisAdmissionController,
  ) { this.expiresAtMs = expiresAtMs; }

  release(): Promise<void> {
    if (this.released) return Promise.resolve();
    this.released = true;
    return this.controller.releaseHandle(this);
  }

  riskNow(reason: AdmissionLeaseRisk["reason"], closeAtMs: number): void {
    this.riskDeadlineMs = undefined;
    this.risked = true;
    this.resolveRisk({ reason, closeAtMs });
  }

  armRisk(closeAtMs: number): void { this.riskDeadlineMs = closeAtMs; }
  clearRisk(): void { this.riskDeadlineMs = undefined; }
  riskDeadline(): number | undefined { return this.riskDeadlineMs; }
  isRisked(): boolean { return this.risked; }

  updateExpiry(expiresAtMs: number): void {
    this.expiresAtMs = expiresAtMs;
  }
}

/**
 * Redis-server-time lease controller. It owns local counts and renewal timing;
 * scripts own all distributed counters, expiry pruning, and CAS fencing.
 */
export class RedisAdmissionController {
  private readonly aggregates = new Map<string, Aggregate>();
  private closed = false;
  private lifecycleEpoch = 0;
  private activeLocalCount = 0;
  private pendingLocalCount = 0;
  private readonly accountAggregateCounts = new Map<string, number>();
  private readonly healthListeners = new Set<RealtimeAdmissionHealthListener>();
  private healthState: "degraded" | "restored" = "restored";
  private degradedAggregateCount = 0;
  private reconnectDegraded = false;
  private readonly degradedMaintenanceAccounts = new Set<string>();
  private readonly maintenance = new AdmissionMaintenanceScheduler({
    now: () => this.now(),
    isCurrent: (work) => {
      const aggregate = this.aggregates.get(work.aggregateId);
      return !!aggregate && !aggregate.fenced && aggregate.renewalVersion === work.version && aggregate.renewalDueAtMs === work.dueAtMs;
    },
    sweep: (accountId) => this.sweepAccount(accountId),
    renew: (work) => Promise.all(work.map((item) => this.renewAggregate(item.aggregateId, this.now()))).then(() => undefined),
  });

  constructor(private readonly input: ControllerInput) {}

  async admit(input: AdmissionInput): Promise<RealtimeAdmissionLease> {
    if (this.closed) throw failure("redis_unavailable");
    const epoch = this.lifecycleEpoch;
    const aggregateId = this.aggregateId(input);
    const existing = this.aggregates.get(aggregateId);
    if (existing?.fenced) {
      throw failure("fenced");
    }
    if (!existing && !this.trackAccount(input.accountId)) {
      this.input.telemetry?.event("rejected");
      throw failure("local_capacity", 1);
    }
    const aggregate = existing ?? this.aggregateFor(aggregateId, input);
    if (aggregate.pending >= this.input.limits.pendingPerAggregate || this.localOccupancy() >= this.input.limits.localProcessCap) {
      if (!existing) {
        this.removeAggregate(aggregateId, aggregate);
        this.dropInactiveAccount(input.accountId);
      }
      this.input.telemetry?.event("rejected");
      throw failure("local_capacity", 1);
    }
    aggregate.pending += 1;
    this.pendingLocalCount += 1;
    let admissionFailure: RealtimeAdmissionError | undefined;
    try {
      return await this.serial(aggregateId, async () => {
        await this.reconcilePendingTransitions(aggregateId, aggregate);
        if (aggregate.fenced) throw failure("fenced");
        const expected = aggregate.redisExpected;
        const desired = aggregate.desired + 1;
        const reply = await this.executeWithReplay("admission.acquire", this.admissionKeys(input.accountId), this.admissionArgs(input, aggregateId, expected, desired));
        this.assertReply(reply);
        if (this.closed || epoch !== this.lifecycleEpoch) throw failure("redis_unavailable");
        this.noteProviderSuccess();
        this.recordPruneDebt(input.accountId, reply);
        aggregate.redisExpected = desired;
        aggregate.desired = aggregate.transition.acquired();
        const expiry = this.monotonicExpiry(reply);
        const handle = new LeaseHandle(input, aggregateId, reply.leaseId ?? `${aggregateId}:${desired}`, expiry, this);
        aggregate.leases.add(handle);
        this.armLeaseExpiryRisk(handle);
        this.activeLocalCount += 1;
        this.input.telemetry?.event("accepted");
        this.refreshHealth();
        this.armRenewal(aggregateId, aggregate, this.nextRenewalAt(this.now()));
        return handle;
      });
    } catch (error) {
      admissionFailure = error instanceof RealtimeAdmissionError ? error : failure("redis_unavailable");
      if (admissionFailure.reason === "fenced") {
        // Fence owns the sole aggregate-degradation event and health transition.
        this.fenceAggregate(aggregate);
      } else {
        this.input.telemetry?.event(admissionFailure.statusCode === 429 ? "rejected" : "degraded");
      }
      if (admissionFailure.statusCode === 503 && admissionFailure.reason !== "fenced") {
        if (admissionFailure.reason === "cleanup_backlog") {
          this.degradedMaintenanceAccounts.add(input.accountId);
          this.refreshHealth();
        } else {
          this.reconnectDegraded = true;
          this.markAggregateDegraded(aggregate);
        }
      }
      throw admissionFailure;
    } finally {
      aggregate.pending -= 1;
      this.pendingLocalCount -= 1;
      if (aggregate.pending === 0 && aggregate.desired === 0 && aggregate.leases.size === 0) {
        if (admissionFailure?.reason === "cleanup_backlog") {
          this.markSweepDebt(aggregate.accountId);
          this.degradedMaintenanceAccounts.add(aggregate.accountId);
          this.refreshHealth();
          this.schedule();
        }
        this.removeAggregate(aggregateId, aggregate);
      }
    }
  }

  async checkReconnect(input: AdmissionInput): Promise<void> {
    if (this.closed) throw failure("redis_unavailable");
    const epoch = this.lifecycleEpoch;
    const keys = reconnectRedisKeys(this.input.prefix, input, aggregateHash(input.accountId, input.principalId));
    const args = [
      String(this.input.limits.reconnect.account.windowMs), String(this.input.limits.reconnect.account.limit), String(this.input.limits.reconnect.account.burst),
      String(this.input.limits.reconnect.workspace.windowMs), String(this.input.limits.reconnect.workspace.limit), String(this.input.limits.reconnect.workspace.burst),
      String(this.input.limits.reconnect.principal.windowMs), String(this.input.limits.reconnect.principal.limit), String(this.input.limits.reconnect.principal.burst),
    ];
    try {
      this.assertReply(this.decodeReply("admission.reconnect", await this.input.redis.execute("admission.reconnect", keys, args)));
      if (this.closed || epoch !== this.lifecycleEpoch) throw failure("redis_unavailable");
      this.reconnectDegraded = false;
      this.refreshHealth();
    } catch (error) {
      const admissionError = error instanceof RealtimeAdmissionError ? error : failure("redis_unavailable");
      this.input.telemetry?.event(admissionError.statusCode === 429 ? "rejected" : "degraded");
      if (admissionError.statusCode === 503) {
        this.reconnectDegraded = true;
        this.refreshHealth();
      }
      throw admissionError;
    }
  }

  schedulerCount(): number { return this.maintenance.count(); }
  pendingAggregateCount(): number { return this.pendingLocalCount; }

  onHealth(listener: RealtimeAdmissionHealthListener): () => void {
    this.healthListeners.add(listener);
    return () => this.healthListeners.delete(listener);
  }

  async releaseHandle(handle: LeaseHandle): Promise<void> {
    const aggregate = this.aggregates.get(handle.aggregateId);
    if (!aggregate) return;
    await this.serial(handle.aggregateId, async () => {
      if (aggregate.fenced) {
        aggregate.transition.releaseLocallyAfterFence();
        aggregate.desired = aggregate.transition.localDesired;
        aggregate.leases.delete(handle);
        this.activeLocalCount = Math.max(0, this.activeLocalCount - 1);
        if (aggregate.desired === 0 && aggregate.leases.size === 0 && aggregate.pending === 0) this.removeAggregate(handle.aggregateId, aggregate);
        this.schedule();
        return;
      }
      const expected = aggregate.redisExpected;
      const desired = aggregate.transition.released();
      if (desired === undefined) return;
      aggregate.desired = aggregate.transition.localDesired; // local slot is always freed, even if Redis reply is lost.
      aggregate.leases.delete(handle);
      this.activeLocalCount = Math.max(0, this.activeLocalCount - 1);
      if (aggregate.reconciliationNeeded) {
        this.armRenewal(handle.aggregateId, aggregate, this.now());
        return;
      }
      try {
        const reply = await this.executeWithReplay("admission.release", this.admissionKeys(handle.input.accountId), this.admissionArgs(handle.input, handle.aggregateId, expected, desired, handle.leaseId));
        this.assertReply(reply);
        this.noteProviderSuccess();
        this.recordPruneDebt(handle.input.accountId, reply);
        aggregate.redisExpected = desired;
        aggregate.transition.acknowledgeStep();
        aggregate.reconciliationNeeded = false;
        aggregate.reconciliationTarget = undefined;
        this.clearAggregateDegraded(aggregate);
        if (desired > 0) {
          const expiry = this.monotonicExpiry(reply);
          for (const activeLease of aggregate.leases) {
            activeLease.updateExpiry(expiry);
            this.armLeaseExpiryRisk(activeLease);
          }
          this.armRenewal(handle.aggregateId, aggregate, this.nextRenewalAt(this.now()));
        }
      } catch (error) {
        aggregate.reconciliationNeeded = true;
        aggregate.reconciliationTarget = aggregate.transition.nextTarget;
        if (error instanceof RealtimeAdmissionError && error.reason === "fenced") {
          this.fenceAggregate(aggregate);
        } else {
          this.input.telemetry?.event("degraded");
          this.markAggregateDegraded(aggregate);
        }
        this.schedule();
        throw error;
      } finally {
        if (!aggregate.reconciliationNeeded && aggregate.desired === 0 && aggregate.leases.size === 0 && aggregate.pending === 0) {
          this.removeAggregate(handle.aggregateId, aggregate);
        }
        this.schedule();
      }
    });
  }

  private admissionKeys(accountId: string): string[] {
    return admissionRedisKeys(this.input.prefix, accountId);
  }

  private admissionArgs(input: AdmissionInput, aggregateId: string, expected: number, desired: number, leaseId = ""): string[] {
    return admissionScriptArgs(input, aggregateId, expected, desired, this.input.limits, aggregateHash(input.accountId, input.principalId), leaseId);
  }

  private aggregateId(input: AdmissionInput): string {
    return `${this.input.instanceId}:${input.workspaceId}:${aggregateHash(input.accountId, input.principalId)}`;
  }

  private aggregateFor(id: string, input?: AdmissionInput): Aggregate {
    let aggregate = this.aggregates.get(id);
    if (!aggregate) {
      aggregate = {
        id,
        accountId: input?.accountId ?? "",
        workspaceId: input?.workspaceId ?? "",
        principalId: input?.principalId ?? "",
        desired: 0,
        redisExpected: 0,
        reconciliationNeeded: false,
        reconciliationTarget: undefined,
        transition: new AggregateTransitionState(),
        degraded: false,
        fenced: false,
        leases: new Set(),
        pending: 0,
        renewalVersion: 0,
        renewalDueAtMs: undefined,
        queue: Promise.resolve(),
      };
      this.aggregates.set(id, aggregate);
      this.accountAggregateCounts.set(aggregate.accountId, (this.accountAggregateCounts.get(aggregate.accountId) ?? 0) + 1);
    }
    return aggregate;
  }

  private serial<T>(aggregateId: string, operation: () => Promise<T>): Promise<T> {
    const aggregate = this.aggregateFor(aggregateId);
    const run = aggregate.queue.catch(() => undefined).then(operation);
    aggregate.queue = run.then(() => undefined, () => undefined);
    return run;
  }

  private removeAggregate(aggregateId: string, aggregate: Aggregate): void {
    if (!this.aggregates.delete(aggregateId)) return;
    this.maintenance.cancel(aggregateId);
    const remaining = (this.accountAggregateCounts.get(aggregate.accountId) ?? 1) - 1;
    if (remaining <= 0) this.accountAggregateCounts.delete(aggregate.accountId);
    else this.accountAggregateCounts.set(aggregate.accountId, remaining);
    if (aggregate.degraded) {
      this.degradedAggregateCount = Math.max(0, this.degradedAggregateCount - 1);
      this.refreshHealth();
    }
    this.dropInactiveAccount(aggregate.accountId);
  }

  /** Replays every unknown release step before deriving a later desired count. */
  private async reconcilePendingTransitions(aggregateId: string, aggregate: Aggregate): Promise<void> {
    while (aggregate.transition.hasPending) {
      const target = aggregate.transition.nextTarget;
      if (target === undefined) throw failure("redis_unavailable");
      const input = { accountId: aggregate.accountId, workspaceId: aggregate.workspaceId, principalId: aggregate.principalId };
      const reply = await this.executeWithReplay(
        "admission.release",
        this.admissionKeys(input.accountId),
        this.admissionArgs(input, aggregateId, aggregate.redisExpected, target),
      );
      this.assertReply(reply);
      this.noteProviderSuccess();
      this.recordPruneDebt(input.accountId, reply);
      const expiry = target > 0 ? this.monotonicExpiry(reply) : undefined;
      aggregate.redisExpected = target;
      aggregate.transition.acknowledgeStep();
      aggregate.reconciliationNeeded = aggregate.transition.hasPending;
      aggregate.reconciliationTarget = aggregate.transition.nextTarget;
      this.clearAggregateDegraded(aggregate);
      for (const lease of aggregate.leases) {
        if (expiry !== undefined) {
          lease.updateExpiry(expiry);
          this.armLeaseExpiryRisk(lease);
        }
      }
    }
  }

  private async executeWithReplay(name: string, keys: string[], args: string[]): Promise<ScriptReply> {
    const commandStartedAtMs = this.now();
    try {
      return { ...this.decodeReply(name, await this.input.redis.execute(name, keys, args)), commandStartedAtMs };
    } catch {
      try {
        return { ...this.decodeReply(name, await this.input.redis.execute(name, keys, args)), commandStartedAtMs };
      } catch {
        throw failure("redis_unavailable");
      }
    }
  }

  private decodeReply(name: string, value: unknown): ScriptReply {
    const reply = decodeRedisAdmissionReply(name, value);
    if (!reply) throw failure("redis_unavailable");
    return reply;
  }

  private assertReply(reply: ScriptReply): asserts reply is ScriptReply & { ok: true } {
    if (!reply?.ok) throw failure(reply?.reason, reply?.retryAfterMs);
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.lifecycleEpoch += 1;
    this.maintenance.close();
    this.accountAggregateCounts.clear();
    this.aggregates.clear();
    this.activeLocalCount = 0;
    this.pendingLocalCount = 0;
    this.degradedAggregateCount = 0;
    this.degradedMaintenanceAccounts.clear();
    this.reconnectDegraded = false;
    this.healthListeners.clear();
  }

  private localOccupancy(): number {
    return this.activeLocalCount + this.pendingLocalCount;
  }

  private schedule(): void {
    this.maintenance.refresh();
  }

  private async renewAggregate(aggregateId: string, now: number): Promise<void> {
    const epoch = this.lifecycleEpoch;
    const aggregate = this.aggregates.get(aggregateId);
    if (this.closed || !aggregate || aggregate.fenced) return;
    for (const lease of aggregate.leases) {
      const deadline = lease.riskDeadline();
      if (deadline !== undefined && deadline <= now && !lease.isRisked()) lease.riskNow("expiry_risk", deadline);
    }
    const lease = [...aggregate.leases].find((candidate) => !candidate.isRisked());
    if (!lease && !aggregate.reconciliationNeeded) return;
    try {
      const reconciliationLease = lease ?? ({ input: { accountId: aggregate.accountId, workspaceId: aggregate.workspaceId, principalId: aggregate.principalId }, aggregateId, leaseId: "" } as LeaseHandle);
      await this.serial(aggregateId, async () => {
        // This callback can wait behind a release. Never begin new Redis work after
        // shutdown invalidates its lifecycle, even when it was already queued.
        if (this.closed || epoch !== this.lifecycleEpoch || aggregate.fenced) return;
        await this.reconcilePendingTransitions(aggregateId, aggregate);
        if (this.closed || epoch !== this.lifecycleEpoch || aggregate.fenced) return;
        if (aggregate.desired === 0 && aggregate.leases.size === 0) {
          this.removeAggregate(aggregateId, aggregate);
          return;
        }
        if (this.closed || epoch !== this.lifecycleEpoch) return;
        const reply = await this.executeWithReplay("admission.renew", this.admissionKeys(reconciliationLease.input.accountId), this.admissionArgs(reconciliationLease.input, aggregateId, aggregate.redisExpected, aggregate.desired, reconciliationLease.leaseId));
        this.assertReply(reply);
        this.noteProviderSuccess();
        if (this.closed || epoch !== this.lifecycleEpoch) return;
        this.recordPruneDebt(reconciliationLease.input.accountId, reply);
        const expiry = this.monotonicExpiry(reply);
        aggregate.redisExpected = aggregate.desired;
        this.clearAggregateDegraded(aggregate);
        for (const activeLease of aggregate.leases) {
          activeLease.updateExpiry(expiry);
          this.armLeaseExpiryRisk(activeLease);
        }
        this.armRenewal(aggregateId, aggregate, this.nextRenewalAt(this.now()));
      });
    } catch (error) {
      if (error instanceof RealtimeAdmissionError && error.reason === "fenced") {
        this.fenceAggregate(aggregate);
        return;
      }
      const maxJitter = Math.min(this.input.limits.closeJitterMaxMs ?? 0, Math.max(0, this.input.limits.safetyMs ?? 0) - 1);
      const jitter = Math.floor(Math.max(0, Math.min(1, (this.input.random ?? Math.random)())) * maxJitter);
      let deadline = Number.POSITIVE_INFINITY;
      for (const activeLease of aggregate.leases) {
        const closeAtMs = Math.min(activeLease.expiresAtMs - (this.input.limits.safetyMs ?? 0) + jitter, activeLease.expiresAtMs - 1);
        if (closeAtMs <= this.now()) activeLease.riskNow("expiry_risk", closeAtMs);
        else {
          activeLease.armRisk(closeAtMs);
          deadline = Math.min(deadline, closeAtMs);
        }
      }
      if (deadline !== Number.POSITIVE_INFINITY) this.armRenewal(aggregateId, aggregate, deadline);
      this.input.telemetry?.event("degraded");
      this.markAggregateDegraded(aggregate);
    }
  }

  private now(): number { return this.input.now?.() ?? performance.now(); }

  private setHealth(state: "degraded" | "restored"): void {
    if (this.healthState === state) return;
    this.healthState = state;
    for (const listener of this.healthListeners) listener({ state });
  }

  private markAggregateDegraded(aggregate: Aggregate): void {
    if (!aggregate.degraded) {
      aggregate.degraded = true;
      this.degradedAggregateCount += 1;
    }
    this.refreshHealth();
  }

  private clearAggregateDegraded(aggregate: Aggregate): void {
    if (aggregate.degraded) {
      aggregate.degraded = false;
      this.degradedAggregateCount = Math.max(0, this.degradedAggregateCount - 1);
    }
    this.refreshHealth();
  }

  private refreshHealth(): void {
    this.setHealth(this.reconnectDegraded || this.degradedMaintenanceAccounts.size > 0 || this.degradedAggregateCount > 0 ? "degraded" : "restored");
  }

  private noteProviderSuccess(): void {
    this.reconnectDegraded = false;
    this.refreshHealth();
  }

  private nextRenewalAt(now: number): number {
    const percent = this.input.limits.renewalJitterPercent ?? 0;
    const spread = this.input.limits.renewalMs * percent / 100;
    const random = Math.max(0, Math.min(1, (this.input.random ?? Math.random)()));
    return now + this.input.limits.renewalMs + (random * 2 - 1) * spread;
  }

  private monotonicExpiry(reply: ScriptReply): number {
    if (reply.expiresAtMs === undefined || reply.serverTimeMs === undefined) throw failure("redis_unavailable");
    return (reply.commandStartedAtMs ?? this.now()) + Math.max(0, reply.expiresAtMs - reply.serverTimeMs);
  }

  private armLeaseExpiryRisk(lease: LeaseHandle): void {
    lease.armRisk(Math.max(0, lease.expiresAtMs - (this.input.limits.safetyMs ?? 0)));
  }

  private armRenewal(aggregateId: string, aggregate: Aggregate, dueAtMs: number): void {
    if (aggregate.fenced || (!aggregate.reconciliationNeeded && ![...aggregate.leases].some((lease) => !lease.isRisked()))) return;
    for (const lease of aggregate.leases) {
      const riskDeadline = lease.riskDeadline();
      if (!lease.isRisked() && riskDeadline !== undefined) dueAtMs = Math.min(dueAtMs, riskDeadline);
    }
    aggregate.renewalVersion += 1;
    aggregate.renewalDueAtMs = dueAtMs;
    this.maintenance.arm({ aggregateId, dueAtMs, version: aggregate.renewalVersion });
  }

  private trackAccount(accountId: string): boolean {
    const cap = this.input.limits.accountSweeperMaxAccounts ?? this.input.limits.localProcessCap;
    return this.maintenance.trackAccount(accountId, cap);
  }

  private markSweepDebt(accountId: string): void {
    this.maintenance.markDebt(accountId);
  }

  private recordPruneDebt(accountId: string, reply: ScriptReply): void {
    if (reply.hasMore === true) {
      this.markSweepDebt(accountId);
      this.schedule();
    }
    else if (reply.hasMore === false) this.clearSweepDebt(accountId);
  }

  private clearSweepDebt(accountId: string): void {
    this.maintenance.clearDebt(accountId);
    this.degradedMaintenanceAccounts.delete(accountId);
    this.refreshHealth();
  }

  private async sweepAccount(accountId: string): Promise<{ hasMore: boolean }> {
    try {
      const result = await this.input.redis.execute("admission.sweep", this.admissionKeys(accountId), [String(this.input.limits.cleanupLimit)]);
      const reply = this.decodeReply("admission.sweep", result);
      this.assertReply(reply);
      const hasMore = reply.hasMore === true;
      if (hasMore) this.markSweepDebt(accountId);
      else {
        this.clearSweepDebt(accountId);
        this.dropInactiveAccount(accountId);
      }
      this.degradedMaintenanceAccounts.delete(accountId);
      this.noteProviderSuccess();
      this.refreshHealth();
      return { hasMore };
    } catch {
      this.markSweepDebt(accountId);
      this.input.telemetry?.event("degraded");
      this.reconnectDegraded = true;
      this.degradedMaintenanceAccounts.add(accountId);
      this.refreshHealth();
      return { hasMore: true };
    }
  }

  private dropInactiveAccount(accountId: string): void {
    if ((this.accountAggregateCounts.get(accountId) ?? 0) === 0) this.maintenance.releaseAccount(accountId);
  }

  private fenceAggregate(aggregate: Aggregate): void {
    if (aggregate.fenced) return;
    aggregate.fenced = true;
    this.maintenance.cancel(aggregate.id);
    aggregate.transition.fence();
    aggregate.reconciliationNeeded = false;
    this.input.telemetry?.event("degraded");
    this.markAggregateDegraded(aggregate);
    const closeAtMs = this.now();
    for (const lease of aggregate.leases) {
      if (!lease.isRisked()) lease.riskNow("fenced", closeAtMs);
    }
  }
}
