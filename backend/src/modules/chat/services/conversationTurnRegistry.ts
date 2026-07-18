import { AppError } from "../../../shared/domain/errors.js";
import type { AppLogger } from "../../../shared/observability/logger.js";
import type { MetricsRegistry } from "../../../shared/observability/metrics/metricsRegistry.js";
import type { ConversationTurnStage } from "../contracts/interruption.js";

export type { ConversationTurnStage } from "../contracts/interruption.js";

export interface ConversationTurnCancellation {
  conversationId: string;
  reason: "superseded";
  stage: ConversationTurnStage;
}

export interface ConversationTurnInterruptionObserver {
  turnCancelled(input: ConversationTurnCancellation): void;
}

export class ChatTurnSupersededError extends AppError {
  readonly conversationId: string;
  readonly stage: ConversationTurnStage;

  constructor(conversationId: string, stage: ConversationTurnStage) {
    super(409, "chat_turn_superseded", "Chat turn was superseded by a newer message.", {
      conversationId,
      reason: "superseded",
      stage,
    });
    this.name = "ChatTurnSupersededError";
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
  complete(): void;
}

export interface ConversationTurnRegistry {
  start(conversationId: string): ConversationTurnLease;
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
      help: "Total assistant chat turns cancelled by a newer message.",
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
  finished: Promise<void>;
  finish: () => void;
  stage: ConversationTurnStage;
}

const createActiveTurn = (conversationId: string): ActiveTurn => {
  let finish!: () => void;
  const finished = new Promise<void>((resolve) => {
    finish = resolve;
  });
  return {
    controller: new AbortController(),
    conversationId,
    emissionStarted: false,
    finished,
    finish,
    stage: "waiting",
  };
};

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

  start(conversationId: string): ConversationTurnLease {
    const predecessor = this.active.get(conversationId);
    if (predecessor && !predecessor.emissionStarted && !predecessor.controller.signal.aborted) {
      const cancellation = new ChatTurnSupersededError(conversationId, predecessor.stage);
      predecessor.controller.abort(cancellation);
      this.observer?.turnCancelled({
        conversationId,
        reason: "superseded",
        stage: predecessor.stage,
      });
    }

    const turn = createActiveTurn(conversationId);
    this.active.set(conversationId, turn);
    let completed = false;

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
      complete: () => {
        if (completed) {
          return;
        }
        completed = true;
        turn.finish();
        if (this.active.get(conversationId) === turn) {
          this.active.delete(conversationId);
        }
      },
    };
  }
}
