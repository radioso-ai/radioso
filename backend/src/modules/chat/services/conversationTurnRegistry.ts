import { AppError } from "../../../shared/domain/errors.js";
import type { AppLogger } from "../../../shared/observability/logger.js";
import type { MetricsRegistry } from "../../../shared/observability/metrics/metricsRegistry.js";
import type { ConversationTurnStage } from "../contracts/interruption.js";

export type { ConversationTurnStage } from "../contracts/interruption.js";

interface ConversationTurnCancellation {
  conversationId: string;
  reason: "superseded" | "disconnect_timeout";
  stage: ConversationTurnStage;
}

interface ConversationTurnInterruptionObserver {
  turnCancelled(input: ConversationTurnCancellation): void;
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
      // A lost client, not a platform fault: its 500 status is for the (nonexistent)
      // caller, not a signal that something on this side broke.
      { isExpectedOutcome: true },
    );
    this.name = "ChatTurnDisconnectAbortError";
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
    private readonly logger: Pick<AppLogger, "info">,
    private readonly metricsRegistry?: Pick<MetricsRegistry, "incrementCounter"> | null,
  ) {}

  turnCancelled(input: ConversationTurnCancellation): void {
    this.logger.info(
      {
        conversationId: input.conversationId,
        event: "chat_turn_cancelled",
        reason: input.reason,
        stage: input.stage,
      },
      "Chat turn cancelled",
    );
    this.metricsRegistry?.incrementCounter("chat_turn_cancellations_total", {
      help: "Total assistant chat turns cancelled before completion.",
      labels: {
        reason: input.reason,
        stage: input.stage,
      },
    });
  }
}

interface ActiveTurn {
  controller: AbortController;
  conversationId: string;
  emissionStarted: boolean;
  commitStarted: boolean;
  supersedeAfterEmission: boolean;
  finished: Promise<void>;
  finish: () => void;
  stage: ConversationTurnStage;
}

const createActiveTurn = (conversationId: string, options: ConversationTurnLeaseOptions): ActiveTurn => {
  let finish!: () => void;
  const finished = new Promise<void>((resolve) => {
    finish = resolve;
  });
  return {
    controller: new AbortController(),
    conversationId,
    emissionStarted: false,
    commitStarted: false,
    supersedeAfterEmission: options.supersedeAfterEmission === true,
    finished,
    finish,
    stage: "waiting",
  };
};

/**
 * A newer turn cancels its predecessor until it starts emitting, or, when both agree, until it
 * begins committing its reply.
 */
const supersedes = (predecessor: ActiveTurn, successor: ActiveTurn): boolean =>
  !predecessor.controller.signal.aborted
  && !predecessor.commitStarted
  && (!predecessor.emissionStarted || (predecessor.supersedeAfterEmission && successor.supersedeAfterEmission));

const throwSignalReason = (turn: ActiveTurn): void => {
  if (!turn.controller.signal.aborted) {
    return;
  }
  const reason = turn.controller.signal.reason;
  if (reason instanceof Error) {
    throw reason;
  }
  throw new ChatTurnSupersededError(turn.conversationId, turn.stage);
};

export class InMemoryConversationTurnRegistry implements ConversationTurnRegistry {
  private readonly active = new Map<string, ActiveTurn>();

  constructor(private readonly observer?: ConversationTurnInterruptionObserver) {}

  start(conversationId: string, options: ConversationTurnLeaseOptions = {}): ConversationTurnLease {
    const predecessor = this.active.get(conversationId);
    const turn = createActiveTurn(conversationId, options);
    if (predecessor && supersedes(predecessor, turn)) {
      const cancellation = new ChatTurnSupersededError(conversationId, predecessor.stage, {
        afterEmission: predecessor.emissionStarted,
        replacedByNewerInput: predecessor.supersedeAfterEmission && turn.supersedeAfterEmission,
      });
      predecessor.controller.abort(cancellation);
      this.observer?.turnCancelled({
        conversationId,
        reason: "superseded",
        stage: predecessor.stage,
      });
    }

    this.active.set(conversationId, turn);
    let completed = false;
    const complete = () => {
      if (completed) {
        return;
      }
      completed = true;
      turn.finish();
      if (this.active.get(conversationId) === turn) {
        this.active.delete(conversationId);
      }
    };

    return {
      conversationId,
      signal: turn.controller.signal,
      waitForPredecessor: () => predecessor?.finished ?? Promise.resolve(),
      setStage(stage) {
        turn.stage = stage;
      },
      throwIfCancelled() {
        throwSignalReason(turn);
      },
      beginEmission() {
        throwSignalReason(turn);
        turn.emissionStarted = true;
        turn.stage = "persisting";
      },
      beginCommit() {
        throwSignalReason(turn);
        turn.commitStarted = true;
      },
      complete,
      cancelAfterDisconnect: () => {
        if (completed || turn.controller.signal.aborted) {
          return;
        }
        turn.controller.abort(new ChatTurnDisconnectAbortError(conversationId, turn.stage));
        this.observer?.turnCancelled({
          conversationId,
          reason: "disconnect_timeout",
          stage: turn.stage,
        });
      },
    };
  }
}
