import { randomUUID } from "node:crypto";

import { sql } from "kysely";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import {
  PostgresVoiceSessionMemoryStore,
  PostgresVoiceSessionNotices,
} from "../../src/modules/voiceChannel/persistence/postgresVoiceSessionMemoryStore.js";
import type { VoiceSessionMemory } from "../../src/modules/voiceChannel/services/voiceSessionMemory.js";
import { Database } from "../../src/shared/infra/database.js";
import { PostgresNotificationListener } from "../../src/shared/infra/postgresNotificationListener.js";
import {
  arrived,
  describeVoiceSessionMemoryContract,
  memoryOver,
  TrackingVoiceSessionMemoryStore,
} from "../support/voiceSessionMemoryContract.js";
import { resolveIntegrationDatabase } from "./support/integrationDatabase.js";

const { describeIntegration, integrationDatabaseUrl } = await resolveIntegrationDatabase();

const nextMacrotask = () => new Promise<void>((resolve) => {
  setImmediate(resolve);
});

/** One backend instance: its own pool and its own `LISTEN` connection, over the shared database. */
interface TestInstance {
  memory: VoiceSessionMemory;
  store: TrackingVoiceSessionMemoryStore;
  listenerApplicationName: string;
  close(): Promise<void>;
}

const startInstance = (name: string, options: { reconnectDelayMs?: number } = {}): TestInstance => {
  const instanceId = `${name}-${randomUUID()}`;
  const listenerApplicationName = `radioso-voice-listener-${instanceId}`.slice(0, 63);
  const database = new Database(integrationDatabaseUrl, { applicationName: `radioso-voice-test-${name}` });
  const listener = new PostgresNotificationListener({
    connectionString: integrationDatabaseUrl,
    applicationName: listenerApplicationName,
    idleCloseMs: 0,
    reconnectDelay: { initialMs: options.reconnectDelayMs ?? 20, maxMs: options.reconnectDelayMs ?? 200 },
  });
  const store = new TrackingVoiceSessionMemoryStore(new PostgresVoiceSessionMemoryStore(database.kysely));
  return {
    memory: memoryOver(store, new PostgresVoiceSessionNotices(listener)),
    store,
    listenerApplicationName,
    async close() {
      await listener.close();
      await database.close();
    },
  };
};

describeIntegration("voice session memory on Postgres", () => {
  const admin = new Database(integrationDatabaseUrl);
  const accountId = randomUUID();
  const workspaceId = randomUUID();
  const agentId = randomUUID();

  const newSession = () => ({ workspaceId, agentId, vendor: "elevenlabs", sessionKey: `conv_${randomUUID()}` });

  const insertConversation = async (): Promise<string> => {
    const conversationId = randomUUID();
    await admin.query(
      "INSERT INTO conversations (id, workspace_id, agent_id, source_channel) VALUES ($1, $2, $3, 'voice')",
      [conversationId, workspaceId, agentId],
    );
    return conversationId;
  };

  const settledOn = async (instances: TestInstance[]): Promise<void> => {
    await nextMacrotask();
    await vi.waitFor(() => expect(instances.map((instance) => instance.store.pending)).toEqual(instances.map(() => 0)));
    await nextMacrotask();
  };

  /** Moves every time the database holds for this suite's sessions `ms` into the past. */
  const age = async (ms: number): Promise<void> => {
    await sql`
      UPDATE voice_session_memories SET
        touched_at = touched_at - ${ms}::integer * interval '1 millisecond',
        last_bridge_at = last_bridge_at - ${ms}::integer * interval '1 millisecond',
        last_exchange_note_claimed_at = last_exchange_note_claimed_at - ${ms}::integer * interval '1 millisecond',
        requests = (
          SELECT coalesce(jsonb_object_agg(entry.key, entry.value
            || jsonb_build_object('arrivedAt', (entry.value->>'arrivedAt')::bigint - ${ms}::bigint)), '{}'::jsonb)
          FROM jsonb_each(requests) entry
        )
      WHERE agent_id = ${agentId}::uuid
    `.execute(admin.kysely);
  };

  beforeAll(async () => {
    await admin.query(
      "INSERT INTO accounts (id, name, email, password_hash) VALUES ($1, $2, $3, $4)",
      [accountId, "Voice Memory Test Co", `voice-memory-${accountId}@example.com`, "hash"],
    );
    await admin.query(
      "INSERT INTO workspaces (id, account_id, name, public_route_key) VALUES ($1, $2, $3, $4)",
      [workspaceId, accountId, "Voice Memory Workspace", `voice-memory-${workspaceId}`],
    );
    await admin.query("INSERT INTO agents (id, workspace_id, name) VALUES ($1, $2, $3)", [agentId, workspaceId, "Voice Agent"]);
  });

  afterAll(async () => {
    await admin.query("DELETE FROM accounts WHERE id = $1", [accountId]).catch(() => undefined);
    await admin.close().catch(() => undefined);
  });

  describeVoiceSessionMemoryContract("Postgres store", async () => {
    const instances: TestInstance[] = [];
    let offset = 0;
    return {
      instance: () => {
        const instance = startInstance(`contract-${instances.length}`);
        instances.push(instance);
        return instance.memory;
      },
      session: newSession,
      conversation: insertConversation,
      now: () => Date.now() + offset,
      elapse: async (ms) => {
        offset += ms;
        await age(ms);
      },
      settled: () => settledOn(instances),
      close: async () => {
        await Promise.all(instances.map((instance) => instance.close()));
      },
    };
  });

  describe("across instances", () => {
    it("lets only one of two identical re-requests that reach the database together replay the answer", async () => {
      const [one, two, three] = [startInstance("first"), startInstance("racing-a"), startInstance("racing-b")];
      try {
        const session = newSession();
        const conversationId = await insertConversation();
        const t = Date.now();
        const lost = await arrived(one.memory, session, t);
        lost.hungUpAt = t + 1;
        lost.outcomeAt = t + 2;
        await one.memory.settle(lost, t + 2, {
          utterance: "When do you open?",
          conversationId,
          reply: { messageId: randomUUID(), text: "At nine." },
          spoken: { bridge: null, reply: "At nine." },
          cutOffAt: t + 1,
        });

        // Both arrivals wait on the session's row; each one's statement started before the other committed.
        let releaseLock!: () => void;
        const lockReleased = new Promise<void>((resolve) => { releaseLock = resolve; });
        let lockHeld!: () => void;
        const lockTaken = new Promise<void>((resolve) => { lockHeld = resolve; });
        const holder = admin.kysely.transaction().execute(async (trx) => {
          await sql`SELECT id FROM voice_session_memories WHERE agent_id = ${agentId}::uuid AND session_key = ${session.sessionKey} FOR UPDATE`.execute(trx);
          lockHeld();
          await lockReleased;
        });
        await lockTaken;
        const [left, right] = [two.memory.arrive(session, t + 100), three.memory.arrive(session, t + 100)];
        await vi.waitFor(async () => {
          const [row] = await admin.query<{ waiting: string }>(
            "SELECT count(*)::text AS waiting FROM pg_stat_activity WHERE wait_event_type = 'Lock' AND application_name LIKE 'radioso-voice-test-racing-%'",
          );
          expect(row?.waiting).toBe("2");
        });
        releaseLock();
        await holder;
        await Promise.all([two.memory.registered(left), three.memory.registered(right)]);

        const replays = [two.memory.replayFor(left, "When do you open?", t + 100), three.memory.replayFor(right, "When do you open?", t + 100)];
        expect(replays.filter((replay) => replay !== null)).toHaveLength(1);
      } finally {
        await Promise.all([one.close(), two.close(), three.close()]);
      }
    });

    it("learns of a newer request announced while its listener was down, once it reconnects", async () => {
      const [one, two] = [startInstance("dropped", { reconnectDelayMs: 1_000 }), startInstance("other")];
      const listenerSessions = async () => {
        const [row] = await admin.query<{ count: string }>(
          "SELECT count(*)::text AS count FROM pg_stat_activity WHERE application_name = $1 AND query ILIKE 'LISTEN%'",
          [one.listenerApplicationName],
        );
        return row?.count;
      };
      try {
        const session = newSession();
        const first = await arrived(one.memory, session, Date.now());
        await vi.waitFor(async () => expect(await listenerSessions()).toBe("1"));

        await admin.query("SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE application_name = $1", [one.listenerApplicationName]);
        await vi.waitFor(async () => expect(await listenerSessions()).toBe("0"));
        await arrived(two.memory, session, Date.now());
        await nextMacrotask();
        expect(first.supersededAt).toBeNull();

        await vi.waitFor(() => expect(first.supersededAt).not.toBeNull(), { timeout: 5_000 });
      } finally {
        await Promise.all([one.close(), two.close()]);
      }
    });
  });

  describe("retention", () => {
    const sessionRows = async (sessionKey: string) =>
      admin.query<{ requests: Record<string, unknown> }>(
        "SELECT requests FROM voice_session_memories WHERE session_key = $1",
        [sessionKey],
      );

    it("deletes a forgotten session's row as another session's request settles", async () => {
      const instance = startInstance("retention");
      try {
        const [idle, busy] = [newSession(), newSession()];
        const old = await arrived(instance.memory, idle, Date.now());
        await instance.memory.settle(old, Date.now(), undefined);
        expect(await sessionRows(idle.sessionKey)).toEqual([{ requests: {} }]);

        await age(30_001);
        const later = await arrived(instance.memory, busy, Date.now());
        await instance.memory.settle(later, Date.now(), undefined);

        expect(await sessionRows(idle.sessionKey)).toEqual([]);
        expect(await sessionRows(busy.sessionKey)).toHaveLength(1);
      } finally {
        await instance.close();
      }
    });

    it("keeps an idle session's row while one of its requests is in flight, and until that request is older than a request lives", async () => {
      const instance = startInstance("retention-in-flight");
      try {
        const [running, busy] = [newSession(), newSession()];
        await arrived(instance.memory, running, Date.now());

        await age(60_000);
        const later = await arrived(instance.memory, busy, Date.now());
        await instance.memory.settle(later, Date.now(), undefined);
        expect(await sessionRows(running.sessionKey)).toHaveLength(1);

        await age(5 * 60_000);
        const last = await arrived(instance.memory, busy, Date.now());
        await instance.memory.settle(last, Date.now(), undefined);
        expect(await sessionRows(running.sessionKey)).toEqual([]);
      } finally {
        await instance.close();
      }
    });

    it("forgets the session's exchange with its conversation", async () => {
      const [one, two] = [startInstance("conversation-deleted"), startInstance("conversation-deleted-other")];
      try {
        const session = newSession();
        const conversationId = await insertConversation();
        const t = Date.now();
        const claim = await arrived(one.memory, session, t);
        claim.hungUpAt = t + 100;
        await one.memory.settle(claim, t + 200, {
          utterance: "When do you open?",
          conversationId,
          reply: { messageId: randomUUID(), text: "At nine." },
          spoken: { bridge: null, reply: "At nine." },
          cutOffAt: t + 100,
        });

        await admin.query("DELETE FROM conversations WHERE id = $1", [conversationId]);
        const again = await arrived(two.memory, session, t + 300);

        expect(two.memory.replayFor(again, "When do you open?", t + 300)).toBeNull();
        const rows = await admin.query<{ last_exchange: unknown }>(
          "SELECT last_exchange FROM voice_session_memories WHERE session_key = $1",
          [session.sessionKey],
        );
        expect(rows).toEqual([{ last_exchange: null }]);
      } finally {
        await Promise.all([one.close(), two.close()]);
      }
    });
  });

  describe("what the rows hold", () => {
    it("keeps the caller's utterance only as a digest", async () => {
      const instance = startInstance("digest");
      try {
        const session = newSession();
        const conversationId = await insertConversation();
        const t = Date.now();
        const claim = await arrived(instance.memory, session, t);
        await instance.memory.settle(claim, t + 200, {
          utterance: "My booking number is 4471",
          conversationId,
          reply: { messageId: randomUUID(), text: "Thanks." },
          spoken: { bridge: null, reply: "Thanks." },
          cutOffAt: null,
        });

        const rows = await admin.query<{ last_exchange: string }>(
          "SELECT last_exchange::text AS last_exchange FROM voice_session_memories WHERE session_key = $1",
          [session.sessionKey],
        );
        expect(rows[0]?.last_exchange).not.toContain("4471");
      } finally {
        await instance.close();
      }
    });
  });
});
