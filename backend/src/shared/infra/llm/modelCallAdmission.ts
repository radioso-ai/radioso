import { AppError } from "../../domain/errors.js";
import { abortReasonOf } from "./providerTimeouts.js";

/**
 * Which budget a model call draws on. `turn` is a call a conversation turn waits on; `deferrable`
 * is work a turn starts but never waits on (a shadow assessment, best-effort action chips). They
 * are separate budgets, so deferrable work can never hold a permit a turn needs.
 */
export type ModelCallLane = "turn" | "deferrable";

/** Why a call was refused a permit. Bounded, for metric labels and logs. */
export type ModelCallShedReason = "queue_timeout" | "lane_full" | "abandoned";

/**
 * A model call this instance refused to start because its lane was at capacity. A typed
 * `503` the caller's existing failure path renders; an expected outcome of load shedding, so
 * the shed counter and its log line report it rather than error tracking.
 */
export class ModelCallShedError extends AppError {
  readonly lane: ModelCallLane;
  readonly reason: ModelCallShedReason;

  constructor(lane: ModelCallLane, reason: ModelCallShedReason) {
    super(
      503,
      "model_capacity_busy",
      "Model call capacity on this instance is exhausted; the call was not started.",
      { lane, reason },
      { isExpectedOutcome: true },
    );
    this.name = "ModelCallShedError";
    this.lane = lane;
    this.reason = reason;
  }
}

export interface ModelCallAdmissionLimits {
  /** Most calls the turn lane may have in flight on this instance. */
  readonly maxConcurrentTurnCalls: number;
  /** Most calls the deferrable lane may have in flight on this instance. */
  readonly maxConcurrentDeferrableCalls: number;
  /** How long a turn call waits for a free permit before it is shed. A deferrable call never waits. */
  readonly maxQueueWaitMs: number;
}

/** Observability sinks; never control flow. */
export interface ModelCallAdmissionObserver {
  inFlight(lane: ModelCallLane, count: number): void;
  /** A turn call that waited for its permit and got one. */
  queued(lane: ModelCallLane, waitMs: number): void;
  shed(lane: ModelCallLane, reason: ModelCallShedReason): void;
}

interface ModelCallAdmissionRequest {
  readonly lane: ModelCallLane;
  /** The call's own cancellation; a queued call leaves the queue with the signal's reason. */
  readonly signal?: AbortSignal;
  /**
   * Fires when nobody is waiting for the turn's answer any more (the visitor's connection
   * closed). An abandoned turn still gets a free permit, but never queues for one.
   */
  readonly abandoned?: AbortSignal;
}

/** Gives the permit back. Idempotent. */
export type ReleaseModelCallPermit = () => void;

interface Waiter {
  grant(): void;
}

/**
 * A per-instance cap on in-flight model calls, one budget per lane. A turn call over its cap
 * waits up to `maxQueueWaitMs` in arrival order and is then shed; a deferrable call over its
 * cap is shed at once. A freed permit goes straight to the longest-waiting call.
 */
export class ModelCallAdmission {
  private readonly inFlightByLane: Record<ModelCallLane, number> = { turn: 0, deferrable: 0 };
  private readonly turnWaiters: Waiter[] = [];

  constructor(
    private readonly limits: ModelCallAdmissionLimits,
    private readonly observer?: ModelCallAdmissionObserver,
    private readonly now: () => number = Date.now,
  ) {}

  acquire(request: ModelCallAdmissionRequest): Promise<ReleaseModelCallPermit> {
    const { lane } = request;
    if (request.signal?.aborted) {
      return Promise.reject(abortReasonOf(request.signal));
    }
    if (this.inFlightByLane[lane] < this.capacityOf(lane)) {
      this.setInFlight(lane, this.inFlightByLane[lane] + 1);
      return Promise.resolve(this.permit(lane));
    }
    if (lane === "deferrable") {
      return Promise.reject(this.shed(lane, "lane_full"));
    }
    if (request.abandoned?.aborted) {
      return Promise.reject(this.shed(lane, "abandoned"));
    }
    return this.enqueueTurnCall(request);
  }

  private enqueueTurnCall(request: ModelCallAdmissionRequest): Promise<ReleaseModelCallPermit> {
    return new Promise((resolve, reject) => {
      const enqueuedAt = this.now();
      const leave = (error: Error) => {
        cleanup();
        const index = this.turnWaiters.indexOf(waiter);
        if (index >= 0) {
          this.turnWaiters.splice(index, 1);
        }
        reject(error);
      };
      const onAbort = () => leave(abortReasonOf(request.signal!));
      const onAbandoned = () => leave(this.shed("turn", "abandoned"));
      const timer = setTimeout(() => leave(this.shed("turn", "queue_timeout")), this.limits.maxQueueWaitMs);
      const cleanup = () => {
        clearTimeout(timer);
        request.signal?.removeEventListener("abort", onAbort);
        request.abandoned?.removeEventListener("abort", onAbandoned);
      };
      const waiter: Waiter = {
        grant: () => {
          cleanup();
          this.observer?.queued("turn", this.now() - enqueuedAt);
          resolve(this.permit("turn"));
        },
      };
      request.signal?.addEventListener("abort", onAbort, { once: true });
      request.abandoned?.addEventListener("abort", onAbandoned, { once: true });
      this.turnWaiters.push(waiter);
    });
  }

  private permit(lane: ModelCallLane): ReleaseModelCallPermit {
    let released = false;
    return () => {
      if (released) {
        return;
      }
      released = true;
      const next = lane === "turn" ? this.turnWaiters.shift() : undefined;
      if (next) {
        // The permit passes straight to the waiter, so the lane's count is unchanged.
        next.grant();
        return;
      }
      this.setInFlight(lane, this.inFlightByLane[lane] - 1);
    };
  }

  private capacityOf(lane: ModelCallLane): number {
    return lane === "turn" ? this.limits.maxConcurrentTurnCalls : this.limits.maxConcurrentDeferrableCalls;
  }

  private setInFlight(lane: ModelCallLane, count: number): void {
    this.inFlightByLane[lane] = count;
    this.observer?.inFlight(lane, count);
  }

  private shed(lane: ModelCallLane, reason: ModelCallShedReason): ModelCallShedError {
    this.observer?.shed(lane, reason);
    return new ModelCallShedError(lane, reason);
  }
}
