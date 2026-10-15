import type { AppLogger } from "../../../shared/observability/logger.js";
import {
  ConversationTurnState,
  type ConversationTurnInterruptionObserver,
  type ConversationTurnLease,
  type ConversationTurnLeaseOptions,
  type ConversationTurnRegistry,
} from "./conversationTurnRegistry.js";

/**
 * A turn's place in its conversation. Turn ids grow in the order the store places a conversation's
 * turns, so every older turn of the conversation has a lower id.
 */
interface ConversationTurnLeaseGrant {
  turnId: string;
  /** Another process may hold a live lease on an older turn of the conversation. */
  remoteAhead: boolean;
  /** Another process's lease on an older turn of the conversation has expired. */
  expiredAhead: boolean;
}

/** A turn that started, as every process hears of it. */
export interface ConversationTurnStarted {
  conversationId: string;
  turnId: string;
  supersedeAfterEmission: boolean;
  ownerInstanceId: string;
}

export type ConversationTurnNotice =
  | ({ kind: "started" } & ConversationTurnStarted)
  | { kind: "ended"; conversationId: string; turnId: string };

interface ConversationTurnRef {
  turnId: string;
  conversationId: string;
}

/**
 * Where the conversation's turns are ordered and their leases held, shared by every process.
 * Starting and ending a turn announce it on the matching notice source.
 */
export interface ConversationTurnLeaseStore {
  /** Places a new turn after the conversation's latest one, records its lease, and announces it. */
  begin(input: {
    conversationId: string;
    ownerInstanceId: string;
    supersedeAfterEmission: boolean;
    leaseTtlMs: number;
  }): Promise<ConversationTurnLeaseGrant>;
  /** Releases a finished turn's lease and announces that it ended. */
  end(input: ConversationTurnRef): Promise<void>;
  /**
   * Extends the leases this process holds that are still live; resolves with the ones it no longer
   * holds. Expiry is final: an expired lease is never extended again, since successors have
   * stopped waiting for it. Also drops a bounded batch of leases long expired, never waiting on a
   * row another statement holds.
   */
  renew(input: { ownerInstanceId: string; turnIds: string[]; leaseTtlMs: number }): Promise<string[]>;
  /** Best effort: drops this conversation's leases long expired, and its head if it points at one. */
  pruneExpired(conversationId: string): Promise<void>;
  /**
   * For each turn, whether a process other than `ownerInstanceId` still holds a live lease on an
   * older turn of its conversation, and whether one holds an expired lease there.
   */
  aheadOf(turns: ConversationTurnRef[], ownerInstanceId: string): Promise<Map<string, { live: boolean; expired: boolean }>>;
  /** The turn started right after each of these, to catch up on announcements missed while not listening. */
  successorsOf(turns: ConversationTurnRef[]): Promise<ConversationTurnStarted[]>;
}

interface ConversationTurnNoticeHandlers {
  notice(notice: ConversationTurnNotice): void;
  /** Notices are heard from now on; anything announced before may have been missed. */
  listening(): void;
  /** Notices stopped arriving until the next `listening`. */
  interrupted(): void;
}

/** Wakes this process when a turn starts or ends anywhere; the store stays the truth. */
export interface ConversationTurnNoticeSource {
  subscribe(handlers: ConversationTurnNoticeHandlers): () => void;
}

interface CrossInstanceTimings {
  /** How long a lease lasts without renewal before successors stop waiting for its turn. */
  leaseTtlMs: number;
  heartbeatIntervalMs: number;
  /** How often a waiting turn rechecks the store, should a notice be missed or a lease expire. */
  predecessorPollIntervalMs: number;
  /** First delay before retrying a failed catch-up; it doubles up to `CATCH_UP_RETRY_MAX_MS`. */
  catchUpRetryInitialMs: number;
}

const DEFAULT_TIMINGS: CrossInstanceTimings = {
  leaseTtlMs: 30_000,
  heartbeatIntervalMs: 10_000,
  predecessorPollIntervalMs: 1_000,
  catchUpRetryInitialMs: 250,
};

const CATCH_UP_RETRY_MAX_MS = 5_000;
const END_RETRY_DELAYS_MS: readonly number[] = [250, 1_000];

/**
 * The watchdog gives a lease up this much before it would expire in the store, measured from when
 * the statement that granted or renewed it was sent, so a stalled or cut-off owner stops before a
 * successor can take over.
 */
const leaseSafetyMarginMs = (leaseTtlMs: number): number => Math.min(2_000, leaseTtlMs / 5);

interface CrossInstanceConversationTurnRegistryOptions {
  /** Unique per process; names the owner of each lease this process holds. */
  instanceId: string;
  leases: ConversationTurnLeaseStore;
  notices: ConversationTurnNoticeSource;
  observer?: ConversationTurnInterruptionObserver;
  logger?: Pick<AppLogger, "warn">;
  timings?: Partial<CrossInstanceTimings>;
}

interface LocalTurn {
  readonly state: ConversationTurnState;
  readonly conversationId: string;
  turnId?: string;
  /** Resolves once no other process holds a live lease on an older turn of the conversation. */
  remoteClear?: Promise<void>;
  watchdog?: NodeJS.Timeout;
  ending: boolean;
}

interface RemoteWaiter {
  turn: LocalTurn;
  settle(): void;
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => {
  setTimeout(resolve, ms).unref();
});

/**
 * Coordinates a conversation's turns across every process that runs them. The lease store orders
 * the turns and holds their leases; notices wake the processes involved.
 *
 * A turn runs once every older turn of its conversation has finished: this process's own older
 * turns by their completion, other processes' by their leases ending or expiring in the store.
 * A newer turn supersedes this process's own turn of the conversation inside `start`, exactly as
 * the in-memory registry does. A turn another process runs is superseded by that process once the
 * newer turn's announcement reaches it, against the turn's own latches: the commit latch stays
 * synchronous and wins or loses atomically, and a latch set before the announcement arrives (about
 * one database round trip) stands, with the newer turn waiting for it.
 */
export class CrossInstanceConversationTurnRegistry implements ConversationTurnRegistry {
  private readonly instanceId: string;
  private readonly leases: ConversationTurnLeaseStore;
  private readonly notices: ConversationTurnNoticeSource;
  private readonly observer?: ConversationTurnInterruptionObserver;
  private readonly logger?: Pick<AppLogger, "warn">;
  private readonly timings: CrossInstanceTimings;

  /** Each conversation's turns in flight in this process, oldest first. */
  private readonly inFlight = new Map<string, LocalTurn[]>();
  /** Turns holding a lease, by turn id, until their end is recorded. */
  private readonly leased = new Map<string, LocalTurn>();
  /** Notices heard for a conversation while one of its turns here was still taking its place. */
  private readonly heldNotices = new Map<string, ConversationTurnNotice[]>();
  private readonly registering = new Map<string, number>();
  /** Each conversation's last registration here, so turns started in this process keep their call order. */
  private readonly registrationTails = new Map<string, Promise<void>>();
  /** Turns waiting for another process's older turn, by their own turn id. */
  private readonly remoteWaiters = new Map<string, RemoteWaiter>();

  private unsubscribe: (() => void) | null = null;
  private listening = false;
  /** Advances whenever notices may have been missed. */
  private noticeEpoch = 0;
  private heartbeatTimer: NodeJS.Timeout | null = null;
  private pollTimer: NodeJS.Timeout | null = null;
  private renewing = false;
  private checking = false;
  private checkRequested = false;
  private catchUpRunning = false;
  private catchUpRequested = false;
  private closed = false;

  constructor(options: CrossInstanceConversationTurnRegistryOptions) {
    this.instanceId = options.instanceId;
    this.leases = options.leases;
    this.notices = options.notices;
    this.observer = options.observer;
    this.logger = options.logger;
    this.timings = { ...DEFAULT_TIMINGS, ...options.timings };
  }

  start(conversationId: string, options: ConversationTurnLeaseOptions = {}): ConversationTurnLease {
    const state = new ConversationTurnState(conversationId, options.supersedeAfterEmission === true, this.observer);
    const turn: LocalTurn = { state, conversationId, ending: false };

    // Before any I/O, so this process's own predecessor can never latch behind a newer start.
    const older = [...(this.inFlight.get(conversationId) ?? [])];
    older.at(-1)?.state.supersededBy(options, "local");
    this.inFlight.set(conversationId, [...older, turn]);

    this.subscribe();
    this.registering.set(conversationId, (this.registering.get(conversationId) ?? 0) + 1);
    const previous = this.registrationTails.get(conversationId) ?? Promise.resolve();
    const registration = previous.then(() => this.register(turn));
    const tail = registration.catch(() => undefined);
    this.registrationTails.set(conversationId, tail);
    void tail.then(() => {
      if (this.registrationTails.get(conversationId) === tail) {
        this.registrationTails.delete(conversationId);
      }
    });

    let waiting: Promise<void> | undefined;
    return state.lease({
      waitForPredecessor: () => {
        waiting ??= registration.then(async () => {
          await Promise.all([...older.map((predecessor) => predecessor.state.finished), turn.remoteClear]);
        });
        return waiting;
      },
      complete: () => this.complete(turn),
    });
  }

  /** Stops renewing leases and listening; turns still in flight keep running on their own. */
  close(): void {
    this.closed = true;
    this.clearTimer("heartbeat");
    this.clearTimer("poll");
    this.unsubscribe?.();
    this.unsubscribe = null;
    this.listening = false;
  }

  private async register(turn: LocalTurn): Promise<void> {
    try {
      // Not waiting for the notice connection: when it was not listening yet, the turn catches up
      // from the store once it is, which costs a query only then and no latency on the turn.
      const heardFromIssue = this.listening;
      const epochAtIssue = this.noticeEpoch;
      const sentAt = performance.now();
      const grant = await this.leases.begin({
        conversationId: turn.conversationId,
        ownerInstanceId: this.instanceId,
        supersedeAfterEmission: turn.state.supersedeAfterEmission,
        leaseTtlMs: this.timings.leaseTtlMs,
      });
      this.admit(turn, grant, sentAt);
      if (!heardFromIssue || epochAtIssue !== this.noticeEpoch) {
        // A turn right after this one may have been announced while nothing listened.
        this.requestCatchUp();
      }
      if (grant.expiredAhead) {
        void this.leases.pruneExpired(turn.conversationId).catch((error: unknown) => {
          this.warn("conversation_turn_prune_failed", error);
        });
      }
    } finally {
      this.doneRegistering(turn.conversationId);
      this.releaseSubscriptionWhenIdle();
    }
  }

  private admit(turn: LocalTurn, grant: ConversationTurnLeaseGrant, sentAt: number): void {
    turn.turnId = grant.turnId;
    this.leased.set(grant.turnId, turn);
    this.holdLease(turn, sentAt);
    this.ensureHeartbeat();

    for (const notice of this.heldNotices.get(turn.conversationId) ?? []) {
      if (notice.kind === "started") {
        this.onStarted(notice);
      }
    }

    if (grant.remoteAhead && !turn.state.isCompleted) {
      turn.remoteClear = new Promise<void>((settle) => {
        this.remoteWaiters.set(grant.turnId, { turn, settle });
      });
      this.ensurePolling();
      this.requestCheck();
    } else if (grant.expiredAhead) {
      this.observer?.predecessorLeaseExpired?.({ conversationId: turn.conversationId });
    }
    if (turn.state.isCompleted) {
      this.end(turn);
    }
  }

  /**
   * A turn started somewhere. The newest of this process's own turns of the conversation that it
   * is newer than hears of it; a turn hears only of the first newer turn, the one right behind it.
   * Notices arrive in the order the store placed the turns, so the first one heard is that turn.
   */
  private onStarted(started: ConversationTurnStarted): void {
    const local = this.inFlight.get(started.conversationId) ?? [];
    for (const turn of local) {
      if (turn.turnId !== undefined && BigInt(turn.turnId) < BigInt(started.turnId)) {
        turn.state.supersededBy(
          { supersedeAfterEmission: started.supersedeAfterEmission },
          started.ownerInstanceId === this.instanceId ? "local" : "cross_instance",
        );
      }
    }
  }

  private complete(turn: LocalTurn): void {
    if (!turn.state.complete()) {
      return;
    }
    clearTimeout(turn.watchdog);
    const remaining = (this.inFlight.get(turn.conversationId) ?? []).filter((inFlight) => inFlight !== turn);
    if (remaining.length > 0) {
      this.inFlight.set(turn.conversationId, remaining);
    } else {
      this.inFlight.delete(turn.conversationId);
    }
    if (turn.turnId !== undefined) {
      this.remoteWaiters.get(turn.turnId)?.settle();
      this.remoteWaiters.delete(turn.turnId);
      this.end(turn);
    }
  }

  private end(turn: LocalTurn): void {
    const turnId = turn.turnId;
    if (turnId === undefined || turn.ending) {
      return;
    }
    turn.ending = true;
    void this.recordEnd({ conversationId: turn.conversationId, turnId }).finally(() => {
      this.leased.delete(turnId);
      if (this.leased.size === 0) {
        this.clearTimer("heartbeat");
      }
      this.releaseSubscriptionWhenIdle();
    });
  }

  /** Retries briefly while the lease is still renewed; after that it expires on its own. */
  private async recordEnd(ref: ConversationTurnRef): Promise<void> {
    for (let attempt = 0; ; attempt += 1) {
      try {
        await this.leases.end(ref);
        return;
      } catch (error) {
        const retryDelayMs = END_RETRY_DELAYS_MS[attempt];
        if (retryDelayMs === undefined || this.closed) {
          // Other processes' turns wait until the lease expires.
          this.warn("conversation_turn_lease_end_failed", error);
          return;
        }
        await sleep(retryDelayMs);
      }
    }
  }

  /** The lease is held until `sentAt` + TTL in the store; give it up locally a margin before that. */
  private holdLease(turn: LocalTurn, sentAt: number): void {
    if (turn.state.isCompleted || turn.state.hasLostLease) {
      return;
    }
    const deadline = sentAt + this.timings.leaseTtlMs - leaseSafetyMarginMs(this.timings.leaseTtlMs);
    turn.state.holdLeaseUntil(deadline);
    clearTimeout(turn.watchdog);
    turn.watchdog = setTimeout(() => turn.state.leaseLost(), Math.max(0, deadline - performance.now()));
    turn.watchdog.unref();
  }

  private onNotice(notice: ConversationTurnNotice): void {
    if (notice.kind === "started") {
      this.onStarted(notice);
    } else if ([...this.remoteWaiters.values()].some((waiter) => waiter.turn.conversationId === notice.conversationId)) {
      this.requestCheck();
    }
    if (this.registering.has(notice.conversationId)) {
      const held = this.heldNotices.get(notice.conversationId) ?? [];
      held.push(notice);
      this.heldNotices.set(notice.conversationId, held);
    }
  }

  private onListening(): void {
    this.listening = true;
    // Announcements made while nothing listened are lost; the store has what they said.
    if (this.leased.size > 0) {
      this.requestCatchUp();
    }
    if (this.remoteWaiters.size > 0) {
      this.requestCheck();
    }
  }

  private onInterrupted(): void {
    this.listening = false;
    this.noticeEpoch += 1;
  }

  /** Rechecks every waiting turn against the store; one check runs at a time. */
  private requestCheck(): void {
    if (this.checking) {
      this.checkRequested = true;
      return;
    }
    void this.checkRemoteWaiters();
  }

  private async checkRemoteWaiters(): Promise<void> {
    this.checking = true;
    try {
      do {
        this.checkRequested = false;
        const waiters = [...this.remoteWaiters.entries()];
        if (waiters.length === 0) {
          return;
        }
        const ahead = await this.leases.aheadOf(
          waiters.map(([turnId, waiter]) => ({ turnId, conversationId: waiter.turn.conversationId })),
          this.instanceId,
        );
        for (const [turnId, waiter] of waiters) {
          const state = ahead.get(turnId);
          if (state?.live || this.remoteWaiters.get(turnId) !== waiter) {
            continue;
          }
          this.remoteWaiters.delete(turnId);
          if (state?.expired) {
            this.observer?.predecessorLeaseExpired?.({ conversationId: waiter.turn.conversationId });
          }
          waiter.settle();
        }
      } while (this.checkRequested);
    } catch (error) {
      this.warn("conversation_turn_predecessor_check_failed", error);
    } finally {
      this.checking = false;
      if (this.remoteWaiters.size === 0) {
        this.clearTimer("poll");
      }
      this.releaseSubscriptionWhenIdle();
    }
  }

  /**
   * Reads back the newer turns announced while nothing listened, retrying with backoff while this
   * process still has turns in flight. One catch-up runs at a time; a request during it runs it again.
   */
  private requestCatchUp(): void {
    if (!this.listening || this.closed) {
      // The next `listening` catches up on every leased turn.
      return;
    }
    if (this.catchUpRunning) {
      this.catchUpRequested = true;
      return;
    }
    void this.runCatchUp();
  }

  private async runCatchUp(): Promise<void> {
    this.catchUpRunning = true;
    let failures = 0;
    try {
      for (;;) {
        this.catchUpRequested = false;
        const turns = [...this.leased].map(([turnId, turn]) => ({ turnId, conversationId: turn.conversationId }));
        if (turns.length === 0 || !this.listening || this.closed) {
          return;
        }
        try {
          for (const successor of await this.leases.successorsOf(turns)) {
            this.onStarted(successor);
          }
          failures = 0;
          if (!this.catchUpRequested) {
            return;
          }
        } catch (error) {
          if (failures === 0) {
            this.warn("conversation_turn_catch_up_failed", error);
          }
          await sleep(Math.min(CATCH_UP_RETRY_MAX_MS, this.timings.catchUpRetryInitialMs * 2 ** failures));
          failures += 1;
        }
      }
    } finally {
      this.catchUpRunning = false;
    }
  }

  /** One renewal at a time; a turn whose lease the store no longer holds is aborted, not renewed. */
  private async renewLeases(): Promise<void> {
    const held = [...this.leased].filter(([, turn]) => !turn.state.isCompleted && !turn.state.hasLostLease);
    if (this.renewing || held.length === 0) {
      return;
    }
    this.renewing = true;
    const sentAt = performance.now();
    try {
      const lost = new Set(await this.leases.renew({
        ownerInstanceId: this.instanceId,
        turnIds: held.map(([turnId]) => turnId),
        leaseTtlMs: this.timings.leaseTtlMs,
      }));
      for (const [turnId, turn] of held) {
        if (lost.has(turnId)) {
          clearTimeout(turn.watchdog);
          turn.state.leaseLost();
        } else {
          this.holdLease(turn, sentAt);
        }
      }
      if (lost.size > 0) {
        this.logger?.warn(
          { event: "conversation_turn_lease_lost", leaseCount: lost.size },
          "Conversation turn leases expired before renewal; their turns were aborted",
        );
      }
    } catch (error) {
      // The watchdog aborts each turn if no renewal lands before its lease would expire.
      this.warn("conversation_turn_lease_renewal_failed", error);
    } finally {
      this.renewing = false;
    }
  }

  private subscribe(): void {
    if (this.unsubscribe || this.closed) {
      return;
    }
    this.unsubscribe = this.notices.subscribe({
      notice: (notice) => this.onNotice(notice),
      listening: () => this.onListening(),
      interrupted: () => this.onInterrupted(),
    });
  }

  /** Stops listening once this process has no turn leased, registering, or waiting. */
  private releaseSubscriptionWhenIdle(): void {
    if (this.leased.size > 0 || this.registering.size > 0 || this.remoteWaiters.size > 0 || !this.unsubscribe) {
      return;
    }
    this.unsubscribe();
    this.unsubscribe = null;
    this.onInterrupted();
  }

  private doneRegistering(conversationId: string): void {
    const remaining = (this.registering.get(conversationId) ?? 1) - 1;
    if (remaining > 0) {
      this.registering.set(conversationId, remaining);
    } else {
      this.registering.delete(conversationId);
      this.heldNotices.delete(conversationId);
    }
  }

  private ensureHeartbeat(): void {
    if (this.heartbeatTimer || this.closed) {
      return;
    }
    this.heartbeatTimer = setInterval(() => {
      void this.renewLeases();
    }, this.timings.heartbeatIntervalMs);
    this.heartbeatTimer.unref();
  }

  private ensurePolling(): void {
    if (this.pollTimer || this.closed) {
      return;
    }
    this.pollTimer = setInterval(() => {
      this.requestCheck();
    }, this.timings.predecessorPollIntervalMs);
    this.pollTimer.unref();
  }

  private clearTimer(timer: "heartbeat" | "poll"): void {
    const handle = timer === "heartbeat" ? this.heartbeatTimer : this.pollTimer;
    if (handle) {
      clearInterval(handle);
    }
    if (timer === "heartbeat") {
      this.heartbeatTimer = null;
    } else {
      this.pollTimer = null;
    }
  }

  private warn(event: string, error: unknown): void {
    this.logger?.warn(
      { event, errorType: error instanceof Error ? error.name : typeof error },
      "Conversation turn coordination degraded",
    );
  }
}
