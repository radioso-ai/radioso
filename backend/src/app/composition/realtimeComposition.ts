import { randomUUID } from "node:crypto";

import { sql } from "kysely";

import { WorkspaceGateway } from "../../modules/realtime/application/workspaceGateway.js";
import { createRealtimeRolloutPolicy } from "../../modules/realtime/domain/realtimeRolloutPolicy.js";
import { PostgresRealtimeSessionStore } from "../../modules/realtime/http/postgresRealtimeSessionStore.js";
import { RealtimeSessionAuthenticator } from "../../modules/realtime/http/realtimeSessionAuthenticator.js";
import { createWorkspaceEventsRoutes } from "../../modules/realtime/http/workspaceEventsRoutes.js";
import type { RealtimeConfig } from "../../modules/realtime/infrastructure/config.js";
import { RealtimePresenterRegistry } from "../../modules/realtime/infrastructure/realtimePresenterRegistry.js";
import { RedisAdmissionCommandClient } from "../../modules/realtime/infrastructure/redisAdmissionCommandClient.js";
import { RedisAdmissionController } from "../../modules/realtime/infrastructure/redisAdmissionController.js";
import {
  createNodeRedisClientFactory,
  RedisWorkspaceInterestSubscriber,
  type RedisCredentialsProvider,
} from "../../modules/realtime/infrastructure/redisInvalidationTransport.js";
import { Database } from "../../shared/infra/database.js";
import type { AppLogger } from "../../shared/observability/logger.js";
import { MetricsRegistry } from "../../shared/observability/metrics/metricsRegistry.js";
import { createRealtimeServer } from "../../runtime/realtimeServer.js";
import { resolveGcpRedisCredentialsProvider } from "../../runtime/gcpMetadataRedisCredentials.js";
import type {
  RealtimeRuntimeDependencies,
  RealtimeRuntimeHandle,
  RealtimeRuntimeTelemetry,
} from "../../runtime/startRealtimeRuntime.js";

export type RealtimeComposition = {
  dependencies: RealtimeRuntimeDependencies;
  setRuntime(runtime: RealtimeRuntimeHandle): void;
};

export const createRealtimeComposition = (input: {
  config: RealtimeConfig;
  databaseUrl: string;
  logger: AppLogger;
  metrics?: MetricsRegistry;
  port: number;
  /** Test-only composition seam; production uses workload metadata when IAM is enabled. */
  resolveRedisCredentialsProvider?: (iamEnabled: true) => RedisCredentialsProvider;
  random?: () => number;
  sessionCookieName: string;
  stopTracing?: () => Promise<void>;
}): RealtimeComposition => {
  const metrics = input.metrics ?? new MetricsRegistry();
  const redisCredentialsProvider = input.config.redis.iam
    ? (input.resolveRedisCredentialsProvider ?? resolveGcpRedisCredentialsProvider)(true)
    : undefined;
  const presenters = new RealtimePresenterRegistry(input.config.gateway.maxConnections);
  const telemetry = createRuntimeTelemetry(metrics, input.logger, input.stopTracing);
  let database: Database | undefined;
  let authenticator: RealtimeSessionAuthenticator | undefined;
  let subscriber: RedisWorkspaceInterestSubscriber | undefined;
  let admissionClient: RedisAdmissionCommandClient | undefined;
  let admissionController: RedisAdmissionController | undefined;
  let gateway: WorkspaceGateway | undefined;
  let runtimeHealth = () => ({ liveness: 200, readiness: 503 });

  const rollout = createRealtimeRolloutPolicy(input.config.rollout);
  const routes = createWorkspaceEventsRoutes({
    authenticate: (request) => {
      if (!authenticator) return Promise.reject(new Error("Realtime authentication is not initialized"));
      return authenticator.authenticate(request);
    },
    rollout,
    admission: {
      admit: (request) => {
        if (!admissionController) return Promise.reject(new Error("Realtime admission is not initialized"));
        return admissionController.admit(request);
      },
      checkReconnect: (request) => {
        if (!admissionController) return Promise.reject(new Error("Realtime admission is not initialized"));
        return admissionController.checkReconnect(request);
      },
    },
    gateway: {
      attach: (connection, options) => {
        if (!gateway) return Promise.reject(new Error("Realtime gateway is not initialized"));
        return gateway.attach(connection, options);
      },
    },
    sessionCookieName: input.sessionCookieName,
    limits: {
      streamAgeMs: input.config.gateway.streamAgeMaxMs,
      gatewayTimeoutMs: input.config.gateway.timeoutMs,
      edgeTimeoutMs: input.config.gateway.edgeTimeoutMs,
      heartbeatMs: input.config.gateway.heartbeatMs,
      blockedDurationMs: input.config.gateway.blockedDurationMs,
      blockedWritableBytes: input.config.gateway.blockedWritableBytes,
      frameBytes: 4 * 1024,
      authTimeoutMs: input.config.gateway.authTimeoutMs,
      subscribeTimeoutMs: input.config.gateway.subscribeTimeoutMs,
    },
    clock: createPresenterClock(),
    presenters,
    shutdown: presenters.shutdownSignal,
    streamAgeMs: createStreamAgeSampler(input.config.gateway.streamAgeMinMs, input.config.gateway.streamAgeMaxMs, input.random),
    streamTelemetry: createStreamTelemetry(metrics),
    telemetry: createRouteTelemetry(metrics),
  });
  const server = createRealtimeServer({
    eventsPath: input.config.publicPath,
    eventsRouter: routes,
    health: () => runtimeHealth(),
    port: input.port,
  });
  const redisClientFactory = createNodeRedisClientFactory({
    connectTimeoutMs: input.config.redis.connectTimeoutMs,
    credentialsProvider: redisCredentialsProvider,
    queuedCommands: input.config.redis.queuedCommands,
    seeds: input.config.redis.seeds,
    tls: input.config.redis.tls,
    url: input.config.redis.url,
  });

  const dependencies: RealtimeRuntimeDependencies = {
    authDatabaseFactory: (connectionString, options) => {
      database = new Database(connectionString || input.databaseUrl, options);
      authenticator = new RealtimeSessionAuthenticator({
        store: new PostgresRealtimeSessionStore(database.kysely),
      });
      return {
        health: async () => {
          await sql`SELECT 1`.execute(database!.kysely);
          return true;
        },
        close: () => database!.close(),
      };
    },
    subscriberFactory: () => {
      subscriber = new RedisWorkspaceInterestSubscriber({
        channelPrefix: input.config.redis.channelPrefix,
        commandTimeoutMs: input.config.redis.commandTimeoutMs,
        createClient: redisClientFactory,
        credentialsProvider: redisCredentialsProvider,
        mode: input.config.mode === "redis-cluster" ? "redis-cluster" : "standalone",
        maxWorkspaceInterests: input.config.gateway.maxWorkspaceInterests,
        telemetry: createTransportTelemetry(metrics),
      });
      return subscriber;
    },
    admissionClientFactory: () => {
      admissionClient = new RedisAdmissionCommandClient({
        mode: input.config.mode === "redis-cluster" ? "redis-cluster" : "standalone",
        url: input.config.redis.url,
        seeds: input.config.redis.seeds,
        tls: input.config.redis.tls,
        queuedCommands: input.config.redis.queuedCommands,
        connectTimeoutMs: input.config.redis.connectTimeoutMs,
        commandTimeoutMs: input.config.redis.commandTimeoutMs,
        credentialsProvider: redisCredentialsProvider,
        telemetry: createAdmissionCommandTelemetry(metrics),
      });
      return admissionClient;
    },
    admissionControllerFactory: ({ localProcessCap }) => {
      if (!admissionClient) throw new Error("Realtime admission client is not initialized");
      admissionController = new RedisAdmissionController({
        redis: admissionClient,
        prefix: input.config.redis.channelPrefix,
        instanceId: randomUUID(),
        limits: {
          account: input.config.admission.accountLimit,
          workspace: input.config.admission.workspaceLimit,
          principal: input.config.admission.principalLimit,
          pendingPerAggregate: input.config.admission.principalLimit,
          leaseTtlMs: input.config.admission.leaseTtlMs,
          renewalMs: input.config.admission.renewalMs,
          renewalJitterPercent: input.config.admission.renewalJitterPercent,
          safetyMs: input.config.admission.safetyMs,
          closeJitterMaxMs: input.config.admission.closeJitterMaxMs,
          cleanupLimit: input.config.admission.cleanupLimit,
          localProcessCap,
          reconnect: {
            account: { limit: input.config.reconnect.accountPerMinute, windowMs: 60_000, burst: input.config.reconnect.accountBurst },
            workspace: { limit: input.config.reconnect.workspacePerMinute, windowMs: 60_000, burst: input.config.reconnect.workspaceBurst },
            principal: { limit: input.config.reconnect.principalPerMinute, windowMs: 60_000, burst: input.config.reconnect.principalBurst },
          },
        },
        telemetry: createAdmissionTelemetry(metrics),
      });
      return admissionController;
    },
    gatewayFactory: ({ maxConnections, transportLossGraceMs }) => {
      if (!subscriber) throw new Error("Realtime subscriber is not initialized");
      gateway = new WorkspaceGateway({
        continuity: subscriber,
        maxWorkspaces: Math.min(maxConnections, input.config.gateway.maxWorkspaceInterests),
        releaseGraceMs: input.config.gateway.interestReleaseGraceMs,
        telemetry: createGatewayTelemetry(metrics),
        transport: subscriber,
        transportLossGraceMs,
      });
      return gateway;
    },
    presenters,
    server,
    telemetry,
  };

  return {
    dependencies,
    setRuntime: (runtime) => { runtimeHealth = () => runtime.health(); },
  };
};

const createStreamAgeSampler = (min: number, max: number, random: () => number = Math.random): (() => number) => {
  const window = max - min;
  return () => min + Math.floor(Math.min(1 - Number.EPSILON, Math.max(0, random())) * window);
};

const createTransportTelemetry = (metrics: MetricsRegistry) => ({
  event: (outcome: "connected" | "reconnect" | "failed") => metrics.incrementCounter("realtime_transport_events_total", {
    help: "Realtime Redis transport lifecycle events",
    labels: { outcome },
  }),
});

const createAdmissionCommandTelemetry = (metrics: MetricsRegistry) => ({
  event: (outcome: "ready" | "degraded") => metrics.incrementCounter("realtime_admission_command_events_total", {
    help: "Realtime admission command client lifecycle events",
    labels: { outcome },
  }),
});

const createAdmissionTelemetry = (metrics: MetricsRegistry) => ({
  event: (outcome: "accepted" | "rejected" | "degraded") => metrics.incrementCounter("realtime_admission_events_total", {
    help: "Realtime admission decisions",
    labels: { outcome },
  }),
});

const createGatewayTelemetry = (metrics: MetricsRegistry) => ({
  event: (outcome: "subscribed" | "released" | "resync") => metrics.incrementCounter("realtime_gateway_events_total", {
    help: "Realtime gateway events",
    labels: { outcome },
  }),
  state: (state: { interests: number; sessions: number; waiters: number }) => {
    metrics.setGauge("realtime_gateway_interests", { help: "Realtime gateway workspace interests", value: state.interests });
    metrics.setGauge("realtime_gateway_sessions", { help: "Realtime gateway sessions", value: state.sessions });
    metrics.setGauge("realtime_gateway_waiters", { help: "Realtime gateway subscribe waiters", value: state.waiters });
  },
});

const createRouteTelemetry = (metrics: MetricsRegistry) => ({
  outcome: (outcome: "invalid" | "auth" | "disabled" | "overload" | "ready") => metrics.incrementCounter("realtime_route_outcomes_total", {
    help: "Realtime route outcomes",
    labels: { outcome },
  }),
});

const createStreamTelemetry = (metrics: MetricsRegistry) => {
  let active = 0;
  let blocked = 0;
  return {
    gaugeDelta: (name: "active" | "blocked", delta: 1 | -1) => {
      if (name === "active") {
        active += delta;
        metrics.setGauge("realtime_stream_active", { help: "Active realtime streams", value: active });
      } else {
        blocked += delta;
        metrics.setGauge("realtime_stream_blocked", { help: "Backpressured realtime streams", value: blocked });
      }
    },
    counter: (outcome: "opened" | "ready" | "slow" | "expired" | "closed") => metrics.incrementCounter("realtime_stream_events_total", {
      help: "Realtime stream lifecycle events",
      labels: { outcome },
    }),
    histogram: (name: "time_to_ready" | "lifetime" | "blocked_duration" | "backlog", value: number) => metrics.observeHistogram(
      name === "backlog" ? "realtime_stream_backlog_bytes" : `realtime_stream_${name}_ms`,
      {
        help: name === "backlog" ? "Realtime stream buffered bytes" : `Realtime stream ${name}`,
        value,
      },
    ),
  };
};

const createPresenterClock = () => {
  let nextTimer = 1;
  const handles = new Map<number, ReturnType<typeof setTimeout>>();
  return {
    monotonicNow: () => performance.now(),
    wallNow: () => Date.now(),
    setTimeout: (callback: () => void, delay: number) => {
      const id = nextTimer++;
      handles.set(id, setTimeout(() => {
        handles.delete(id);
        callback();
      }, delay));
      return id;
    },
    clearTimeout: (id: number) => {
      const handle = handles.get(id);
      if (handle) clearTimeout(handle);
      handles.delete(id);
    },
  };
};

const createRuntimeTelemetry = (
  metrics: MetricsRegistry,
  logger: AppLogger,
  stopTracing?: () => Promise<void>,
): RealtimeRuntimeTelemetry => {
  let readiness = 0;
  return {
    healthTransition: (state) => metrics.incrementCounter("realtime_runtime_health_transitions_total", {
      help: "Realtime runtime health transitions",
      labels: { state },
    }),
    readinessGaugeDelta: (delta) => {
      readiness += delta;
      metrics.setGauge("realtime_runtime_ready", { help: "Realtime runtime readiness", value: readiness });
    },
    shutdown: (outcome, durationMs) => {
      metrics.incrementCounter("realtime_runtime_shutdown_total", { help: "Realtime runtime shutdowns", labels: { outcome } });
      metrics.observeHistogram("realtime_runtime_shutdown_duration_ms", { help: "Realtime runtime shutdown duration", value: durationMs });
      logger.info({ role: "realtime", outcome, durationMs }, "Realtime runtime stopped");
    },
    error: (outcome) => metrics.incrementCounter("realtime_runtime_errors_total", {
      help: "Realtime runtime lifecycle errors",
      labels: { outcome },
    }),
    tracing: async () => { await stopTracing?.(); },
  };
};
