import { parseRealtimeConfig, type RealtimeConfig } from "../modules/realtime/infrastructure/config.js";
import type { RealtimeAdmissionController } from "../modules/realtime/domain/contracts.js";
import type { WorkspaceGatewayAttachment, WorkspaceGatewayConnection } from "../modules/realtime/application/workspaceGateway.js";

type HealthState = "starting" | "ready" | "degraded" | "draining" | "stopped";
type BaseHealth = "ready" | "degraded";

export interface RealtimeAuthDatabase {
  health(signal?: AbortSignal): Promise<true>;
  close(): Promise<void>;
}

export interface RealtimeSubscriberPort {
  start(signal?: AbortSignal): Promise<void>;
  onContinuity(listener: (event: { generation: number; state: "lost" | "restored" }) => void): () => void;
  subscribe(workspaceId: string, listener: (kinds: readonly string[]) => void): Promise<{ generation: number }>;
  unsubscribe(workspaceId: string, listener: (kinds: readonly string[]) => void): Promise<void>;
  close(): Promise<void>;
}

export interface RealtimeAdmissionCommandClientPort {
  start(signal?: AbortSignal): Promise<void>;
  health(): Promise<BaseHealth>;
  onHealth(listener: (health: BaseHealth) => void): () => void;
  close(): Promise<void>;
}

export type RealtimeAdmissionControllerPort = Pick<RealtimeAdmissionController, "admit" | "checkReconnect" | "onHealth"> & {
  close(): Promise<void> | void;
};

export interface RealtimeGatewayPort {
  attach(connection: WorkspaceGatewayConnection, options?: { signal?: AbortSignal }): Promise<WorkspaceGatewayAttachment>;
  onHealth?(listener: (health: { state: "degraded" | "restored" }) => void): () => void;
  shutdown(): Promise<void>;
}

export interface RealtimeServerPort {
  listen(signal?: AbortSignal): Promise<void>;
  close(): Promise<void>;
  forceDestroy(): void;
}

export interface RealtimePresenterRegistryPort {
  abortPreflight(): void;
  closeAll(): Promise<void>;
  forceDestroy(): void;
}

export interface RealtimeRuntimeTelemetry {
  healthTransition(state: HealthState): void;
  readinessGaugeDelta(delta: 1 | -1): void;
  shutdown(outcome: "complete" | "forced" | "failed", durationMs: number): void;
  error(outcome: "startup" | "shutdown"): void;
  tracing(outcome: "stop"): Promise<void> | void;
}

export type RealtimeRuntimeDependencies = {
  authDatabaseFactory(connectionString: string, options: {
    poolMax: number;
    connectionTimeoutMs: number;
    statementTimeoutMs: number;
    applicationName: string;
  }): RealtimeAuthDatabase;
  subscriberFactory(input: Record<string, unknown>): RealtimeSubscriberPort;
  admissionClientFactory(input: Record<string, unknown>): RealtimeAdmissionCommandClientPort;
  admissionControllerFactory(input: { localProcessCap: number; client?: RealtimeAdmissionCommandClientPort; config?: RealtimeConfig }): RealtimeAdmissionControllerPort;
  gatewayFactory(input: {
    maxConnections: number;
    transportLossGraceMs: number;
    subscriber?: RealtimeSubscriberPort;
    config?: RealtimeConfig;
  }): RealtimeGatewayPort;
  presenters: RealtimePresenterRegistryPort;
  server: RealtimeServerPort;
  telemetry: RealtimeRuntimeTelemetry;
};

export type RealtimeRuntimeClock = {
  now(): number;
  setTimeout(callback: () => void, delayMs: number): ReturnType<typeof setTimeout>;
  clearTimeout(token: ReturnType<typeof setTimeout>): void;
};

export type RealtimeRuntimeHandle = {
  health(): { liveness: number; readiness: number };
  shutdown(reason?: string): Promise<void>;
};

export type StartRealtimeRuntimeInput = {
  config: RealtimeConfig;
  rawConfig?: Record<string, unknown>;
  databaseConnectionString?: string;
  dependencies: RealtimeRuntimeDependencies;
  clock?: RealtimeRuntimeClock;
  dbHealthCacheMs?: number;
  signal?: AbortSignal;
};

const systemClock: RealtimeRuntimeClock = {
  now: () => performance.now(),
  setTimeout: (callback, delayMs) => setTimeout(callback, delayMs),
  clearTimeout: (token) => clearTimeout(token),
};

const abortError = () => Object.assign(new Error("Realtime runtime startup aborted"), { name: "AbortError" });

export const startRealtimeRuntime = async (input: StartRealtimeRuntimeInput): Promise<RealtimeRuntimeHandle> => {
  const config = input.rawConfig ? parseRealtimeConfig(input.rawConfig) : input.config;
  if (config.mode === "disabled") {
    let stopped = false;
    let shutdownPromise: Promise<void> | undefined;
    return {
      health: () => ({ liveness: stopped ? 503 : 200, readiness: stopped ? 503 : 200 }),
      shutdown: () => shutdownPromise ??= Promise.resolve().then(() => { stopped = true; }),
    };
  }

  const clock = input.clock ?? systemClock;
  const telemetry = input.dependencies.telemetry;
  const dbHealthCacheMs = input.dbHealthCacheMs ?? 1_000;
  telemetry.healthTransition("starting");

  let authDatabase: RealtimeAuthDatabase | undefined;
  let subscriber: RealtimeSubscriberPort | undefined;
  let admissionClient: RealtimeAdmissionCommandClientPort | undefined;
  let admissionController: RealtimeAdmissionControllerPort | undefined;
  let gateway: RealtimeGatewayPort | undefined;
  let constructionFailure: unknown;
  const construct = <T>(factory: () => T): T | undefined => {
    try {
      return factory();
    } catch (error) {
      constructionFailure ??= error;
      return undefined;
    }
  };

  authDatabase = construct(() => input.dependencies.authDatabaseFactory(
    input.databaseConnectionString ?? String(input.rawConfig?.DATABASE_URL ?? process.env.DATABASE_URL ?? ""),
    {
      poolMax: config.gateway.dbPoolMax,
      connectionTimeoutMs: config.gateway.dbAcquireTimeoutMs,
      statementTimeoutMs: config.gateway.dbStatementTimeoutMs,
      applicationName: config.gateway.dbApplicationName,
    },
  ));
  subscriber = construct(() => input.dependencies.subscriberFactory({ config }));
  admissionClient = construct(() => input.dependencies.admissionClientFactory({ config }));
  admissionController = construct(() => input.dependencies.admissionControllerFactory({
    localProcessCap: config.gateway.maxConnections,
    client: admissionClient,
    config,
  }));
  gateway = construct(() => input.dependencies.gatewayFactory({
    maxConnections: config.gateway.maxConnections,
    transportLossGraceMs: config.gateway.transportLossGraceMs,
    subscriber,
    config,
  }));

  const rollback = async (): Promise<void> => {
    await settleCall(() => input.dependencies.server.close());
    await settleCall(() => gateway?.shutdown());
    await settleCall(() => admissionController?.close());
    await settleCall(() => admissionClient?.close());
    await settleCall(() => subscriber?.close());
    await settleCall(() => authDatabase?.close());
  };

  if (constructionFailure || !authDatabase || !subscriber || !admissionClient || !admissionController || !gateway) {
    telemetry.error("startup");
    await rollback();
    await telemetry.tracing("stop");
    throw constructionFailure ?? new Error("Realtime runtime resource construction failed");
  }

  let phase: HealthState = "starting";
  let dbReady = false;
  let subscriberReady = false;
  let admissionClientReady = false;
  let admissionControllerReady = true;
  let gatewayReady = true;
  let intakeReady = false;
  let readiness = false;
  let dbProbedAt = Number.NEGATIVE_INFINITY;
  let dbProbe: Promise<void> | undefined;
  let subscriberHealthVersion = 0;
  let subscriberGeneration = -1;
  let admissionClientHealthVersion = 0;
  const removers: Array<() => void> = [];
  let shutdownPromise: Promise<void> | undefined;

  const transition = (next: HealthState): void => {
    if (phase === next) return;
    phase = next;
    telemetry.healthTransition(next);
  };
  const refreshReadiness = (): void => {
    if (phase === "draining" || phase === "stopped") return;
    const next = intakeReady && dbReady && subscriberReady && admissionClientReady && admissionControllerReady && gatewayReady;
    if (next === readiness) {
      if (intakeReady && !next && phase === "starting") transition("degraded");
      return;
    }
    readiness = next;
    telemetry.readinessGaugeDelta(next ? 1 : -1);
    transition(next ? "ready" : "degraded");
  };
  const runDbProbe = (): Promise<void> => {
    if (dbProbe) return dbProbe;
    dbProbe = authDatabase.health().then(() => {
      dbReady = true;
      dbProbedAt = clock.now();
    }, () => {
      dbReady = false;
      dbProbedAt = clock.now();
    }).then(() => {
      dbProbe = undefined;
      refreshReadiness();
    });
    return dbProbe;
  };

  try {
    removers.push(subscriber.onContinuity((event) => {
      if (event.generation < subscriberGeneration) return;
      subscriberGeneration = event.generation;
      subscriberHealthVersion += 1;
      subscriberReady = event.state === "restored";
      refreshReadiness();
    }));
    removers.push(admissionClient.onHealth((health) => {
      admissionClientHealthVersion += 1;
      admissionClientReady = health === "ready";
      refreshReadiness();
    }));
    removers.push(admissionController.onHealth((health) => {
      admissionControllerReady = health.state === "restored";
      refreshReadiness();
    }));
    if (gateway.onHealth) {
      removers.push(gateway.onHealth((health) => {
        gatewayReady = health.state === "restored";
        refreshReadiness();
      }));
    }

    await abortable(() => authDatabase.health(input.signal), input.signal);
    dbReady = true;
    dbProbedAt = clock.now();
    const subscriberVersionBeforeStart = subscriberHealthVersion;
    await abortable(() => subscriber.start(input.signal), input.signal);
    if (subscriberHealthVersion === subscriberVersionBeforeStart) subscriberReady = true;
    await abortable(() => admissionClient.start(input.signal), input.signal);
    const admissionVersionBeforeHealth = admissionClientHealthVersion;
    const admissionHealth = await abortable(() => admissionClient.health(), input.signal);
    if (admissionClientHealthVersion === admissionVersionBeforeHealth) admissionClientReady = admissionHealth === "ready";
    await abortable(() => input.dependencies.server.listen(input.signal), input.signal);
    intakeReady = true;
    refreshReadiness();
  } catch (error) {
    for (const remove of removers.splice(0)) remove();
    telemetry.error("startup");
    await rollback();
    await telemetry.tracing("stop");
    throw error;
  }

  const health = () => {
    if (phase !== "draining" && phase !== "stopped" && clock.now() - dbProbedAt > dbHealthCacheMs && !dbProbe) {
      void runDbProbe();
    }
    return {
      liveness: phase === "stopped" ? 503 : 200,
      readiness: readiness && phase === "ready" ? 200 : 503,
    };
  };

  const shutdown = (_reason?: string): Promise<void> => {
    if (shutdownPromise) return shutdownPromise;
    shutdownPromise = (async () => {
      const startedAt = clock.now();
      let failed = false;
      let forced = false;
      intakeReady = false;
      if (readiness) {
        readiness = false;
        telemetry.readinessGaugeDelta(-1);
      }
      transition("draining");
      for (const remove of removers.splice(0)) remove();

      const serverClose = captureCall(() => input.dependencies.server.close(), () => { failed = true; });
      input.dependencies.presenters.abortPreflight();
      const gatewayClose = captureCall(() => gateway.shutdown(), () => { failed = true; });
      const presenterClose = captureCall(() => input.dependencies.presenters.closeAll(), () => { failed = true; });

      let deadlineToken: ReturnType<typeof setTimeout> | undefined;
      const deadline = new Promise<void>((resolve) => {
        deadlineToken = clock.setTimeout(() => {
          deadlineToken = undefined;
          forced = true;
          input.dependencies.presenters.forceDestroy();
          input.dependencies.server.forceDestroy();
          resolve();
        }, config.gateway.shutdownDrainMs);
      });
      const drained = Promise.allSettled([serverClose, gatewayClose, presenterClose]).then(() => undefined);
      await Promise.race([drained, deadline]);

      // The intake deadline bounds only active streams. Even after it expires,
      // runtime-owned Redis and database handles must settle before stopped.
      await captureCall(() => admissionController.close(), () => { failed = true; });
      await captureCall(() => admissionClient.close(), () => { failed = true; });
      await captureCall(() => subscriber.close(), () => { failed = true; });
      await captureCall(() => authDatabase.close(), () => { failed = true; });
      let acceptTracingFailure = true;
      const tracingStop = captureCall(
        () => telemetry.tracing("stop"),
        () => { if (acceptTracingFailure) failed = true; },
      );
      await untilDeadline(tracingStop, deadline);
      acceptTracingFailure = false;
      if (!forced && deadlineToken !== undefined) {
        clock.clearTimeout(deadlineToken);
        deadlineToken = undefined;
      }
      transition("stopped");
      const outcome = failed ? "failed" : forced ? "forced" : "complete";
      if (failed) telemetry.error("shutdown");
      telemetry.shutdown(outcome, Math.max(0, clock.now() - startedAt));
    })();
    return shutdownPromise;
  };

  return { health, shutdown };
};

const settleCall = async (run: () => Promise<void> | void | undefined): Promise<void> => {
  try {
    await run();
  } catch {
    // Startup rollback is best effort and must continue in reverse order.
  }
};

const captureCall = (run: () => Promise<void> | void, onFailure: () => void): Promise<void> => {
  try {
    return Promise.resolve(run()).catch(() => { onFailure(); });
  } catch {
    onFailure();
    return Promise.resolve();
  }
};

const untilDeadline = (operation: Promise<void>, deadline: Promise<void>): Promise<void> =>
  Promise.race([operation, deadline]);

const abortable = async <T>(run: () => Promise<T>, signal?: AbortSignal): Promise<T> => {
  if (!signal) return run();
  if (signal.aborted) throw abortError();
  return await new Promise<T>((resolve, reject) => {
    let settled = false;
    const finish = (complete: () => void): void => {
      if (settled) return;
      settled = true;
      signal.removeEventListener("abort", onAbort);
      complete();
    };
    const onAbort = () => finish(() => reject(abortError()));
    signal.addEventListener("abort", onAbort, { once: true });
    try {
      run().then(
        (value) => finish(() => resolve(value)),
        (error) => finish(() => reject(error)),
      );
    } catch (error) {
      finish(() => reject(error));
    }
  });
};
