import { createServer, type Server, type Socket } from "node:net";
import express from "express";
import { DatabaseError } from "pg";
import request from "supertest";
import { afterEach, describe, expect, it, vi } from "vitest";

import { createErrorHandler } from "../../src/app/http/middleware/errorHandler.js";
import { createDocumentWorkerTaskRoutes } from "../../src/app/worker/documentWorkerTaskRoutes.js";
import { serviceUnavailable } from "../../src/shared/domain/errors.js";
import { ErrorReportingService } from "../../src/shared/errors/errorReportingService.js";
import type { ErrorSink } from "../../src/shared/errors/errorSink.js";
import { Database } from "../../src/shared/infra/database.js";
import { createMatchedRouteRecorder } from "../../src/shared/observability/matchedRoute.js";

// A Postgres stand-in at the TCP level: `silent` accepts a connection and never answers the
// startup message, the way an instance that is restarting or starved looks to a client; `closing`
// reads the startup message and hangs up, the way a server that ends the session does.
const startFakePostgres = async (behaviour: "silent" | "closing"): Promise<{ port: number; close: () => Promise<void> }> => {
  const sockets = new Set<Socket>();
  const server: Server = createServer((socket) => {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
    socket.on("error", () => undefined);
    if (behaviour === "closing") {
      socket.once("data", () => socket.end());
    }
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("fake Postgres has no port");
  }
  return {
    port: address.port,
    close: async () => {
      for (const socket of sockets) {
        socket.destroy();
      }
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
};

const cleanups: Array<() => Promise<void>> = [];

afterEach(async () => {
  while (cleanups.length > 0) {
    await cleanups.pop()?.();
  }
});

const databaseAt = async (
  behaviour: "silent" | "closing",
  options: { poolMax?: number; connectionTimeoutMs?: number } = {},
): Promise<Database> => {
  const fake = await startFakePostgres(behaviour);
  const database = new Database(`postgres://radioso:secret@127.0.0.1:${fake.port}/radioso`, {
    poolMax: options.poolMax ?? 2,
    connectionTimeoutMs: options.connectionTimeoutMs ?? 100,
    applicationName: "radioso-test",
  });
  cleanups.push(async () => {
    await database.close().catch(() => undefined);
    await fake.close();
  });
  return database;
};

// The shape of the usage-alert sweep that failed in production: a Kysely read on the shared pool.
const readThrough = (database: Database) => async (): Promise<void> => {
  await database.kysely.selectFrom("sessions").select("id").execute();
};

const recordingService = () => {
  const sink: ErrorSink = { name: "test-sink", record: vi.fn().mockResolvedValue(undefined) };
  const service = new ErrorReportingService({
    enabled: true,
    environment: "test",
    logger: { error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() } as never,
    service: "radioso-worker",
    sinks: [sink],
  });
  return { sink, service };
};

// The worker task server as `createWorkerTaskApp` assembles it, minus auth and the other routes.
const workerApp = (run: () => Promise<void>, service: ErrorReportingService) => {
  const app = express();
  app.use(createMatchedRouteRecorder());
  app.use(express.json());
  app.use(createDocumentWorkerTaskRoutes({
    periodicTaskHandlesById: new Map([["ee-usage-limit-alerts", { run }]]),
  } as unknown as Parameters<typeof createDocumentWorkerTaskRoutes>[0]));
  app.use(createErrorHandler(service));
  return app;
};

const runPeriodicTask = (app: express.Express) =>
  request(app).post("/internal/tasks/periodic-tasks/ee-usage-limit-alerts/run").send({});

describe("a request whose database cannot be reached", () => {
  it("answers a scheduled task with a retryable 503 and reports a database outage, not an unhandled fault", async () => {
    const database = await databaseAt("silent");
    const { sink, service } = recordingService();

    const response = await runPeriodicTask(workerApp(readThrough(database), service));

    expect(response.status).toBe(503);
    expect(response.body).toEqual({ error: { code: "service_unavailable", message: "Service temporarily unavailable" } });
    await vi.waitFor(() => expect(sink.record).toHaveBeenCalledOnce());
    expect(sink.record).toHaveBeenCalledWith(expect.objectContaining({
      errorType: "database.unavailable",
      severity: "warn",
      metadata: expect.objectContaining({ reason: "connect_timeout" }),
      requestContext: { method: "POST", route: "/internal/tasks/periodic-tasks/:taskId/run", statusCode: 503 },
    }));
  });

  it("names a pool whose every connection stayed busy", async () => {
    // The longer timeout keeps the slot taken until the task's query is queued behind it, however
    // slowly the request arrives.
    const database = await databaseAt("silent", { poolMax: 1, connectionTimeoutMs: 500 });
    // Takes the pool's only slot, so the task's query waits for a connection instead of opening one.
    const occupant = database.pool.connect().catch(() => undefined);
    const { sink, service } = recordingService();

    const response = await runPeriodicTask(workerApp(readThrough(database), service));
    await occupant;

    expect(response.status).toBe(503);
    await vi.waitFor(() => expect(sink.record).toHaveBeenCalledOnce());
    expect(sink.record).toHaveBeenCalledWith(expect.objectContaining({
      errorType: "database.unavailable",
      metadata: expect.objectContaining({ reason: "pool_checkout_timeout" }),
    }));
  });

  it("names a server that hangs up on the connection", async () => {
    const database = await databaseAt("closing");
    const { sink, service } = recordingService();

    const response = await runPeriodicTask(workerApp(readThrough(database), service));

    expect(response.status).toBe(503);
    await vi.waitFor(() => expect(sink.record).toHaveBeenCalledOnce());
    expect(sink.record).toHaveBeenCalledWith(expect.objectContaining({
      errorType: "database.unavailable",
      metadata: expect.objectContaining({ reason: "connection_lost" }),
    }));
  });

  it.each([
    ["57P01", "server_unavailable"],
    ["57P02", "server_unavailable"],
    ["57P03", "server_unavailable"],
    ["53300", "connection_limit"],
    ["08006", "connection_lost"],
  ])("names a Postgres session the server refused or ended (SQLSTATE %s) as %s", async (code, reason) => {
    const { sink, service } = recordingService();
    const refused = Object.assign(new DatabaseError("server refused the session", 0, "error"), { code });

    const response = await runPeriodicTask(workerApp(async () => { throw refused; }, service));

    expect(response.status).toBe(503);
    await vi.waitFor(() => expect(sink.record).toHaveBeenCalledOnce());
    expect(sink.record).toHaveBeenCalledWith(expect.objectContaining({ errorType: "database.unavailable", metadata: expect.objectContaining({ reason }) }));
  });

  it("reports a 503 that stands for an unreachable database as an outage, and keeps that error's own body", async () => {
    const database = await databaseAt("silent");
    const unreachable = await readThrough(database)().catch((error: unknown) => error);
    const wrapped = serviceUnavailable("Abuse control enforcement is unavailable");
    wrapped.cause = unreachable;
    const { sink, service } = recordingService();

    const response = await runPeriodicTask(workerApp(async () => { throw wrapped; }, service));

    expect(response.status).toBe(503);
    expect(response.body.error).toMatchObject({ code: "service_unavailable", message: "Abuse control enforcement is unavailable" });
    await vi.waitFor(() => expect(sink.record).toHaveBeenCalledOnce());
    expect(sink.record).toHaveBeenCalledWith(expect.objectContaining({
      errorType: "database.unavailable",
      errorClass: "AppError",
      metadata: expect.objectContaining({ reason: "connect_timeout" }),
    }));
  });
});

describe("a request that fails for any other reason", () => {
  it.each([
    ["a statement the database answered with an error", Object.assign(new DatabaseError("duplicate key value", 0, "error"), { code: "23505" })],
    ["a statement the database cancelled for running too long", Object.assign(new DatabaseError("canceling statement due to statement timeout", 0, "error"), { code: "57014" })],
    ["a socket reset on some other connection", Object.assign(new Error("socket hang up"), { code: "ECONNRESET" })],
    ["a plain programming error", new TypeError("Cannot read properties of undefined")],
  ])("stays an unhandled 500: %s", async (_label, failure) => {
    const { sink, service } = recordingService();

    const response = await runPeriodicTask(workerApp(async () => { throw failure; }, service));

    expect(response.status).toBe(500);
    expect(response.body).toEqual({ error: { code: "internal_error", message: "Internal server error" } });
    await vi.waitFor(() => expect(sink.record).toHaveBeenCalledOnce());
    expect(sink.record).toHaveBeenCalledWith(expect.objectContaining({ errorType: "http.request.unhandled", severity: "error" }));
  });
});
