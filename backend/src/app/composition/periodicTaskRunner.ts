import type { AppLogger } from "../../shared/observability/logger.js";

/** Upper bound on how long `stop()` waits for an in-flight run before returning anyway. A
 *  hung run (a stalled mail call, say) must not block process shutdown forever. */
const DEFAULT_STOP_GRACE_MS = 10_000;

/**
 * Drives one `ApplicationPeriodicTaskRegistration` on a timer. Mirrors
 * `CredentialExpiryWarningService` (`backend/src/modules/machineAccess/services/
 * credentialExpiryWarningService.ts`) with one deliberate difference: `start()` schedules the
 * first run and returns without waiting for it, so a backlog or a hung call on that first run
 * never blocks `startApiRuntime`'s call to `listen()` (and therefore a platform readiness
 * probe). Otherwise the same shape: run on the configured interval; never overlap a run with
 * the previous one still in flight; `unref()` the timer so it never holds the process open; a
 * throwing run is logged and never crashes the process; `stop()` stops scheduling and waits for
 * any in-flight run to finish, bounded by `stopGraceMs`.
 */
interface PeriodicTaskRunnerOptions {
  id: string;
  intervalMs: number;
  run(): Promise<void>;
  logger: Pick<AppLogger, "error">;
  stopGraceMs?: number;
}

export class PeriodicTaskRunner {
  private timer: ReturnType<typeof setInterval> | null = null;
  private current: Promise<void> | null = null;

  constructor(private readonly options: PeriodicTaskRunnerOptions) {}

  async start(): Promise<void> {
    if (this.timer) {
      return;
    }
    void this.tick();
    this.timer = setInterval(() => {
      void this.tick();
    }, this.options.intervalMs);
    this.timer.unref?.();
  }

  async stop(): Promise<void> {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    if (!this.current) {
      return;
    }
    const graceMs = this.options.stopGraceMs ?? DEFAULT_STOP_GRACE_MS;
    let graceTimer: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([
        this.current,
        new Promise<void>((resolve) => {
          graceTimer = setTimeout(resolve, graceMs);
        }),
      ]);
    } finally {
      clearTimeout(graceTimer);
    }
  }

  private async tick(): Promise<void> {
    if (this.current) {
      return;
    }
    this.current = this.runSafely();
    try {
      await this.current;
    } finally {
      this.current = null;
    }
  }

  private async runSafely(): Promise<void> {
    try {
      await this.options.run();
    } catch (error) {
      this.options.logger.error({ taskId: this.options.id, err: error }, "Periodic task failed");
    }
  }
}

export interface PeriodicTasksLifecycle {
  start(): Promise<void>;
  stop(): Promise<void>;
}

/** Aggregates every registered periodic task behind one start/stop pair, mirroring the shape
 *  of the other single-lifecycle objects (`credentialExpiryWarningLifecycle`,
 *  `realtimePublisherLifecycle`) `startApiRuntime.ts` already drives. */
export const createPeriodicTasksLifecycle = (tasks: readonly PeriodicTaskRunner[]): PeriodicTasksLifecycle => ({
  async start() {
    await Promise.all(tasks.map((task) => task.start()));
  },
  async stop() {
    await Promise.all(tasks.map((task) => task.stop()));
  },
});
