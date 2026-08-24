import {
  protocolVersion,
  workspaceInvalidationEnvelopeSchema,
  type EnqueueResult,
  type WorkspaceInvalidationKind,
  type WorkspaceInvalidationPublisher,
} from "@radioso/workspace-invalidation-contract";
import type { WorkspaceInvalidationTransport } from "../domain/contracts.js";

interface PendingEntry {
  workspaceId: string;
  kinds: Set<WorkspaceInvalidationKind>;
  eligibleAt: number;
  cooldownExpiresAt: number;
  publishing: boolean;
}

export interface BoundedInvalidationProducerOptions {
  maxPendingWorkspaces?: number;
  flushBatchSize?: number;
  publishConcurrency?: number;
  cadenceMs?: number;
  publishTimeoutMs?: number;
  shutdownTimeoutMs?: number;
}

export interface BoundedInvalidationProducerTelemetry {
  enqueue(outcome: "accepted" | "coalesced" | "dropped"): void;
  publish(outcome: "accepted" | "failed"): void;
  queueDepth(pendingWorkspaces: number, saturated: boolean): void;
  flush(
    input: { batchSize: number; pendingWorkspaces: number },
    run: () => Promise<{ attempted: number; failed: number }>,
  ): Promise<{ attempted: number; failed: number }>;
}

const defaults: Required<BoundedInvalidationProducerOptions> = {
  maxPendingWorkspaces: 4096,
  flushBatchSize: 256,
  publishConcurrency: 32,
  cadenceMs: 100,
  publishTimeoutMs: 2_000,
  shutdownTimeoutMs: 8_000,
};

/** Only this bounded scheduler awaits transient transport; mutation callers never do. */
export class BoundedInvalidationProducer implements WorkspaceInvalidationPublisher {
  private readonly options: Required<BoundedInvalidationProducerOptions>;
  private readonly pending = new Map<string, PendingEntry>();
  private timer: NodeJS.Timeout | undefined;
  private stopping = false;
  private flushing: Promise<void> | undefined;
  private shutdownPromise: Promise<void> | undefined;
  private readonly activePublishes = new Set<AbortController>();

  constructor(private readonly input: {
    transport: WorkspaceInvalidationTransport;
    options?: BoundedInvalidationProducerOptions;
    now?: () => number;
    telemetry?: BoundedInvalidationProducerTelemetry;
  }) {
    this.options = { ...defaults, ...input.options };
    const positiveOptions = Object.values(this.options);
    if (positiveOptions.some((value) => !Number.isFinite(value) || value <= 0)) {
      throw new Error("producer options must be positive finite numbers");
    }
    if (![this.options.maxPendingWorkspaces, this.options.flushBatchSize, this.options.publishConcurrency].every(Number.isInteger)) {
      throw new Error("producer capacity options must be integers");
    }
    if (this.options.publishConcurrency > this.options.flushBatchSize || this.options.flushBatchSize > this.options.maxPendingWorkspaces) {
      throw new Error("producer concurrency must not exceed batch or pending capacity");
    }
  }

  enqueue(workspaceId: string, changeKinds: readonly WorkspaceInvalidationKind[]): EnqueueResult {
    if (this.stopping) return { accepted: false, reason: "shutdown" };
    if (!this.isValid(workspaceId, changeKinds)) {
      this.input.telemetry?.enqueue("dropped");
      return { accepted: false, reason: "invalid" };
    }

    const existing = this.pending.get(workspaceId);
    if (existing) {
      const priorCount = existing.kinds.size;
      for (const kind of changeKinds) existing.kinds.add(kind);
      const coalesced = priorCount > 0 || existing.publishing || existing.kinds.size === priorCount;
      this.input.telemetry?.enqueue(coalesced ? "coalesced" : "accepted");
      this.reportQueueDepth();
      this.arm();
      return { accepted: true, coalesced };
    }
    if (this.pending.size >= this.options.maxPendingWorkspaces) {
      this.input.telemetry?.enqueue("dropped");
      this.reportQueueDepth();
      return { accepted: false, reason: "capacity" };
    }

    const now = this.now();
    this.pending.set(workspaceId, {
      workspaceId,
      kinds: new Set(changeKinds),
      eligibleAt: now,
      cooldownExpiresAt: now,
      publishing: false,
    });
    this.input.telemetry?.enqueue("accepted");
    this.reportQueueDepth();
    this.arm();
    return { accepted: true, coalesced: false };
  }

  flushNow(input: { force?: boolean } = {}): Promise<void> {
    if (this.flushing) return this.flushing;
    this.flushing = this.flush(input.force ?? true).finally(() => { this.flushing = undefined; });
    return this.flushing;
  }

  shutdown(): Promise<void> {
    if (this.shutdownPromise) return this.shutdownPromise;
    this.stopping = true;
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
    this.shutdownPromise = this.stopAndDrain();
    return this.shutdownPromise;
  }

  debugState(): { pendingWorkspaces: number; scheduledTimers: number } {
    return { pendingWorkspaces: this.pending.size, scheduledTimers: this.timer ? 1 : 0 };
  }

  private isValid(workspaceId: string, kinds: readonly WorkspaceInvalidationKind[]): boolean {
    return workspaceInvalidationEnvelopeSchema.safeParse({ protocolVersion, workspaceId, changeKinds: kinds }).success;
  }

  private now(): number {
    return this.input.now?.() ?? Date.now();
  }

  private arm(): void {
    if (this.stopping || this.timer) return;
    let next: number | undefined;
    for (const entry of this.pending.values()) {
      if (entry.publishing) continue;
      const deadline = entry.kinds.size > 0 ? entry.eligibleAt : entry.cooldownExpiresAt;
      next = next === undefined ? deadline : Math.min(next, deadline);
    }
    if (next === undefined) return;
    this.timer = setTimeout(() => {
      this.timer = undefined;
      if (!this.stopping) void this.flushNow({ force: false });
    }, Math.max(0, next - this.now()));
  }

  private async stopAndDrain(): Promise<void> {
    const deadline = Date.now() + this.options.shutdownTimeoutMs;
    const abortAtDeadline = setTimeout(() => {
      for (const controller of this.activePublishes) controller.abort();
    }, this.options.shutdownTimeoutMs);
    try {
      await this.flushing;
      while (this.hasPublishableEntries() && Date.now() < deadline) {
        await this.flush(true, deadline);
      }
    } finally {
      clearTimeout(abortAtDeadline);
      for (const controller of this.activePublishes) controller.abort();
      this.pending.clear();
      this.reportQueueDepth();
    }
  }

  private hasPublishableEntries(): boolean {
    return [...this.pending.values()].some((entry) => entry.kinds.size > 0 || entry.publishing);
  }

  private async flush(force: boolean, deadline?: number): Promise<void> {
    const now = this.now();
    for (const [workspaceId, entry] of this.pending) {
      if (!entry.publishing && entry.kinds.size === 0 && entry.cooldownExpiresAt <= now) this.pending.delete(workspaceId);
    }
    const ready = [...this.pending.values()]
      .filter((entry) => !entry.publishing && entry.kinds.size > 0 && (force || entry.eligibleAt <= now))
      .slice(0, this.options.flushBatchSize);
    this.reportQueueDepth();
    if (ready.length === 0) {
      if (!this.stopping) this.arm();
      return;
    }

    const publishBatch = async () => {
      let next = 0;
      let attempted = 0;
      let failed = 0;
      const worker = async () => {
        while (
          next < ready.length
          && (!deadline || Date.now() < deadline)
          && (deadline !== undefined || !this.stopping)
        ) {
          const entry = ready[next++];
          if (!entry) continue;
          attempted += 1;
          if (!await this.publishEntry(entry, deadline)) failed += 1;
        }
      };
      await Promise.all(Array.from({ length: Math.min(this.options.publishConcurrency, ready.length) }, worker));
      return { attempted, failed };
    };

    if (this.input.telemetry) {
      await this.input.telemetry.flush(
        { batchSize: ready.length, pendingWorkspaces: this.pending.size },
        publishBatch,
      );
    } else {
      await publishBatch();
    }
    if (!this.stopping) this.arm();
  }

  private async publishEntry(entry: PendingEntry, deadline?: number): Promise<boolean> {
    entry.publishing = true;
    const changeKinds = [...entry.kinds];
    entry.kinds.clear();
    const controller = new AbortController();
    this.activePublishes.add(controller);
    const timeoutMs = Math.max(0, Math.min(this.options.publishTimeoutMs, deadline ? deadline - Date.now() : this.options.publishTimeoutMs));
    try {
      await this.abortAfter(this.input.transport.publish({ protocolVersion, workspaceId: entry.workspaceId, changeKinds }, { signal: controller.signal }), timeoutMs, controller);
      this.input.telemetry?.publish("accepted");
      return true;
    } catch {
      this.input.telemetry?.publish("failed");
      return false;
    } finally {
      this.activePublishes.delete(controller);
      entry.publishing = false;
      const now = this.now();
      entry.eligibleAt = now + this.options.cadenceMs;
      entry.cooldownExpiresAt = entry.eligibleAt;
    }
  }

  private abortAfter(operation: Promise<void>, timeoutMs: number, controller: AbortController): Promise<void> {
    return new Promise((resolve, reject) => {
      const finish = (result: () => void) => {
        clearTimeout(timer);
        controller.signal.removeEventListener("abort", onAbort);
        result();
      };
      const onAbort = () => finish(() => reject(new Error("realtime publish aborted")));
      const timer = setTimeout(() => {
        controller.abort();
      }, timeoutMs);
      controller.signal.addEventListener("abort", onAbort, { once: true });
      void operation.then(
        () => finish(resolve),
        (error: unknown) => finish(() => reject(error)),
      );
    });
  }

  private reportQueueDepth(): void {
    this.input.telemetry?.queueDepth(
      this.pending.size,
      this.pending.size >= this.options.maxPendingWorkspaces,
    );
  }
}
