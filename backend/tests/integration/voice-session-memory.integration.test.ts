import { randomUUID } from "node:crypto";

import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import {
  PostgresVoiceSessionMemoryStore,
  PostgresVoiceSessionNotices,
} from "../../src/modules/voiceChannel/persistence/postgresVoiceSessionMemoryStore.js";
import type { VoiceSessionMemory } from "../../src/modules/voiceChannel/services/voiceSessionMemory.js";
import { Database } from "../../src/shared/infra/database.js";
import { PostgresNotificationListener } from "../../src/shared/infra/postgresNotificationListener.js";
import {
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
    return {
      instance: () => {
        const instance = startInstance(`contract-${instances.length}`);
        instances.push(instance);
        return instance.memory;
      },
      session: newSession,
      conversation: insertConversation,
      settled: () => settledOn(instances),
      close: async () => {
        await Promise.all(instances.map((instance) => instance.close()));
      },
    };
  });

  describe("across instances", () => {
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
        const t0 = Date.now();
        const first = await one.memory.arrive(session, t0);
        await vi.waitFor(async () => expect(await listenerSessions()).toBe("1"));

        await admin.query("SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE application_name = $1", [one.listenerApplicationName]);
        await vi.waitFor(async () => expect(await listenerSessions()).toBe("0"));
        await two.memory.arrive(session, t0 + 100);
        await nextMacrotask();
        expect(first.supersededAt).toBeNull();

        await vi.waitFor(() => expect(first.supersededAt).toBe(t0 + 100), { timeout: 5_000 });
      } finally {
        await Promise.all([one.close(), two.close()]);
      }
    });
  });

  describe("retention", () => {
    const countRows = async (sessionKey: string) => {
      const [row] = await admin.query<{ memories: string; requests: string }>(
        `SELECT
           (SELECT count(*) FROM voice_session_memories WHERE session_key = $1)::text AS memories,
           (SELECT count(*) FROM voice_session_requests r JOIN voice_session_memories m ON m.id = r.memory_id
             WHERE m.session_key = $1)::text AS requests`,
        [sessionKey],
      );
      return row;
    };

    it("deletes a forgotten session's rows as other sessions' requests settle", async () => {
      const instance = startInstance("retention");
      try {
        const [idle, busy] = [newSession(), newSession()];
        const t0 = Date.now();
        const old = await instance.memory.arrive(idle, t0);
        instance.memory.settle(old, t0 + 1_000, undefined);
        await settledOn([instance]);
        expect(await countRows(idle.sessionKey)).toEqual({ memories: "1", requests: "1" });

        const later = await instance.memory.arrive(busy, t0 + 1_000 + 30_001);
        instance.memory.settle(later, t0 + 1_000 + 30_001, undefined);
        await settledOn([instance]);

        expect(await countRows(idle.sessionKey)).toEqual({ memories: "0", requests: "0" });
        expect(await countRows(busy.sessionKey)).toEqual({ memories: "1", requests: "1" });
      } finally {
        await instance.close();
      }
    });

    it("keeps an idle session's rows while one of its requests is in flight", async () => {
      const instance = startInstance("retention-in-flight");
      try {
        const [running, busy] = [newSession(), newSession()];
        const t0 = Date.now();
        await instance.memory.arrive(running, t0);

        const later = await instance.memory.arrive(busy, t0 + 60_000);
        instance.memory.settle(later, t0 + 60_000, undefined);
        await settledOn([instance]);

        expect(await countRows(running.sessionKey)).toEqual({ memories: "1", requests: "1" });
      } finally {
        await instance.close();
      }
    });

    it("forgets the session's exchange with its conversation", async () => {
      const instance = startInstance("conversation-deleted");
      try {
        const session = newSession();
        const conversationId = await insertConversation();
        const t0 = Date.now();
        const claim = await instance.memory.arrive(session, t0);
        claim.hungUpAt = t0 + 100;
        instance.memory.settle(claim, t0 + 200, {
          utterance: "When do you open?",
          conversationId,
          reply: { messageId: randomUUID(), text: "At nine." },
          spoken: { bridge: null, reply: "At nine." },
          cutOffAt: t0 + 100,
        });
        await settledOn([instance]);

        await admin.query("DELETE FROM conversations WHERE id = $1", [conversationId]);
        const again = await instance.memory.arrive(session, t0 + 300);

        expect(instance.memory.replayFor(again, "When do you open?", t0 + 300)).toBeNull();
        const rows = await admin.query<{ last_exchange: unknown }>(
          "SELECT last_exchange FROM voice_session_memories WHERE session_key = $1",
          [session.sessionKey],
        );
        expect(rows).toEqual([{ last_exchange: null }]);
      } finally {
        await instance.close();
      }
    });
  });

  describe("what the rows hold", () => {
    it("keeps the caller's utterance only as a digest", async () => {
      const instance = startInstance("digest");
      try {
        const session = newSession();
        const conversationId = await insertConversation();
        const t0 = Date.now();
        const claim = await instance.memory.arrive(session, t0);
        instance.memory.settle(claim, t0 + 200, {
          utterance: "My booking number is 4471",
          conversationId,
          reply: { messageId: randomUUID(), text: "Thanks." },
          spoken: { bridge: null, reply: "Thanks." },
          cutOffAt: null,
        });
        await settledOn([instance]);

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
