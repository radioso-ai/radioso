import { randomUUID } from "node:crypto";

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import {
  PostgresConversationTurnLeaseStore,
  PostgresConversationTurnNotices,
} from "../../src/modules/chat/infra/postgresConversationTurnLeases.js";
import {
  ChatTurnDisconnectAbortError,
  ChatTurnLeaseLostError,
  ChatTurnSupersededError,
  type ConversationTurnInterruptionObserver,
} from "../../src/modules/chat/services/conversationTurnRegistry.js";
import {
  CrossInstanceConversationTurnRegistry,
  type ConversationTurnLeaseStore,
  type ConversationTurnNotice,
  type ConversationTurnNoticeSource,
} from "../../src/modules/chat/services/crossInstanceConversationTurnRegistry.js";
import { Database } from "../../src/shared/infra/database.js";
import { PostgresNotificationListener } from "../../src/shared/infra/postgresNotificationListener.js";
import {
  describeConversationTurnRegistryContract,
  isPending,
} from "../support/conversationTurnRegistryContract.js";
import { runAllTestMigrations } from "../support/databaseMigrations.js";

const integrationDatabaseUrl = process.env.INTEGRATION_DATABASE_URL;

const canReachIntegrationDatabase = async (databaseUrl?: string): Promise<boolean> => {
  if (!databaseUrl) {
    return false;
  }
  const database = new Database(databaseUrl);
  try {
    await database.query("SELECT 1");
    return true;
  } catch {
    return false;
  } finally {
    await database.close().catch(() => undefined);
  }
};

const describeIfDatabase = await canReachIntegrationDatabase(integrationDatabaseUrl) ? describe : describe.skip;

const nextMacrotask = () => new Promise<void>((resolve) => {
  setImmediate(resolve);
});

/**
 * The Postgres lease store, instrumented: counts settled `begin` calls so a test knows every started
 * turn has taken its place, tracks calls in flight so a process closes only once they land, and can
 * hold renewals back, as a stalled process would.
 */
class InstrumentedLeaseStore implements ConversationTurnLeaseStore {
  settledBegins = 0;
  private inFlight = 0;
  private renewalGate: Promise<void> | null = null;
  private releaseRenewals: (() => void) | null = null;

  constructor(private readonly inner: ConversationTurnLeaseStore) {}

  get idle(): boolean {
    return this.inFlight === 0;
  }

  pauseRenewals(): void {
    this.renewalGate = new Promise((resolve) => {
      this.releaseRenewals = resolve;
    });
  }

  resumeRenewals(): void {
    this.releaseRenewals?.();
    this.renewalGate = null;
  }

  async begin(input: Parameters<ConversationTurnLeaseStore["begin"]>[0]) {
    try {
      return await this.track(this.inner.begin(input));
    } finally {
      this.settledBegins += 1;
    }
  }

  end(input: Parameters<ConversationTurnLeaseStore["end"]>[0]) {
    return this.track(this.inner.end(input));
  }

  async renew(input: Parameters<ConversationTurnLeaseStore["renew"]>[0]) {
    await this.renewalGate;
    return this.inner.renew(input);
  }

  pruneExpired(conversationId: string) {
    return this.inner.pruneExpired(conversationId);
  }

  aheadOf(...input: Parameters<ConversationTurnLeaseStore["aheadOf"]>) {
    return this.inner.aheadOf(...input);
  }

  successorsOf(turns: Parameters<ConversationTurnLeaseStore["successorsOf"]>[0]) {
    return this.inner.successorsOf(turns);
  }

  private async track<T>(operation: Promise<T>): Promise<T> {
    this.inFlight += 1;
    try {
      return await operation;
    } finally {
      this.inFlight -= 1;
    }
  }
}

/** Records every notice the registry heard, after the registry handled it. */
class RecordingNotices implements ConversationTurnNoticeSource {
  readonly heard: ConversationTurnNotice[] = [];

  constructor(private readonly inner: ConversationTurnNoticeSource) {}

  subscribe(handlers: Parameters<ConversationTurnNoticeSource["subscribe"]>[0]) {
    return this.inner.subscribe({
      ...handlers,
      notice: (notice) => {
        handlers.notice(notice);
        this.heard.push(notice);
      },
    });
  }
}

interface TestProcess {
  instanceId: string;
  listenerApplicationName: string;
  registry: CrossInstanceConversationTurnRegistry;
  start: CrossInstanceConversationTurnRegistry["start"];
  /** Every turn started on this process has taken its place, and what that decided has applied. */
  settle(): Promise<void>;
  /** This process heard another process start a turn on `conversationId`. */
  heardStartOf(conversationId: string, ownerInstanceId: string): Promise<void>;
  /** Holds this process's lease renewals back, as a stalled event loop would, until `resumeRenewals`. */
  pauseRenewals(): void;
  resumeRenewals(): void;
  /** Stops renewing and listening without ending its turns, as a crashed instance would. */
  crash(): Promise<void>;
  /** Every start and end this process sent has landed. */
  drained(): Promise<void>;
  /** Lets the starts and ends in flight land, then shuts down. */
  close(): Promise<void>;
}

const startProcess = (
  name: string,
  observer: ConversationTurnInterruptionObserver,
  options: {
    leaseTtlMs?: number;
    heartbeatIntervalMs?: number;
    reconnectDelayMs?: number;
    logger?: { info: (...args: unknown[]) => void; warn: (...args: unknown[]) => void };
  } = {},
): TestProcess => {
  const instanceId = `${name}-${randomUUID()}`;
  const listenerApplicationName = `radioso-turn-listener-${instanceId}`.slice(0, 63);
  const database = new Database(integrationDatabaseUrl!, { applicationName: `radioso-turn-test-${name}` });
  const listener = new PostgresNotificationListener({
    connectionString: integrationDatabaseUrl!,
    applicationName: listenerApplicationName,
    idleCloseMs: 0,
    reconnectDelay: { initialMs: options.reconnectDelayMs ?? 20, maxMs: options.reconnectDelayMs ?? 200 },
    logger: options.logger,
  });
  const leases = new InstrumentedLeaseStore(new PostgresConversationTurnLeaseStore(database.kysely));
  const notices = new RecordingNotices(new PostgresConversationTurnNotices(listener));
  const registry = new CrossInstanceConversationTurnRegistry({
    instanceId,
    leases,
    notices,
    observer,
    timings: {
      leaseTtlMs: options.leaseTtlMs ?? 10_000,
      heartbeatIntervalMs: options.heartbeatIntervalMs ?? 1_000,
      predecessorPollIntervalMs: 50,
    },
  });
  let started = 0;
  let closed = false;
  const drained = async () => {
    await vi.waitFor(() => {
      expect(leases.settledBegins).toBe(started);
      expect(leases.idle).toBe(true);
    });
    await nextMacrotask();
  };
  const shutDown = async () => {
    if (closed) {
      return;
    }
    closed = true;
    registry.close();
    await listener.close();
    await database.close();
  };
  return {
    instanceId,
    listenerApplicationName,
    registry,
    start: (conversationId, leaseOptions) => {
      started += 1;
      return registry.start(conversationId, leaseOptions);
    },
    async settle() {
      await vi.waitFor(() => expect(leases.settledBegins).toBe(started));
      await nextMacrotask();
    },
    async heardStartOf(conversationId, ownerInstanceId) {
      await vi.waitFor(() =>
        expect(notices.heard).toContainEqual(expect.objectContaining({ kind: "started", conversationId, ownerInstanceId })));
    },
    pauseRenewals: () => leases.pauseRenewals(),
    resumeRenewals: () => leases.resumeRenewals(),
    crash: shutDown,
    drained,
    async close() {
      if (!closed) {
        leases.resumeRenewals();
        await drained();
      }
      await shutDown();
    },
  };
};

describeIfDatabase("conversation turn coordination on Postgres", () => {
  let admin: Database;

  beforeAll(async () => {
    admin = new Database(integrationDatabaseUrl!);
    await runAllTestMigrations(admin);
  });

  afterAll(async () => {
    await admin?.close().catch(() => undefined);
  });

  describeConversationTurnRegistryContract("CrossInstanceConversationTurnRegistry", async (observer) => {
    const contractProcess = startProcess("contract", observer);
    return {
      registry: { start: contractProcess.start },
      settle: () => contractProcess.settle(),
      close: () => contractProcess.close(),
    };
  });

  describe("two processes on one database", () => {
    const speechLike = { supersedeAfterEmission: true };
    let a: TestProcess;
    let b: TestProcess;
    let cancelledOnA: ReturnType<typeof vi.fn<ConversationTurnInterruptionObserver["turnCancelled"]>>;
    let expiredOnB: ReturnType<typeof vi.fn<NonNullable<ConversationTurnInterruptionObserver["predecessorLeaseExpired"]>>>;
    let conversationId: string;

    beforeEach(() => {
      cancelledOnA = vi.fn<ConversationTurnInterruptionObserver["turnCancelled"]>();
      expiredOnB = vi.fn<NonNullable<ConversationTurnInterruptionObserver["predecessorLeaseExpired"]>>();
      a = startProcess("a", { turnCancelled: cancelledOnA }, { leaseTtlMs: 600, heartbeatIntervalMs: 150 });
      b = startProcess("b", { turnCancelled: vi.fn(), predecessorLeaseExpired: expiredOnB });
      conversationId = randomUUID();
    });

    afterEach(async () => {
      await a.close();
      await b.close();
    });

    it("cancels the older turn on the other process before it emits, and holds the newer one until it completes", async () => {
      const first = a.start(conversationId);
      first.setStage("rendering");
      await a.settle();

      const second = b.start(conversationId);

      await vi.waitFor(() => expect(first.signal.aborted).toBe(true));
      expect(() => first.throwIfCancelled()).toThrowError(ChatTurnSupersededError);
      expect(cancelledOnA).toHaveBeenCalledWith({
        conversationId,
        reason: "superseded",
        stage: "rendering",
        scope: "cross_instance",
      });
      expect(await isPending(second.waitForPredecessor())).toBe(true);

      first.complete();
      await second.waitForPredecessor();
      second.complete();
    });

    it("lets an older turn that began emitting finish when the newer turn does not supersede after emission", async () => {
      const first = a.start(conversationId);
      first.beginEmission();
      await a.settle();

      const second = b.start(conversationId);
      await a.heardStartOf(conversationId, b.instanceId);

      expect(first.signal.aborted).toBe(false);
      expect(cancelledOnA).not.toHaveBeenCalled();
      expect(await isPending(second.waitForPredecessor())).toBe(true);

      first.complete();
      await second.waitForPredecessor();
      second.complete();
    });

    it("cancels an older turn mid-reply when both turns supersede after emission", async () => {
      const first = a.start(conversationId, speechLike);
      first.beginEmission();
      await a.settle();

      const second = b.start(conversationId, speechLike);

      await vi.waitFor(() => expect(first.signal.aborted).toBe(true));
      expect(() => first.throwIfCancelled()).toThrowError(
        expect.objectContaining({ name: "ChatTurnSupersededError", afterEmission: true, replacedByNewerInput: true }),
      );
      expect(cancelledOnA).toHaveBeenCalledWith({
        conversationId,
        reason: "superseded",
        stage: "persisting",
        scope: "cross_instance",
      });

      first.complete();
      await second.waitForPredecessor();
      second.complete();
    });

    it("known cross-instance window: keeps a reply that latched its commit before its process heard of the newer turn", async () => {
      const first = a.start(conversationId, speechLike);
      first.beginEmission();
      await a.settle();

      const second = b.start(conversationId, speechLike);
      // A learns of the newer turn one notification after B's start statement commits. A latch set
      // inside that window stands, so this reply is stored and the newer turn runs after it. On one
      // instance the newer turn would have won; this is the window the docs describe, not a goal.
      expect(() => first.beginCommit()).not.toThrow();
      await a.heardStartOf(conversationId, b.instanceId);

      expect(first.signal.aborted).toBe(false);
      expect(cancelledOnA).not.toHaveBeenCalled();
      expect(await isPending(second.waitForPredecessor())).toBe(true);

      first.complete();
      await second.waitForPredecessor();
      second.complete();
    });

    it("refuses the commit latch once a supersede from the other process landed first", async () => {
      const first = a.start(conversationId, speechLike);
      first.beginEmission();
      await a.settle();

      const second = b.start(conversationId, speechLike);
      await vi.waitFor(() => expect(first.signal.aborted).toBe(true));

      expect(() => first.beginCommit()).toThrowError(
        expect.objectContaining({ name: "ChatTurnSupersededError", afterEmission: true }),
      );
      first.complete();
      await second.waitForPredecessor();
      second.complete();
    });

    it("stops waiting for an older turn once its crashed process's lease expires", async () => {
      const first = a.start(conversationId);
      first.beginEmission();
      await a.settle();
      await a.crash();

      const second = b.start(conversationId);
      await b.settle();
      expect(await isPending(second.waitForPredecessor())).toBe(true);

      await second.waitForPredecessor();
      expect(expiredOnB).toHaveBeenCalledWith({ conversationId });
      second.complete();
    });

    it("does not wait at all behind a lease that expired before the newer turn started", async () => {
      const first = a.start(conversationId);
      await a.settle();
      await a.crash();
      await new Promise((resolve) => setTimeout(resolve, 800));

      const second = b.start(conversationId);
      await second.waitForPredecessor();

      expect(expiredOnB).toHaveBeenCalledWith({ conversationId });
      // The stranded turn stopped itself when its lease lapsed; the newer turn did not cancel it.
      expect(first.signal.reason).toBeInstanceOf(ChatTurnLeaseLostError);
      second.complete();
    });

    it("keeps an older turn's lease alive while its process renews it", async () => {
      const first = a.start(conversationId);
      first.beginEmission();
      await a.settle();

      const second = b.start(conversationId);
      await new Promise((resolve) => setTimeout(resolve, 1_200));

      expect(await isPending(second.waitForPredecessor())).toBe(true);
      expect(expiredOnB).not.toHaveBeenCalled();
      first.complete();
      await second.waitForPredecessor();
      second.complete();
    });

    it("releases the other process's waiting turn when a turn is cancelled after its client disconnected", async () => {
      const first = a.start(conversationId);
      first.beginEmission();
      await a.settle();
      const second = b.start(conversationId);
      await a.heardStartOf(conversationId, b.instanceId);

      first.cancelAfterDisconnect();

      expect(first.signal.aborted).toBe(true);
      expect(() => first.throwIfCancelled()).toThrowError(ChatTurnDisconnectAbortError);
      expect(cancelledOnA).toHaveBeenCalledWith({
        conversationId,
        reason: "disconnect_timeout",
        stage: "persisting",
        scope: "local",
      });
      expect(await isPending(second.waitForPredecessor())).toBe(true);

      first.complete();
      await second.waitForPredecessor();
      second.complete();
    });

    it("aborts its own turn when its renewals hang, before a successor on another process takes over", async () => {
      const first = a.start(conversationId);
      first.beginEmission();
      await a.settle();
      let abortedAt: number | null = null;
      first.signal.addEventListener("abort", () => {
        abortedAt = performance.now();
      });
      a.pauseRenewals();

      const second = b.start(conversationId);
      await second.waitForPredecessor();
      const takenOverAt = performance.now();

      expect(abortedAt).not.toBeNull();
      expect(abortedAt!).toBeLessThan(takenOverAt);
      expect(() => first.throwIfCancelled()).toThrowError(ChatTurnLeaseLostError);
      expect(cancelledOnA).toHaveBeenCalledWith({
        conversationId,
        reason: "lease_lost",
        stage: "persisting",
        scope: "local",
      });
      expect(expiredOnB).toHaveBeenCalledWith({ conversationId });
      first.complete();
      second.complete();
    });
  });

  describe("three processes on one database", () => {
    let processes: TestProcess[];
    let expiredOnNewest: ReturnType<typeof vi.fn<NonNullable<ConversationTurnInterruptionObserver["predecessorLeaseExpired"]>>>;
    let oldestOwner: TestProcess;
    let middleOwner: TestProcess;
    let newestOwner: TestProcess;
    let conversationId: string;

    beforeEach(() => {
      expiredOnNewest = vi.fn<NonNullable<ConversationTurnInterruptionObserver["predecessorLeaseExpired"]>>();
      oldestOwner = startProcess("oldest", { turnCancelled: vi.fn() });
      middleOwner = startProcess("middle", { turnCancelled: vi.fn() }, { leaseTtlMs: 600, heartbeatIntervalMs: 150 });
      newestOwner = startProcess("newest", { turnCancelled: vi.fn(), predecessorLeaseExpired: expiredOnNewest });
      processes = [oldestOwner, middleOwner, newestOwner];
      conversationId = randomUUID();
    });

    afterEach(async () => {
      for (const owner of processes) {
        await owner.close();
      }
    });

    const pastMiddleLease = () => new Promise((resolve) => setTimeout(resolve, 1_000));

    it("keeps the newest turn behind the oldest live one when the turn between them crashes while waiting", async () => {
      const oldest = oldestOwner.start(conversationId);
      oldest.beginEmission();
      await oldestOwner.settle();
      middleOwner.start(conversationId);
      await middleOwner.settle();
      const newest = newestOwner.start(conversationId);
      await newestOwner.settle();

      await middleOwner.crash();
      await pastMiddleLease();

      expect(await isPending(newest.waitForPredecessor())).toBe(true);
      expect(oldest.signal.aborted).toBe(false);
      oldest.complete();
      await newest.waitForPredecessor();
      expect(expiredOnNewest).toHaveBeenCalledWith({ conversationId });
      newest.complete();
    });

    it("waits behind the oldest live turn when the turn right before it had already expired as it started", async () => {
      const oldest = oldestOwner.start(conversationId);
      oldest.beginEmission();
      await oldestOwner.settle();
      middleOwner.start(conversationId);
      await middleOwner.settle();
      await middleOwner.crash();
      await pastMiddleLease();

      const newest = newestOwner.start(conversationId);
      await newestOwner.settle();

      expect(await isPending(newest.waitForPredecessor())).toBe(true);
      oldest.complete();
      await newest.waitForPredecessor();
      expect(expiredOnNewest).toHaveBeenCalledWith({ conversationId });
      newest.complete();
    });

    it("keeps a newer turn behind the oldest live turn after the turn between them lost its lease and completed", async () => {
      const oldest = oldestOwner.start(conversationId);
      oldest.beginEmission();
      await oldestOwner.settle();
      const middle = middleOwner.start(conversationId);
      await middleOwner.settle();
      middleOwner.pauseRenewals();
      await vi.waitFor(() => expect(middle.signal.aborted).toBe(true), { timeout: 5_000 });
      expect(() => middle.throwIfCancelled()).toThrowError(ChatTurnLeaseLostError);
      middle.complete();
      await middleOwner.drained();

      const newest = newestOwner.start(conversationId);
      await newestOwner.settle();

      expect(await isPending(newest.waitForPredecessor())).toBe(true);
      await pastMiddleLease();
      expect(await isPending(newest.waitForPredecessor())).toBe(true);
      oldest.complete();
      await newest.waitForPredecessor();
      newest.complete();
    });

    it("keeps a waiting turn behind the oldest live turn when the turn between them loses its lease and completes", async () => {
      const oldest = oldestOwner.start(conversationId);
      oldest.beginEmission();
      await oldestOwner.settle();
      const middle = middleOwner.start(conversationId);
      await middleOwner.settle();
      const newest = newestOwner.start(conversationId);
      await newestOwner.settle();

      middleOwner.pauseRenewals();
      await vi.waitFor(() => expect(middle.signal.aborted).toBe(true), { timeout: 5_000 });
      middle.complete();
      await middleOwner.drained();
      await pastMiddleLease();

      expect(await isPending(newest.waitForPredecessor())).toBe(true);
      oldest.complete();
      await newest.waitForPredecessor();
      newest.complete();
    });

    it("keeps a waiting turn behind the oldest live turn when the expired turn between them is pruned", async () => {
      const oldest = oldestOwner.start(conversationId);
      oldest.beginEmission();
      await oldestOwner.settle();
      middleOwner.start(conversationId);
      await middleOwner.settle();
      const newest = newestOwner.start(conversationId);
      await newestOwner.settle();
      await middleOwner.crash();

      await admin.execute(
        "UPDATE conversation_turn_leases SET lease_expires_at = now() - interval '10 minutes' WHERE owner_instance_id = $1",
        [middleOwner.instanceId],
      );
      await new PostgresConversationTurnLeaseStore(admin.kysely).pruneExpired(conversationId);
      expect(await admin.queryOne<{ count: string }>(
        "SELECT count(*)::text AS count FROM conversation_turn_leases WHERE owner_instance_id = $1",
        [middleOwner.instanceId],
      )).toEqual({ count: "0" });
      await new Promise((resolve) => setTimeout(resolve, 300));

      expect(await isPending(newest.waitForPredecessor())).toBe(true);
      oldest.complete();
      await newest.waitForPredecessor();
      newest.complete();
    });
  });

  describe("PostgresConversationTurnLeaseStore", () => {
    let store: PostgresConversationTurnLeaseStore;
    const leaseRow = (turnId: string) =>
      admin.queryOptional<{ live: boolean }>(
        "SELECT lease_expires_at > now() AS live FROM conversation_turn_leases WHERE turn_id = $1",
        [turnId],
      );
    const headRow = (conversationId: string) =>
      admin.queryOptional<{ turn_id: string }>(
        "SELECT turn_id::text AS turn_id FROM conversation_turn_heads WHERE conversation_id = $1",
        [conversationId],
      );
    const begin = (conversationId: string, ownerInstanceId: string) =>
      store.begin({ conversationId, ownerInstanceId, supersedeAfterEmission: false, leaseTtlMs: 30_000 });
    // Backdates the lease, and its conversation's head with it: a turn whose lease expired that
    // long ago started at least that long ago.
    const expire = async (turnId: string, ago: string) => {
      await admin.execute(
        "UPDATE conversation_turn_leases SET lease_expires_at = now() - $2::interval WHERE turn_id = $1",
        [turnId, ago],
      );
      await admin.execute(
        "UPDATE conversation_turn_heads SET updated_at = now() - $2::interval WHERE turn_id = $1",
        [turnId, ago],
      );
    };

    beforeAll(() => {
      store = new PostgresConversationTurnLeaseStore(admin.kysely);
    });

    it("starts a turn without touching another conversation's leases or head", async () => {
      const crashedConversation = randomUUID();
      const crashed = await begin(crashedConversation, "crashed-instance");
      await expire(crashed.turnId, "10 minutes");

      const conversationId = randomUUID();
      const started = await begin(conversationId, "live-instance");

      expect(await leaseRow(crashed.turnId)).toEqual({ live: false });
      expect(await headRow(crashedConversation)).toEqual({ turn_id: crashed.turnId });
      await store.end({ conversationId, turnId: started.turnId });
      await store.pruneExpired(crashedConversation);
    });

    it("prunes a conversation's long-expired leases and the head left pointing at them", async () => {
      const conversationId = randomUUID();
      const crashed = await begin(conversationId, "crashed-instance");
      await expire(crashed.turnId, "10 minutes");

      await store.pruneExpired(conversationId);

      expect(await leaseRow(crashed.turnId)).toBeNull();
      expect(await headRow(conversationId)).toBeNull();
    });

    it("keeps a lease that expired only recently when pruning", async () => {
      const conversationId = randomUUID();
      const recent = await begin(conversationId, "stalled-instance");
      await expire(recent.turnId, "1 second");

      await store.pruneExpired(conversationId);

      expect(await leaseRow(recent.turnId)).toEqual({ live: false });
      await store.end({ conversationId, turnId: recent.turnId });
    });

    it("starts turns on different conversations with stale heads concurrently without deadlocking", async () => {
      const other = new Database(integrationDatabaseUrl!, { applicationName: "radioso-turn-test-concurrent" });
      const otherStore = new PostgresConversationTurnLeaseStore(other.kysely);
      try {
        for (let round = 0; round < 15; round += 1) {
          const [left, right] = [randomUUID(), randomUUID()];
          for (const conversationId of [left, right]) {
            await expire((await begin(conversationId, "crashed-instance")).turnId, "10 minutes");
          }

          const [leftTurn, rightTurn] = await Promise.all([
            store.begin({ conversationId: left, ownerInstanceId: "a", supersedeAfterEmission: false, leaseTtlMs: 30_000 }),
            otherStore.begin({ conversationId: right, ownerInstanceId: "b", supersedeAfterEmission: false, leaseTtlMs: 30_000 }),
          ]);

          await store.end({ conversationId: left, turnId: leftTurn.turnId });
          await store.end({ conversationId: right, turnId: rightTurn.turnId });
          await Promise.all([store.pruneExpired(left), otherStore.pruneExpired(right)]);
        }
      } finally {
        await other.close();
      }
    });

    it("refuses to renew an expired lease and reports it lost, renewing only the live one", async () => {
      const conversationId = randomUUID();
      const expired = await begin(conversationId, "owner");
      const otherConversation = randomUUID();
      const live = await begin(otherConversation, "owner");
      await expire(expired.turnId, "1 second");

      const lost = await store.renew({ ownerInstanceId: "owner", turnIds: [expired.turnId, live.turnId], leaseTtlMs: 30_000 });

      expect(lost).toEqual([expired.turnId]);
      expect(await leaseRow(expired.turnId)).toEqual({ live: false });
      expect(await leaseRow(live.turnId)).toEqual({ live: true });
      await store.end({ conversationId, turnId: expired.turnId });
      await store.end({ conversationId: otherConversation, turnId: live.turnId });
    });
  });

  describe("a process whose notification connection drops", () => {
    it("catches up from the lease store on a newer turn announced while it was not listening", async () => {
      const cancelled = vi.fn<ConversationTurnInterruptionObserver["turnCancelled"]>();
      const logger = { info: vi.fn(), warn: vi.fn() };
      const a = startProcess("a", { turnCancelled: cancelled }, { reconnectDelayMs: 1_000, logger });
      const b = startProcess("b", { turnCancelled: vi.fn() });
      const conversationId = randomUUID();
      try {
        const first = a.start(conversationId);
        first.setStage("routing");
        await a.settle();

        await admin.query(
          "SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE application_name = $1",
          [a.listenerApplicationName],
        );
        await vi.waitFor(() => expect(logger.warn).toHaveBeenCalledWith(
          expect.objectContaining({ event: "postgres_notification_listener_lost" }),
          expect.any(String),
        ));
        const second = b.start(conversationId);
        await b.settle();
        expect(first.signal.aborted).toBe(false);

        await vi.waitFor(() => expect(first.signal.aborted).toBe(true), { timeout: 5_000 });
        expect(cancelled).toHaveBeenCalledWith({
          conversationId,
          reason: "superseded",
          stage: "routing",
          scope: "cross_instance",
        });
        first.complete();
        await second.waitForPredecessor();
        second.complete();
      } finally {
        await a.close();
        await b.close();
      }
    });
  });

  describe("PostgresNotificationListener", () => {
    const channel = "radioso_listener_test";
    const listenerSessions = async (applicationName: string): Promise<number> => {
      const row = await admin.queryOne<{ count: string }>(
        "SELECT count(*) AS count FROM pg_stat_activity WHERE application_name = $1",
        [applicationName],
      );
      return Number(row.count);
    };

    it("delivers notifications once listening, reconnects after its session ends, and closes when idle", async () => {
      const applicationName = `radioso-listener-test-${randomUUID()}`.slice(0, 63);
      const listener = new PostgresNotificationListener({
        connectionString: integrationDatabaseUrl!,
        applicationName,
        idleCloseMs: 200,
        reconnectDelay: { initialMs: 20, maxMs: 100 },
      });
      const handlers = { notification: vi.fn(), listening: vi.fn(), interrupted: vi.fn() };
      try {
        const unsubscribe = listener.subscribe(channel, handlers);
        await vi.waitFor(() => expect(handlers.listening).toHaveBeenCalledTimes(1));

        await admin.query("SELECT pg_notify($1, $2)", [channel, "first"]);
        await vi.waitFor(() => expect(handlers.notification).toHaveBeenCalledWith("first"));

        await admin.query("SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE application_name = $1", [applicationName]);
        await vi.waitFor(() => expect(handlers.interrupted).toHaveBeenCalledTimes(1));
        await vi.waitFor(() => expect(handlers.listening).toHaveBeenCalledTimes(2));

        await admin.query("SELECT pg_notify($1, $2)", [channel, "second"]);
        await vi.waitFor(() => expect(handlers.notification).toHaveBeenCalledWith("second"));

        unsubscribe();
        await vi.waitFor(() => expect(listenerSessions(applicationName)).resolves.toBe(0));
      } finally {
        await listener.close();
      }
    });

    it("ends its session on close and does not reconnect", async () => {
      const applicationName = `radioso-listener-test-${randomUUID()}`.slice(0, 63);
      const listener = new PostgresNotificationListener({
        connectionString: integrationDatabaseUrl!,
        applicationName,
        idleCloseMs: 0,
        reconnectDelay: { initialMs: 20, maxMs: 100 },
      });
      const handlers = { notification: vi.fn(), listening: vi.fn(), interrupted: vi.fn() };
      listener.subscribe(channel, handlers);
      await vi.waitFor(() => expect(handlers.listening).toHaveBeenCalledTimes(1));

      await listener.close();

      expect(await listenerSessions(applicationName)).toBe(0);
      await new Promise((resolve) => setTimeout(resolve, 200));
      expect(await listenerSessions(applicationName)).toBe(0);
      expect(handlers.interrupted).not.toHaveBeenCalled();
    });
  });
});
