import { AppError } from "../../../shared/domain/errors.js";
import type { AppLogger } from "../../../shared/observability/logger.js";
import type { MetricsRegistry } from "../../../shared/observability/metrics/metricsRegistry.js";
import type { ConversationTurnStage } from "../contracts/interruption.js";

export type { ConversationTurnStage } from "../contracts/interruption.js";

/**
 * Where the turn that cancelled this one runs: `local` for a disconnect or a newer turn on the same
 * process, `cross_instance` for a newer turn another process started.
 */
type ConversationTurnCancellationScope = "local" | "cross_instance";

interface ConversationTurnCancellation {
  conversationId: string;
  reason: "superseded" | "disconnect_timeout" | "lease_lost";
  stage: ConversationTurnStage;
  scope: ConversationTurnCancellationScope;
}

export interface ConversationTurnInterruptionObserver {
  turnCancelled(input: ConversationTurnCancellation): void;
  /**
   * A turn stopped waiting for its predecessor because the process that owned the predecessor
   * stopped renewing its lease (a crashed or stalled instance).
   */
  predecessorLeaseExpired?(input: { conversationId: string }): void;
}

interface ChatTurnSupersession {
  /** The turn had started emitting its reply; only a turn that supersedes after emission cancels one then. */
  afterEmission?: boolean;
  /**
   * Both turns supersede after emission, so the newer one carries the input that replaces this
   * turn's (a revised transcript). Any other newer turn, such as an approval resuming a routine,
   * only cancels it.
   */
  replacedByNewerInput?: boolean;
}

export class ChatTurnSupersededError extends AppError {
  readonly conversationId: string;
  readonly stage: ConversationTurnStage;
  readonly afterEmission: boolean;
  readonly replacedByNewerInput: boolean;

  constructor(conversationId: string, stage: ConversationTurnStage, supersession: ChatTurnSupersession = {}) {
    super(409, "chat_turn_superseded", "Chat turn was superseded by a newer message.", {
      conversationId,
      reason: "superseded",
      stage,
    });
    this.name = "ChatTurnSupersededError";
    this.conversationId = conversationId;
    this.stage = stage;
    this.afterEmission = supersession.afterEmission === true;
    this.replacedByNewerInput = supersession.replacedByNewerInput === true;
  }
}

/**
 * Raised when the presenter's post-disconnect ceiling (#885) cancels a turn that
 * never settled after the client went away. Distinct from `ChatTurnSupersededError`
 * (a newer message, not a lost client) so the generic failure path's audit trail
 * never mislabels a resource-protection abort as a user-driven interruption.
 */
export class ChatTurnDisconnectAbortError extends AppError {
  readonly conversationId: string;
  readonly stage: ConversationTurnStage;

  constructor(conversationId: string, stage: ConversationTurnStage) {
    super(
      500,
      "chat_turn_aborted_after_disconnect",
      "Chat turn aborted: the client disconnected and the turn did not settle within the presenter's ceiling.",
      { conversationId, reason: "disconnect_timeout", stage },
    );
    this.name = "ChatTurnDisconnectAbortError";
    this.conversationId = conversationId;
    this.stage = stage;
  }
}

/**
 * Raised when the turn's coordination lease expired before its process renewed it (a stalled or
 * partitioned process). A newer turn on the conversation no longer waits for an expired lease, so
 * this turn stops rather than run alongside it. Like a disconnect abort, it takes the generic
 * failure path: nothing about the conversation superseded it.
 */
export class ChatTurnLeaseLostError extends AppError {
  readonly conversationId: string;
  readonly stage: ConversationTurnStage;

  constructor(conversationId: string, stage: ConversationTurnStage) {
    super(
      500,
      "chat_turn_lease_lost",
      "Chat turn aborted: its conversation lease expired before it finished.",
      { conversationId, reason: "lease_lost", stage },
    );
    this.name = "ChatTurnLeaseLostError";
    this.conversationId = conversationId;
    this.stage = stage;
  }
}

export interface ConversationTurnLease {
  readonly conversationId: string;
  readonly signal: AbortSignal;
  waitForPredecessor(): Promise<void>;
  setStage(stage: ConversationTurnStage): void;
  throwIfCancelled(): void;
  beginEmission(): void;
  /**
   * Latches the turn for the commit of its stored reply, as the commit's last step: throws when
   * a newer turn already cancelled it, and from then on no newer turn cancels it, even one that
   * supersedes after emission; a newer turn waits for it instead. The latch a `latest_input_wins`
   * turn needs, since emission alone does not protect it.
   */
  beginCommit(): void;
  complete(): void;
  /**
   * Externally cancel this turn because the client disconnected and the
   * presenter's post-disconnect ceiling elapsed before it settled (#885).
   * Aborts the same signal already threaded into provider calls and
   * cooperative checkpoints, and reports through the same cancellation
   * observer supersession uses. The stream owner completes the lease when its
   * normal cleanup finishes.
   */
  cancelAfterDisconnect(): void;
}

export interface ConversationTurnLeaseOptions {
  /**
   * For a channel whose newest input overtakes the reply still being delivered (a caller who
   * speaks over the agent): a turn started with this cancels a predecessor started with it even
   * after the predecessor began emitting. Without it on both turns, a turn that began emitting runs
   * to completion and the newer turn waits for it.
   */
  supersedeAfterEmission?: boolean;
}

export interface ConversationTurnRegistry {
  start(conversationId: string, options?: ConversationTurnLeaseOptions): ConversationTurnLease;
}

export class LoggingConversationTurnInterruptionObserver implements ConversationTurnInterruptionObserver {
  constructor(
    private readonly logger: Pick<AppLogger, "info" | "warn">,
    private readonly metricsRegistry?: Pick<MetricsRegistry, "incrementCounter"> | null,
  ) {}

  turnCancelled(input: ConversationTurnCancellation): void {
    this.logger.info(
      {
        conversationId: input.conversationId,
        event: "chat_turn_cancelled",
        reason: input.reason,
        stage: input.stage,
        scope: input.scope,
      },
      "Chat turn cancelled",
    );
    this.metricsRegistry?.incrementCounter("chat_turn_cancellations_total", {
      help: "Total assistant chat turns cancelled before completion.",
      labels: {
        reason: input.reason,
        stage: input.stage,
        scope: input.scope,
      },
    });
  }

  predecessorLeaseExpired(input: { conversationId: string }): void {
    this.logger.warn(
      { conversationId: input.conversationId, event: "chat_turn_lease_expiry_takeover" },
      "Chat turn stopped waiting for a predecessor whose lease expired",
    );
    this.metricsRegistry?.incrementCounter("chat_turn_lease_expiry_takeovers_total", {
      help: "Total assistant chat turns that stopped waiting for a predecessor whose owning process stopped renewing its lease.",
    });
  }
}

interface ConversationTurnCoordination {
  waitForPredecessor(): Promise<void>;
  complete(): void;
}

/**
 * One turn's interruption state in the process that runs it: its abort signal, stage, and the
 * emission and commit latches. The latches and a newer turn's supersession both apply here,
 * synchronously, so whichever lands first wins; a registry decides only which turn is newer and
 * when a successor may run.
 */
export class ConversationTurnState {
  readonly finished: Promise<void>;
  private readonly controller = new AbortController();
  private stage: ConversationTurnStage = "waiting";
  private emissionStarted = false;
  private commitStarted = false;
  private completed = false;
  private resolveFinished!: () => void;

  constructor(
    readonly conversationId: string,
    readonly supersedeAfterEmission: boolean,
    private readonly observer?: ConversationTurnInterruptionObserver,
  ) {
    this.finished = new Promise<void>((resolve) => {
      this.resolveFinished = resolve;
    });
  }

  get isCompleted(): boolean {
    return this.completed;
  }

  /**
   * A newer turn started right behind this one. It cancels this turn until this turn starts
   * emitting, or, when both supersede after emission, until it begins committing its reply.
   */
  supersededBy(successor: ConversationTurnLeaseOptions, scope: ConversationTurnCancellationScope): void {
    if (this.completed || this.controller.signal.aborted || this.commitStarted) {
      return;
    }
    const replacedByNewerInput = this.supersedeAfterEmission && successor.supersedeAfterEmission === true;
    if (this.emissionStarted && !replacedByNewerInput) {
      return;
    }
    this.controller.abort(new ChatTurnSupersededError(this.conversationId, this.stage, {
      afterEmission: this.emissionStarted,
      replacedByNewerInput,
    }));
    this.observer?.turnCancelled({
      conversationId: this.conversationId,
      reason: "superseded",
      stage: this.stage,
      scope,
    });
  }

  /** The turn's lease expired before it was renewed; a successor may already be running. */
  leaseLost(): void {
    if (this.completed || this.controller.signal.aborted) {
      return;
    }
    this.controller.abort(new ChatTurnLeaseLostError(this.conversationId, this.stage));
    this.observer?.turnCancelled({
      conversationId: this.conversationId,
      reason: "lease_lost",
      stage: this.stage,
      scope: "local",
    });
  }

  /** Marks the turn finished and releases whoever waits for it; false when it already was. */
  complete(): boolean {
    if (this.completed) {
      return false;
    }
    this.completed = true;
    this.resolveFinished();
    return true;
  }

  lease(coordination: ConversationTurnCoordination): ConversationTurnLease {
    return {
      conversationId: this.conversationId,
      signal: this.controller.signal,
      waitForPredecessor: () => coordination.waitForPredecessor(),
      setStage: (stage) => {
        this.stage = stage;
      },
      throwIfCancelled: () => this.throwIfCancelled(),
      beginEmission: () => {
        this.throwIfCancelled();
        this.emissionStarted = true;
        this.stage = "persisting";
      },
      beginCommit: () => {
        this.throwIfCancelled();
        this.commitStarted = true;
      },
      complete: () => coordination.complete(),
      cancelAfterDisconnect: () => {
        if (this.completed || this.controller.signal.aborted) {
          return;
        }
        this.controller.abort(new ChatTurnDisconnectAbortError(this.conversationId, this.stage));
        this.observer?.turnCancelled({
          conversationId: this.conversationId,
          reason: "disconnect_timeout",
          stage: this.stage,
          scope: "local",
        });
      },
    };
  }

  private throwIfCancelled(): void {
    const signal = this.controller.signal;
    if (!signal.aborted) {
      return;
    }
    if (signal.reason instanceof Error) {
      throw signal.reason;
    }
    throw new ChatTurnSupersededError(this.conversationId, this.stage);
  }
}

/** Coordinates the turns of one process: correct only while every turn of a conversation runs in it. */
export class InMemoryConversationTurnRegistry implements ConversationTurnRegistry {
  private readonly active = new Map<string, ConversationTurnState>();

  constructor(private readonly observer?: ConversationTurnInterruptionObserver) {}

  start(conversationId: string, options: ConversationTurnLeaseOptions = {}): ConversationTurnLease {
    const predecessor = this.active.get(conversationId);
    const turn = new ConversationTurnState(conversationId, options.supersedeAfterEmission === true, this.observer);
    predecessor?.supersededBy(options, "local");
    this.active.set(conversationId, turn);

    return turn.lease({
      waitForPredecessor: () => predecessor?.finished ?? Promise.resolve(),
      complete: () => {
        if (turn.complete() && this.active.get(conversationId) === turn) {
          this.active.delete(conversationId);
        }
      },
    });
  }
}
