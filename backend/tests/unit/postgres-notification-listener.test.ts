import type { ClientConfig } from "pg";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { PostgresNotificationListener } from "../../src/shared/infra/postgresNotificationListener.js";
import { fakeNotificationClients } from "../support/fakeNotificationClient.js";

// Real sessions on a shared database are covered by
// tests/integration/public-conversation-events.integration.test.ts; these drive the listener
// against a client the test plays the server's side of.

const handlers = () => ({
  notification: vi.fn<(payload: string) => void>(),
  listening: vi.fn<(state: { mayHaveMissed: boolean }) => void>(),
  interrupted: vi.fn<() => void>(),
});

const listens = (queries: string[]) => queries.filter((query) => query.startsWith("LISTEN"));

describe("PostgresNotificationListener", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  const createListener = (options: Partial<ConstructorParameters<typeof PostgresNotificationListener>[0]> = {}) => {
    const transport = fakeNotificationClients();
    const configs: ClientConfig[] = [];
    const listener = new PostgresNotificationListener({
      connectionString: "postgresql://listener.example/radioso",
      idleCloseMs: 0,
      reconnectDelay: { initialMs: 1_000, maxMs: 8_000 },
      createClient: (config) => {
        configs.push(config);
        return transport.createClient();
      },
      ...options,
    });
    return { listener, transport, configs };
  };

  it("tells a subscriber that joins a channel the session already listens to that it missed nothing", async () => {
    const { listener, transport } = createListener();
    const first = handlers();
    const second = handlers();

    listener.subscribe("radioso_events", first);
    await vi.advanceTimersByTimeAsync(0);
    listener.subscribe("radioso_events", second);
    await vi.advanceTimersByTimeAsync(0);

    expect(first.listening).toHaveBeenCalledExactlyOnceWith({ mayHaveMissed: true });
    expect(second.listening).toHaveBeenCalledExactlyOnceWith({ mayHaveMissed: false });
    expect(listens(transport.latest().queries)).toEqual(['LISTEN "radioso_events"']);
    await listener.close();
  });

  it("keeps listening to a channel its last subscriber left while the connection stays open", async () => {
    const { listener, transport } = createListener();
    const first = handlers();
    const unsubscribe = listener.subscribe("radioso_events", first);
    await vi.advanceTimersByTimeAsync(0);
    unsubscribe();

    const returning = handlers();
    listener.subscribe("radioso_events", returning);
    await vi.advanceTimersByTimeAsync(0);

    expect(returning.listening).toHaveBeenCalledExactlyOnceWith({ mayHaveMissed: false });
    expect(transport.clients).toHaveLength(1);
    expect(listens(transport.latest().queries)).toHaveLength(1);
    await listener.close();
  });

  it("treats a health check that gets no answer as a dropped connection, and reconnects", async () => {
    const { listener, transport, configs } = createListener({
      healthCheck: { intervalMs: 30_000, timeoutMs: 5_000 },
      random: () => 0,
    });
    const subscriber = handlers();
    listener.subscribe("radioso_events", subscriber);
    await vi.advanceTimersByTimeAsync(0);
    // The server stops answering without the connection being reset.
    transport.latest().answer = () => new Promise(() => undefined);

    await vi.advanceTimersByTimeAsync(30_000);
    expect(subscriber.interrupted).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(5_000);
    expect(subscriber.interrupted).toHaveBeenCalledOnce();
    expect(transport.clients[0].ended).toBe(true);

    await vi.advanceTimersByTimeAsync(500);
    expect(transport.clients).toHaveLength(2);
    expect(subscriber.listening).toHaveBeenLastCalledWith({ mayHaveMissed: true });
    expect(subscriber.listening).toHaveBeenCalledTimes(2);
    // TCP keepalive probes start after ten seconds of silence as well.
    expect(configs.every((config) => config.keepAlive && config.keepAliveInitialDelayMillis === 10_000)).toBe(true);
    await listener.close();
  });

  it("keeps a session whose health check is answered", async () => {
    const { listener, transport } = createListener({ healthCheck: { intervalMs: 30_000, timeoutMs: 5_000 } });
    const subscriber = handlers();
    listener.subscribe("radioso_events", subscriber);

    await vi.advanceTimersByTimeAsync(95_000);

    expect(transport.latest().queries.filter((query) => query === "SELECT 1")).toHaveLength(3);
    expect(subscriber.interrupted).not.toHaveBeenCalled();
    expect(transport.clients).toHaveLength(1);
    await listener.close();
  });

  it("waits a random share, between half and all, of the backoff before reconnecting", async () => {
    const draws = [0, 0.999];
    const { listener, transport } = createListener({ random: () => draws.shift() ?? 0 });
    listener.subscribe("radioso_events", handlers());
    await vi.advanceTimersByTimeAsync(0);

    transport.latest().drop();
    await vi.advanceTimersByTimeAsync(499);
    expect(transport.clients).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(transport.clients).toHaveLength(2);

    // Reconnecting reset the backoff; a draw near 1 takes nearly all of the first second.
    transport.latest().drop();
    await vi.advanceTimersByTimeAsync(998);
    expect(transport.clients).toHaveLength(2);
    await vi.advanceTimersByTimeAsync(2);
    expect(transport.clients).toHaveLength(3);
    await listener.close();
  });
});
