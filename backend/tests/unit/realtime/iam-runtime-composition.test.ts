import { describe, expect, it, vi } from "vitest";

import { createRealtimeComposition } from "../../../src/app/composition/realtimeComposition.js";
import { parseRealtimeConfig } from "../../../src/modules/realtime/infrastructure/config.js";
import type { AppLogger } from "../../../src/shared/observability/logger.js";
import { startRealtimeRuntime } from "../../../src/runtime/startRealtimeRuntime.js";

type FakeRedisCredentialProvider = {
  type: "async-credentials-provider";
  credentials(): Promise<{ username?: string; password: string }>;
};
type FakeRedisOptions = Record<string, unknown> & {
  defaults?: Record<string, unknown> & { credentialsProvider?: FakeRedisCredentialProvider };
  credentialsProvider?: FakeRedisCredentialProvider;
};

type FakeRedisClient = {
  options: FakeRedisOptions;
  connect: ReturnType<typeof vi.fn>;
  close: ReturnType<typeof vi.fn>;
  on: ReturnType<typeof vi.fn>;
  reconnect(): Promise<void>;
};

const redis = vi.hoisted(() => ({
  createClient: vi.fn(),
  createCluster: vi.fn(),
  clients: [] as FakeRedisClient[],
}));

vi.mock("redis", () => redis);

vi.mock("../../../src/runtime/realtimeServer.js", () => ({
  createRealtimeServer: vi.fn(() => ({
    listen: vi.fn(async () => undefined),
    close: vi.fn(async () => undefined),
    forceDestroy: vi.fn(),
  })),
}));

const workspaceConfig = () => parseRealtimeConfig({
  REALTIME_MODE: "redis-cluster",
  REALTIME_REDIS_SEEDS: "rediss://one:6379,rediss://two:6379",
  REALTIME_REDIS_TLS: true,
  REALTIME_REDIS_IAM: true,
  REALTIME_ROLLOUT_MODE: "default-on",
});

const loggerSpies = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
const logger = loggerSpies as unknown as AppLogger;
const metadataTokenEndpoint = "http://metadata.google.internal/computeMetadata/v1/instance/service-accounts/default/token";
type MetadataFetch = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;
const hasMetadataFlavor = (init?: RequestInit): boolean => {
  const headers = init?.headers;
  if (headers instanceof Headers) return headers.get("Metadata-Flavor") === "Google";
  if (Array.isArray(headers)) return headers.some(([key, value]) => key.toLowerCase() === "metadata-flavor" && value === "Google");
  return typeof headers === "object" && headers !== null && (headers)["Metadata-Flavor"] === "Google";
};

const makeClient = (options: FakeRedisOptions): FakeRedisClient => {
  const listeners = new Map<string, Set<() => void>>();
  const credentialsProvider = options.credentialsProvider ?? options.defaults?.credentialsProvider;
  const client: FakeRedisClient = {
    options,
    connect: vi.fn(async () => {
      await credentialsProvider?.credentials();
      for (const listener of listeners.get("ready") ?? []) listener();
    }),
    close: vi.fn(async () => undefined),
    on: vi.fn((event: string, listener: () => void) => {
      const eventListeners = listeners.get(event) ?? new Set();
      eventListeners.add(listener);
      listeners.set(event, eventListeners);
    }),
    reconnect: async () => {
      for (const listener of listeners.get("reconnecting") ?? []) listener();
      await credentialsProvider?.credentials();
      for (const listener of listeners.get("ready") ?? []) listener();
    },
  };
  return client;
};

const installRedisMocks = (): void => {
  redis.clients.length = 0;
  redis.createClient.mockReset();
  redis.createCluster.mockReset();
  redis.createClient.mockImplementation((options: FakeRedisOptions) => {
    const client = makeClient(options);
    redis.clients.push(client);
    return client;
  });
  redis.createCluster.mockImplementation((options: FakeRedisOptions) => {
    const client = makeClient(options);
    redis.clients.push(client);
    return client;
  });
};

const compositionInput = (config = workspaceConfig()) => ({
  config,
  databaseUrl: "postgres://realtime.test",
  logger,
  port: 0,
  sessionCookieName: "radioso_session",
});

describe("realtime IAM composition", () => {
  it("resolves ADC/metadata credentials in the production composition path and refreshes both Redis roles", async () => {
    installRedisMocks();
    let tokenNumber = 0;
    const metadataFetch = vi.fn<MetadataFetch>(async () => new Response(JSON.stringify({ access_token: `adc-token-${++tokenNumber}` }), { status: 200 }));
    vi.stubGlobal("fetch", metadataFetch);
    const composition = createRealtimeComposition(compositionInput());

    const subscriber = composition.dependencies.subscriberFactory({});
    const admissionClient = composition.dependencies.admissionClientFactory({});
    await subscriber.start();
    await admissionClient.start();
    await redis.clients[0].reconnect();
    await redis.clients[1].reconnect();

    expect(redis.clients).toHaveLength(2);
    const providers = redis.clients.map((client) => client.options.defaults?.credentialsProvider);
    expect(providers).toHaveLength(2);
    expect(providers[0]).toBeDefined();
    expect(providers[1]).toBeDefined();
    expect((redis.clients[0].options.defaults?.credentialsProvider as FakeRedisCredentialProvider).type).toBe("async-credentials-provider");
    expect((redis.clients[1].options.defaults?.credentialsProvider as FakeRedisCredentialProvider).type).toBe("async-credentials-provider");
    expect(redis.clients[0].options.defaults?.socket).toEqual({ connectTimeout: 2_000, tls: true });
    expect(redis.clients[1].options.defaults?.socket).toEqual({ connectTimeout: 2_000, tls: true });
    expect(metadataFetch).toHaveBeenCalledTimes(4);
    expect(await providers[0]!.credentials()).toEqual({ username: "default", password: "adc-token-5" });
    expect(await providers[1]!.credentials()).toEqual({ username: "default", password: "adc-token-6" });
    expect(metadataFetch).toHaveBeenCalledTimes(6);
    expect(metadataFetch.mock.calls.every(([url, options]) => url === metadataTokenEndpoint && hasMetadataFlavor(options))).toBe(true);
    expect(JSON.stringify(metadataFetch.mock.calls)).not.toContain("adc-token");

    await subscriber.close();
    await admissionClient.close();
    vi.unstubAllGlobals();
  });

  it.each([0, 1])("fails closed when the %s Redis role cannot refresh credentials during reconnect", async (roleIndex) => {
    installRedisMocks();
    const metadataFetch = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ access_token: "initial-token" }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ access_token: "initial-token-2" }), { status: 200 }))
      .mockRejectedValue(new Error("secret-token"));
    vi.stubGlobal("fetch", metadataFetch);
    const composition = createRealtimeComposition(compositionInput());
    const subscriber = composition.dependencies.subscriberFactory({});
    const admissionClient = composition.dependencies.admissionClientFactory({});
    await subscriber.start();
    await admissionClient.start();

    await expect(redis.clients[roleIndex].reconnect()).rejects.toThrow();
    expect(metadataFetch).toHaveBeenCalled();
    expect(JSON.stringify(loggerSpies.error.mock.calls)).not.toContain("secret-token");
    await subscriber.close();
    await admissionClient.close();
    vi.unstubAllGlobals();
  });

  it("never contacts metadata when IAM is disabled", async () => {
    installRedisMocks();
    const metadataFetch = vi.fn();
    vi.stubGlobal("fetch", metadataFetch);
    const config = parseRealtimeConfig({
      REALTIME_MODE: "redis-cluster",
      REALTIME_REDIS_SEEDS: "rediss://one:6379,rediss://two:6379",
      REALTIME_REDIS_TLS: true,
      REALTIME_REDIS_IAM: false,
      REALTIME_ROLLOUT_MODE: "default-on",
    });
    const composition = createRealtimeComposition(compositionInput(config));

    const subscriber = composition.dependencies.subscriberFactory({});
    const admissionClient = composition.dependencies.admissionClientFactory({});
    await subscriber.start();
    await admissionClient.start();
    expect(metadataFetch).not.toHaveBeenCalled();
    await subscriber.close();
    await admissionClient.close();
    vi.unstubAllGlobals();
  });

  it.each([
    ["non-OK metadata", async () => new Response("nope", { status: 503 })],
    ["malformed metadata", async () => new Response(JSON.stringify({ access_token: 7 }), { status: 200 })],
    ["tokenless metadata", async () => new Response(JSON.stringify({ expires_in: 300 }), { status: 200 })],
    ["metadata failure", async () => { throw new Error("secret-token"); }],
  ])("fails before listen/ready for %s and does not serialize credential material", async (_name, response) => {
    installRedisMocks();
    const metadataFetch = vi.fn(response);
    vi.stubGlobal("fetch", metadataFetch);
    const composition = createRealtimeComposition(compositionInput());
    const listen = vi.fn(async () => undefined);
    composition.dependencies.authDatabaseFactory = () => ({
      health: async () => true,
      close: async () => undefined,
    });
    composition.dependencies.server = {
      listen,
      close: vi.fn(async () => undefined),
      forceDestroy: vi.fn(),
    };

    let startupError: unknown;
    try {
      await startRealtimeRuntime({ config: workspaceConfig(), databaseConnectionString: "postgres://realtime.test", dependencies: composition.dependencies });
    } catch (error) {
      startupError = error;
    }
    expect(startupError).toBeDefined();
    expect(String(startupError)).not.toContain("secret-token");
    expect(listen).not.toHaveBeenCalled();
    const serialized = JSON.stringify({ logs: loggerSpies.info.mock.calls.concat(loggerSpies.warn.mock.calls, loggerSpies.error.mock.calls) });
    expect(serialized).not.toContain("secret-token");
    expect(JSON.stringify(metadataFetch.mock.calls)).not.toContain("secret-token");
    vi.unstubAllGlobals();
  });
});
