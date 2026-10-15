import { randomUUID } from "node:crypto";

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import {
  PostgresConversationTurnLeaseStore,
  PostgresConversationTurnNotices,
} from "../../src/modules/chat/infra/postgresConversationTurnLeases.js";
import {
  ChatTurnDisconnectAbortError,
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

/** Counts settled `begin` calls, so a test knows every started turn has taken its place. */
class CountingLeaseStore implements ConversationTurnLeaseStore {
  settledBegins = 0;

  constructor(private readonly inner: ConversationTurnLeaseStore) {}

  async begin(input: Parameters<ConversationTurnLeaseStore["begin"]>[0]) {
    try {
      return await this.inner.begin(input);
    } finally {
      this.settledBegins += 1;
    }
  }

  end(input: Parameters<ConversationTurnLeaseStore["end"]>[0]) {
    return this.inner.end(input);
  }

  renew(input: Parameters<ConversationTurnLeaseStore["renew"]>[0]) {
    return this.inner.renew(input);
  }

  leaseStates(turnIds: string[]) {
    return this.inner.leaseStates(turnIds);
  }

  successorsOf(turnIds: string[]) {
    return this.inner.successorsOf(turnIds);
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
  /** Stops renewing and listening without ending its turns, as a crashed instance would. */
  crash(): Promise<void>;
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
  const leases = new CountingLeaseStore(new PostgresConversationTurnLeaseStore(database.kysely));
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
    crash: shutDown,
    close: shutDown,
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

    it("lets the commit latch win against a supersede racing in from the other process", async () => {
      const first = a.start(conversationId, speechLike);
      first.beginEmission();
      await a.settle();

      const second = b.start(conversationId, speechLike);
      // Same tick as the newer turn's start: its announcement cannot have reached A yet.
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
      expect(first.signal.aborted).toBe(false);
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
