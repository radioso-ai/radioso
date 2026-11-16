import { randomUUID } from "node:crypto";
import type { AddressInfo } from "node:net";

import request from "supertest";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { createConversationTurnCoordination } from "../../src/app/composition/conversationTurnCoordination.js";
import { createPublicConversationEventBus } from "../../src/app/composition/publicConversationEvents.js";
import { resetRateLimiterState } from "../../src/app/http/middleware/anonymousRateLimiter.js";
import type { PublicConversationEvent } from "../../src/modules/chat/services/publicConversationEventBus.js";
import { Database } from "../../src/shared/infra/database.js";
import { PostgresNotificationListener } from "../../src/shared/infra/postgresNotificationListener.js";
import { runAllTestMigrations } from "../support/databaseMigrations.js";
import { adminSessionHeaders, createTestApp, issueTestSession } from "../support/testApp.js";

// Each "instance" below is what one backend process composes: its own pool and its own LISTEN
// session on the shared database, so events travel between them only through Postgres.

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

const logger = () => ({ info: vi.fn(), warn: vi.fn() }) as never;

interface TestInstance {
  applicationName: string;
  database: Database;
  listener: PostgresNotificationListener;
  bus: ReturnType<typeof createPublicConversationEventBus>;
  close(): Promise<void>;
}

const startInstance = (name: string): TestInstance => {
  const applicationName = `radioso-events-${name}-${randomUUID()}`.slice(0, 63);
  const database = new Database(integrationDatabaseUrl!, { applicationName: `radioso-events-test-${name}` });
  const listener = new PostgresNotificationListener({
    connectionString: integrationDatabaseUrl!,
    applicationName,
    idleCloseMs: 0,
    reconnectDelay: { initialMs: 20, maxMs: 200 },
  });
  const bus = createPublicConversationEventBus({ db: database.kysely, notifications: listener, logger: logger() });
  return {
    applicationName,
    database,
    listener,
    bus,
    async close() {
      await listener.close();
      await database.close();
    },
  };
};

const messageCreated = (conversationId: string, workspaceId = "workspace-1"): PublicConversationEvent => ({
  type: "message.created",
  conversationId,
  workspaceId,
  messageId: randomUUID(),
  createdAt: new Date().toISOString(),
});

/** Reads a server-sent event stream into a list of `{ event, data }` as it arrives. */
const openEventStream = async (url: string, headers: Record<string, string>) => {
  const controller = new AbortController();
  const response = await fetch(url, { headers, signal: controller.signal });
  const events: Array<{ event: string; data: Record<string, unknown> }> = [];
  const reader = response.body!.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  const pump = (async () => {
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) {
          return;
        }
        buffer += decoder.decode(value, { stream: true });
        for (let boundary = buffer.indexOf("\n\n"); boundary >= 0; boundary = buffer.indexOf("\n\n")) {
          const block = buffer.slice(0, boundary);
          buffer = buffer.slice(boundary + 2);
          const event = /^event: (.+)$/m.exec(block)?.[1];
          const data = /^data: (.+)$/m.exec(block)?.[1];
          if (event && data) {
            events.push({ event, data: JSON.parse(data) as Record<string, unknown> });
          }
        }
      }
    } catch {
      // Aborted by `close`.
    }
  })();
  return {
    status: response.status,
    events,
    named: (name: string) => events.filter((entry) => entry.event === name),
    async close() {
      controller.abort();
      await pump;
    },
  };
};

describeIfDatabase("public conversation events across instances", () => {
  let admin: Database;

  const listenerSessions = async (applicationName: string): Promise<number> => {
    const row = await admin.queryOne<{ count: string }>(
      "SELECT count(*) AS count FROM pg_stat_activity WHERE application_name = $1",
      [applicationName],
    );
    return Number(row.count);
  };

  const dropListenerSession = (applicationName: string) =>
    admin.query("SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE application_name = $1", [applicationName]);

  beforeAll(async () => {
    admin = new Database(integrationDatabaseUrl!);
    await runAllTestMigrations(admin);
  });

  afterAll(async () => {
    await admin.close();
  });

  beforeEach(() => {
    resetRateLimiterState();
  });

  it("delivers an event published on one instance to a subscriber on another, once on each", async () => {
    const a = startInstance("a");
    const b = startInstance("b");
    const conversationId = randomUUID();
    try {
      const onA = vi.fn();
      const onB = vi.fn();
      const aListening = vi.fn();
      const bListening = vi.fn();
      a.bus.subscribe(conversationId, onA, aListening);
      b.bus.subscribe(conversationId, onB, bListening);
      await vi.waitFor(() => {
        expect(aListening).toHaveBeenCalledOnce();
        expect(bListening).toHaveBeenCalledOnce();
      });

      const event = messageCreated(conversationId);
      a.bus.publish(event);

      expect(onA).toHaveBeenCalledExactlyOnceWith(event);
      await vi.waitFor(() => expect(onB).toHaveBeenCalledExactlyOnceWith(event));
      // A hears its own notification too, ahead of anything sent after it, and drops it: it
      // delivered the event when it published.
      const sentinel = vi.fn();
      const sentinelConversationId = randomUUID();
      a.bus.subscribe(sentinelConversationId, sentinel);
      b.bus.publish(messageCreated(sentinelConversationId));
      await vi.waitFor(() => expect(sentinel).toHaveBeenCalledOnce());
      expect(onA).toHaveBeenCalledOnce();
      expect(onB).toHaveBeenCalledOnce();
    } finally {
      await a.close();
      await b.close();
    }
  });

  it("tells a subscriber to re-read after its instance's listener reconnects, then delivers again", async () => {
    const a = startInstance("a");
    const b = startInstance("b");
    const conversationId = randomUUID();
    try {
      const onB = vi.fn();
      const missed = vi.fn();
      b.bus.subscribe(conversationId, onB, missed);
      await vi.waitFor(() => expect(missed).toHaveBeenCalledOnce());

      await dropListenerSession(b.applicationName);
      await vi.waitFor(() => expect(missed).toHaveBeenCalledTimes(2), { timeout: 5_000 });

      const event = messageCreated(conversationId);
      a.bus.publish(event);
      await vi.waitFor(() => expect(onB).toHaveBeenCalledExactlyOnceWith(event));
    } finally {
      await a.close();
      await b.close();
    }
  });

  it("serves turn coordination and visitor events from one listener session per process", async () => {
    const instance = startInstance("shared");
    const coordination = createConversationTurnCoordination({
      db: instance.database.kysely,
      notifications: instance.listener,
      logger: logger(),
    });
    try {
      const listening = vi.fn();
      instance.bus.subscribe(randomUUID(), vi.fn(), listening);
      const lease = coordination.registry.start(randomUUID());
      await lease.waitForPredecessor();
      await vi.waitFor(() => expect(listening).toHaveBeenCalledOnce());

      expect(await listenerSessions(instance.applicationName)).toBe(1);
      lease.complete();
    } finally {
      await coordination.shutdown();
      await instance.close();
    }
  });

  it("streams a message published on one instance to a visitor whose event stream another instance holds", async () => {
    const a = startInstance("a");
    const b = startInstance("b");
    const { app, dependencies } = createTestApp({ publicConversationEventBus: b.bus });
    const server = app.listen(0);
    const conversationId = randomUUID();
    let stream: Awaited<ReturnType<typeof openEventStream>> | null = null;
    try {
      const session = await issueTestSession(app, "visitor-events-across-instances@example.com");
      const settings = await request(app).put("/api/v1/settings/general").set(adminSessionHeaders(session)).send({
        anonymousChatEnabled: true,
      });
      const chatToken = String(settings.body.anonymousChatUrl).split("/chat/")[1];
      const publicSession = await request(app)
        .post(`/api/v1/public/chat/${chatToken}/sessions`)
        .send({ channel: "anonymous_link" });
      expect(publicSession.status).toBe(200);
      // The stream only needs the conversation to belong to this visitor; which turn wrote it is
      // beside the point here.
      let workspaceId = "";
      dependencies.conversationRepository.findByIdAndAnonymousSession = async (id: string, workspace: string) => {
        workspaceId = workspace;
        return { id, workspaceId: workspace } as never;
      };

      const { port } = server.address() as AddressInfo;
      stream = await openEventStream(
        `http://127.0.0.1:${port}/api/v1/public/chat/${chatToken}/events/${conversationId}`,
        { "x-radioso-public-session": String(publicSession.body.publicSessionToken) },
      );
      expect(stream.status).toBe(200);
      // `ready` on subscribing, and again once B's listener hears other instances.
      await vi.waitFor(() => expect(stream!.named("ready")).toHaveLength(2));

      const event = messageCreated(conversationId, workspaceId);
      a.bus.publish(event);
      await vi.waitFor(() => expect(stream!.named("message.created")).toEqual([{
        event: "message.created",
        data: { conversationId, messageId: event.messageId, createdAt: event.createdAt },
      }]));

      await dropListenerSession(b.applicationName);
      await vi.waitFor(() => expect(stream!.named("ready")).toHaveLength(3), { timeout: 5_000 });
      expect(stream.named("ready").at(-1)?.data).toEqual({ conversationId });
    } finally {
      await stream?.close();
      await new Promise<void>((resolve) => {
        server.close(() => resolve());
      });
      await a.close();
      await b.close();
    }
  });
});
