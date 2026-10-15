import type { AppLogger } from "../../../shared/observability/logger.js";
import {
  ConversationTurnState,
  type ConversationTurnInterruptionObserver,
  type ConversationTurnLease,
  type ConversationTurnLeaseOptions,
  type ConversationTurnRegistry,
} from "./conversationTurnRegistry.js";

/** A turn's place in its conversation, as the lease store granted it. */
export interface ConversationTurnLeaseGrant {
  turnId: string;
  /** The conversation's previous turn, when it was still in flight as this one started. */
  predecessorTurnId: string | null;
  /** That predecessor's owner had already stopped renewing its lease. */
  predecessorExpired: boolean;
}

/** A turn started right behind another, as every process hears of it. */
export interface ConversationTurnStarted {
  conversationId: string;
  turnId: string;
  predecessorTurnId: string | null;
  supersedeAfterEmission: boolean;
  ownerInstanceId: string;
}

export type ConversationTurnNotice =
  | ({ kind: "started" } & ConversationTurnStarted)
  | { kind: "ended"; conversationId: string; turnId: string };

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
  end(input: { conversationId: string; turnId: string }): Promise<void>;
  /**
   * Extends the leases this process still holds; resolves with the ones it no longer held. Also
   * drops leases long expired, so a crashed process leaves nothing behind.
   */
  renew(input: { ownerInstanceId: string; turnIds: string[]; leaseTtlMs: number }): Promise<string[]>;
  /** Which of these turns still hold a lease, live or expired; a turn absent from the result has ended. */
  leaseStates(turnIds: string[]): Promise<Map<string, "live" | "expired">>;
  /** The turns started right behind these, to catch up on announcements missed while not listening. */
  successorsOf(turnIds: string[]): Promise<ConversationTurnStarted[]>;
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
  /** How long a lease lasts without renewal before a successor stops waiting for its turn. */
  leaseTtlMs: number;
  heartbeatIntervalMs: number;
  /** How often a waiting turn checks its predecessor in the store, should a notice be missed. */
  predecessorPollIntervalMs: number;
}

const DEFAULT_TIMINGS: CrossInstanceTimings = {
  leaseTtlMs: 30_000,
  heartbeatIntervalMs: 10_000,
  predecessorPollIntervalMs: 1_000,
};

const END_RETRY_DELAYS_MS: readonly number[] = [250, 1_000];

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
  registration?: Promise<void>;
  grant?: ConversationTurnLeaseGrant;
  /** Resolves once this turn may run: its predecessor ended, its lease expired, or there was none. */
  predecessorSettled?: Promise<void>;
  /** The turn right behind this one has been applied to it. */
  successorApplied: boolean;
  ending: boolean;
}

interface PredecessorWaiter {
  conversationId: string;
  settle(): void;
}

/**
 * Coordinates a conversation's turns across every process that runs them. The lease store orders
 * the turns and holds their leases; notices wake the processes involved. Supersession is decided by
 * the process that runs the superseded turn, against that turn's own latches, so the commit latch
 * stays synchronous and still wins or loses atomically against a newer turn from anywhere.
 */
export class CrossInstanceConversationTurnRegistry implements ConversationTurnRegistry {
  private readonly instanceId: string;
  private readonly leases: ConversationTurnLeaseStore;
  private readonly notices: ConversationTurnNoticeSource;
  private readonly observer?: ConversationTurnInterruptionObserver;
  private readonly logger?: Pick<AppLogger, "warn">;
  private readonly timings: CrossInstanceTimings;

  /** Registered turns this process runs, by turn id, until their end is recorded. */
  private readonly turns = new Map<string, LocalTurn>();
  /** Turns still taking their place, by conversation; notices for those conversations are kept for them. */
  private readonly registering = new Map<string, Set<LocalTurn>>();
  private readonly heldNotices = new Map<string, ConversationTurnNotice[]>();
  /** Each conversation's last registration here, so turns started in this process keep their call order. */
  private readonly registrationTails = new Map<string, Promise<void>>();
  /** Turns waiting for a predecessor another process runs, by that predecessor's turn id. */
  private readonly waiters = new Map<string, Set<PredecessorWaiter>>();

  private unsubscribe: (() => void) | null = null;
  private listening = false;
  /** Advances whenever notices may have been missed. */
  private noticeEpoch = 0;
  private heartbeatTimer: NodeJS.Timeout | null = null;
  private pollTimer: NodeJS.Timeout | null = null;
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
    const turn: LocalTurn = { state, successorApplied: false, ending: false };
    this.subscribe();
    this.addRegistering(turn);

    const previous = this.registrationTails.get(conversationId) ?? Promise.resolve();
    const registration = previous.then(() => this.register(turn));
    turn.registration = registration;
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
        waiting ??= registration.then(() => turn.predecessorSettled);
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
      const grant = await this.leases.begin({
        conversationId: turn.state.conversationId,
        ownerInstanceId: this.instanceId,
        supersedeAfterEmission: turn.state.supersedeAfterEmission,
        leaseTtlMs: this.timings.leaseTtlMs,
      });
      this.admit(turn, grant);
      if (!heardFromIssue || epochAtIssue !== this.noticeEpoch) {
        // A turn right behind this one may have been announced while nothing listened.
        void this.catchUpOnSuccessors([grant.turnId]);
      }
    } finally {
      this.removeRegistering(turn);
      this.releaseSubscriptionWhenIdle();
    }
  }

  private admit(turn: LocalTurn, grant: ConversationTurnLeaseGrant): void {
    turn.grant = grant;
    this.turns.set(grant.turnId, turn);
    this.ensureHeartbeat();

    let predecessorEnded = false;
    for (const notice of this.heldNotices.get(turn.state.conversationId) ?? []) {
      if (notice.kind === "started" && notice.predecessorTurnId === grant.turnId) {
        this.applySuccessor(turn, notice);
      } else if (notice.kind === "ended" && notice.turnId === grant.predecessorTurnId) {
        predecessorEnded = true;
      }
    }

    turn.predecessorSettled = this.predecessorSettled(turn, grant, predecessorEnded);
    if (turn.state.isCompleted) {
      this.end(turn);
    }
  }

  private predecessorSettled(
    turn: LocalTurn,
    grant: ConversationTurnLeaseGrant,
    predecessorEnded: boolean,
  ): Promise<void> {
    const predecessorTurnId = grant.predecessorTurnId;
    if (!predecessorTurnId || predecessorEnded) {
      return Promise.resolve();
    }
    if (grant.predecessorExpired) {
      this.observer?.predecessorLeaseExpired?.({ conversationId: turn.state.conversationId });
      return Promise.resolve();
    }
    const localPredecessor = this.turns.get(predecessorTurnId);
    if (localPredecessor) {
      this.applySuccessor(localPredecessor, {
        supersedeAfterEmission: turn.state.supersedeAfterEmission,
        ownerInstanceId: this.instanceId,
      });
      return localPredecessor.state.finished;
    }
    if (turn.state.isCompleted) {
      // It ended before taking its place; nothing waits on it.
      return Promise.resolve();
    }
    return this.waitForRemotePredecessor(predecessorTurnId, turn.state.conversationId);
  }

  private applySuccessor(
    predecessor: LocalTurn,
    successor: Pick<ConversationTurnStarted, "supersedeAfterEmission" | "ownerInstanceId">,
  ): void {
    if (predecessor.successorApplied) {
      return;
    }
    predecessor.successorApplied = true;
    predecessor.state.supersededBy(
      { supersedeAfterEmission: successor.supersedeAfterEmission },
      successor.ownerInstanceId === this.instanceId ? "local" : "cross_instance",
    );
  }

  private waitForRemotePredecessor(predecessorTurnId: string, conversationId: string): Promise<void> {
    return new Promise<void>((resolve) => {
      const waiters = this.waiters.get(predecessorTurnId) ?? new Set<PredecessorWaiter>();
      waiters.add({ conversationId, settle: resolve });
      this.waiters.set(predecessorTurnId, waiters);
      this.ensurePolling();
    });
  }

  private settleWaiters(predecessorTurnId: string, outcome: "ended" | "expired"): void {
    const waiters = this.waiters.get(predecessorTurnId);
    if (!waiters) {
      return;
    }
    this.waiters.delete(predecessorTurnId);
    for (const waiter of waiters) {
      if (outcome === "expired") {
        this.observer?.predecessorLeaseExpired?.({ conversationId: waiter.conversationId });
      }
      waiter.settle();
    }
    if (this.waiters.size === 0) {
      this.clearTimer("poll");
    }
    this.releaseSubscriptionWhenIdle();
  }

  private complete(turn: LocalTurn): void {
    if (!turn.state.complete()) {
      return;
    }
    if (turn.grant) {
      this.end(turn);
    }
  }

  private end(turn: LocalTurn): void {
    const grant = turn.grant;
    if (!grant || turn.ending) {
      return;
    }
    turn.ending = true;
    void this.recordEnd(turn.state.conversationId, grant.turnId).finally(() => {
      this.turns.delete(grant.turnId);
      if (this.turns.size === 0) {
        this.clearTimer("heartbeat");
      }
      this.releaseSubscriptionWhenIdle();
    });
  }

  /** Retries briefly while the lease is still renewed; after that it expires on its own. */
  private async recordEnd(conversationId: string, turnId: string): Promise<void> {
    for (let attempt = 0; ; attempt += 1) {
      try {
        await this.leases.end({ conversationId, turnId });
        return;
      } catch (error) {
        const retryDelayMs = END_RETRY_DELAYS_MS[attempt];
        if (retryDelayMs === undefined || this.closed) {
          // A successor elsewhere waits until the lease expires.
          this.warn("conversation_turn_lease_end_failed", error);
          return;
        }
        await new Promise((resolve) => {
          setTimeout(resolve, retryDelayMs).unref();
        });
      }
    }
  }

  private onNotice(notice: ConversationTurnNotice): void {
    if (notice.kind === "started") {
      const predecessor = notice.predecessorTurnId ? this.turns.get(notice.predecessorTurnId) : undefined;
      if (predecessor) {
        this.applySuccessor(predecessor, notice);
      }
    } else {
      this.settleWaiters(notice.turnId, "ended");
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
    if (this.turns.size > 0) {
      void this.catchUpOnSuccessors([...this.turns.keys()]);
    }
    if (this.waiters.size > 0) {
      void this.pollPredecessors();
    }
  }

  private onInterrupted(): void {
    this.listening = false;
    this.noticeEpoch += 1;
  }

  private async catchUpOnSuccessors(turnIds: string[]): Promise<void> {
    if (!this.listening) {
      // The next `listening` catches up on every registered turn.
      return;
    }
    try {
      for (const successor of await this.leases.successorsOf(turnIds)) {
        this.onNotice({ kind: "started", ...successor });
      }
    } catch (error) {
      this.warn("conversation_turn_catch_up_failed", error);
    }
  }

  private async pollPredecessors(): Promise<void> {
    const predecessorTurnIds = [...this.waiters.keys()];
    if (predecessorTurnIds.length === 0) {
      return;
    }
    try {
      const states = await this.leases.leaseStates(predecessorTurnIds);
      for (const turnId of predecessorTurnIds) {
        const state = states.get(turnId);
        if (state !== "live") {
          this.settleWaiters(turnId, state === "expired" ? "expired" : "ended");
        }
      }
    } catch (error) {
      this.warn("conversation_turn_predecessor_poll_failed", error);
    }
  }

  private async renewLeases(): Promise<void> {
    const turnIds = [...this.turns.keys()];
    if (turnIds.length === 0) {
      return;
    }
    try {
      const lost = await this.leases.renew({
        ownerInstanceId: this.instanceId,
        turnIds,
        leaseTtlMs: this.timings.leaseTtlMs,
      });
      if (lost.length > 0) {
        this.logger?.warn(
          { event: "conversation_turn_lease_lost", leaseCount: lost.length },
          "Conversation turn leases expired before renewal; successors no longer wait for them",
        );
      }
    } catch (error) {
      this.warn("conversation_turn_lease_renewal_failed", error);
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

  /** Stops listening once this process has no turn in flight and none waiting. */
  private releaseSubscriptionWhenIdle(): void {
    if (this.turns.size > 0 || this.registering.size > 0 || this.waiters.size > 0 || !this.unsubscribe) {
      return;
    }
    this.unsubscribe();
    this.unsubscribe = null;
    this.onInterrupted();
  }

  private addRegistering(turn: LocalTurn): void {
    const conversationId = turn.state.conversationId;
    const registering = this.registering.get(conversationId) ?? new Set<LocalTurn>();
    registering.add(turn);
    this.registering.set(conversationId, registering);
  }

  private removeRegistering(turn: LocalTurn): void {
    const conversationId = turn.state.conversationId;
    const registering = this.registering.get(conversationId);
    registering?.delete(turn);
    if (registering?.size === 0) {
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
      void this.pollPredecessors();
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
