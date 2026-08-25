import http, { type IncomingHttpHeaders } from "node:http";
import { readFile } from "node:fs/promises";

import express from "express";
import request from "supertest";
import { describe, expect, it, vi } from "vitest";

import {
  createWorkspaceEventsRoutes,
  type WorkspaceEventsRouteDeps,
  type WorkspaceEventsRouteTelemetry,
} from "../../src/modules/realtime/http/workspaceEventsRoutes.js";
import { RealtimeSessionAuthError, type RealtimeSessionAuthPort } from "../../src/modules/realtime/http/realtimeSessionAuthenticator.js";

import type {
  WorkspaceGatewayAttachment,
  WorkspaceGatewayConnection,
} from "../../src/modules/realtime/application/workspaceGateway.js";
import type { RealtimeAdmissionController, RealtimeAdmissionLease } from "../../src/modules/realtime/domain/contracts.js";
import { RealtimeAdmissionError } from "../../src/modules/realtime/domain/contracts.js";
import type { RealtimeRolloutPolicy } from "../../src/modules/realtime/domain/realtimeRolloutPolicy.js";
import type { SsePresenterClock, SsePresenterLimits } from "../../src/modules/realtime/http/ssePresenter.js";

const workspaceId = "4d7293c8-d241-4f8f-a4db-3df5b88da44c";
const accountId = "a5f6d0d3-98e8-4d1e-8c76-2b4f1d1de9a1";
const principalId = "user-42";
const sessionToken = "dashboard-session-token";

const deferred = <T>() => {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((onResolve, onReject) => {
    resolve = onResolve;
    reject = onReject;
  });
  return { promise, resolve, reject };
};

type RouteIdentity = Awaited<ReturnType<RealtimeSessionAuthPort["authenticate"]>>;

const identity = (): RouteIdentity => ({
  accountId,
  workspaceId,
  principalId,
  sessionExpiresAt: new Date(Date.now() + 60 * 60_000),
});

const limits: SsePresenterLimits = {
  streamAgeMs: 10 * 60_000,
  gatewayTimeoutMs: 20 * 60_000,
  edgeTimeoutMs: 20 * 60_000,
  heartbeatMs: 20_000,
  blockedDurationMs: 10_000,
  blockedWritableBytes: 256 * 1024,
  frameBytes: 4 * 1024,
  authTimeoutMs: 2_000,
  subscribeTimeoutMs: 3_000,
};

const clock = (): SsePresenterClock => ({
  monotonicNow: () => Date.now(),
  wallNow: () => Date.now(),
  ...(() => {
    let nextTimer = 0;
    const handles = new Map<number, ReturnType<typeof setTimeout>>();
    return {
      setTimeout: (callback: () => void, delay: number): number => {
        const id = nextTimer++;
        handles.set(id, setTimeout(() => {
          handles.delete(id);
          callback();
        }, delay));
        return id;
      },
      clearTimeout: (id: number): void => {
        const handle = handles.get(id);
        if (handle !== undefined) {
          clearTimeout(handle);
          handles.delete(id);
        }
      },
    };
  })(),
});

type HeaderOverrides = {
  Accept?: string;
  Cookie?: string;
  Authorization?: string;
  "X-Workspace-Id"?: string;
};

const headers = (overrides: HeaderOverrides = {}): Record<string, string> => Object.fromEntries(
  Object.entries({
    Accept: "text/event-stream",
    Cookie: `radioso_session=${sessionToken}`,
    "X-Workspace-Id": workspaceId,
    ...overrides,
  }).filter((entry): entry is [string, string] => entry[1] !== undefined),
);

const authFailure = (reason: RealtimeSessionAuthError["reason"]): RealtimeSessionAuthError =>
  new RealtimeSessionAuthError(reason);

const createRouteFixture = async (overrides: Partial<WorkspaceEventsRouteDeps> = {}) => {
  const shutdown = new AbortController();
  const leaseRelease = vi.fn(async (): Promise<void> => undefined);
  const lease: RealtimeAdmissionLease = {
    risk: new Promise(() => undefined),
    release: leaseRelease,
  };
  const attachment = deferred<WorkspaceGatewayAttachment>();
  const telemetryOutcome = vi.fn();
  const telemetry: WorkspaceEventsRouteTelemetry = { outcome: telemetryOutcome };
  let attachedConnection: WorkspaceGatewayConnection | undefined;
  let attachedSignal: AbortSignal | undefined;
  const authenticate = vi.fn(async (_input: Parameters<RealtimeSessionAuthPort["authenticate"]>[0]) => identity());
  const rollout = { allows: vi.fn((_input: Parameters<RealtimeRolloutPolicy["allows"]>[0]) => true) };
  const checkReconnect = vi.fn(async (_input: Parameters<RealtimeAdmissionController["checkReconnect"]>[0]) => undefined);
  const admit = vi.fn(async (_input: Parameters<RealtimeAdmissionController["admit"]>[0]) => lease);
  const attach = vi.fn(async (connection: WorkspaceGatewayConnection, options: { signal: AbortSignal }) => {
    attachedConnection = connection;
    attachedSignal = options.signal;
    return attachment.promise;
  });
  const deps: WorkspaceEventsRouteDeps = {
    authenticate,
    rollout,
    admission: { checkReconnect, admit },
    gateway: { attach },
    sessionCookieName: "radioso_session",
    limits,
    clock: clock(),
    telemetry,
    shutdown: shutdown.signal,
    ...overrides,
  };
  const routeAuthenticate = deps.authenticate;
  const routeRollout = deps.rollout;
  const routeCheckReconnect = deps.admission.checkReconnect;
  const routeAdmit = deps.admission.admit;
  const routeAttach = deps.gateway.attach;
  const app = express();
  app.use("/api/v1/events", createWorkspaceEventsRoutes(deps));
  return {
    app,
    deps,
    authenticate: routeAuthenticate,
    rollout: routeRollout,
    checkReconnect: routeCheckReconnect,
    admit: routeAdmit,
    attach: routeAttach,
    attachment,
    leaseRelease,
    attachmentRelease: vi.fn(async (): Promise<void> => undefined),
    telemetry,
    telemetryOutcome,
    shutdown,
    mocks: { authenticate, rolloutAllows: rollout.allows, checkReconnect, admit, attach },
    get attachedConnection() { return attachedConnection; },
    get attachedSignal() { return attachedSignal; },
  };
};

const resolveAttachment = (fixture: Awaited<ReturnType<typeof createRouteFixture>>): void => {
  fixture.attachment.resolve({ generation: 1, release: fixture.attachmentRelease });
};

const expectNoRetryAfter = (response: request.Response): void => {
  expect(response.headers["retry-after"]).toBeUndefined();
};

const readFirstSseChunk = async (
  app: express.Express,
  requestHeaders: Record<string, string>,
  onFirstChunk: () => void = () => undefined,
) => {
  const server = http.createServer(app);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("test server did not bind");
  return await new Promise<{ statusCode: number; headers: IncomingHttpHeaders; body: string }>((resolve, reject) => {
    const client = http.request({ hostname: "127.0.0.1", port: address.port, path: "/api/v1/events", method: "GET", headers: requestHeaders });
    client.once("error", (error) => {
      if ((error as NodeJS.ErrnoException).code !== "ECONNRESET") reject(error);
    });
    client.once("response", (response) => {
      response.once("data", (chunk: Buffer) => {
        const result = { statusCode: response.statusCode ?? 0, headers: response.headers, body: chunk.toString("utf8") };
        onFirstChunk();
        client.destroy();
        response.destroy();
        server.close(() => resolve(result));
      });
    });
    client.end();
  });
};

describe("workspace events route contract", () => {
  it.each(["HEAD", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"])("rejects %s with 405 and Allow: GET without authentication", async (method) => {
    const fixture = await createRouteFixture();
    const response = await request(fixture.app)[method.toLowerCase() as "head" | "post" | "put" | "patch" | "delete" | "options"]("/api/v1/events");
    expect(response.status).toBe(405);
    expect(response.headers.allow).toBe("GET");
    expect(fixture.authenticate).not.toHaveBeenCalled();
  });

  it.each([
    { Accept: undefined },
    { Accept: "application/json" },
  ])("requires Accept containing text/event-stream before authentication (%j)", async (override) => {
    const fixture = await createRouteFixture();
    const response = await request(fixture.app).get("/api/v1/events").set(headers(override));
    expect(response.status).toBe(400);
    expectNoRetryAfter(response);
    expect(fixture.authenticate).not.toHaveBeenCalled();
    expect(fixture.telemetryOutcome).toHaveBeenCalledWith("invalid");
  });

  it.each([
    "text/event-stream",
    "TEXT/EVENT-STREAM",
    "text/event-stream; q=1",
    "application/json, text/event-stream",
  ])("accepts a valid event-stream media range: %s", async (accept) => {
    const failure = new RealtimeAdmissionError("local_capacity", 503, 1_000);
    const fixture = await createRouteFixture({ admission: {
      checkReconnect: fixtureCheckReconnect(),
      admit: vi.fn().mockRejectedValue(failure),
    } });
    const response = await request(fixture.app).get("/api/v1/events").set(headers({ Accept: accept }));
    expect(response.status).toBe(503);
    expect(fixture.authenticate).toHaveBeenCalledOnce();
  });

  it.each([
    { "X-Workspace-Id": undefined },
    { "X-Workspace-Id": `${workspaceId},${workspaceId}` },
    { "X-Workspace-Id": "not-a-uuid" },
  ])("requires exactly one nonempty UUID workspace header (%j)", async (override) => {
    const fixture = await createRouteFixture();
    const response = await request(fixture.app).get("/api/v1/events").set(headers(override));
    expect(response.status).toBe(400);
    expectNoRetryAfter(response);
    expect(fixture.authenticate).not.toHaveBeenCalled();
  });

  it("rejects missing, anonymous, and token credentials with 401; any Authorization header wins", async () => {
    const missing = await createRouteFixture();
    const missingResponse = await request(missing.app).get("/api/v1/events").set(headers({ Cookie: "" }));
    expect(missingResponse.status).toBe(401);
    expectNoRetryAfter(missingResponse);
    expect(missing.authenticate).not.toHaveBeenCalled();

    const anonymous = await createRouteFixture();
    const anonymousResponse = await request(anonymous.app).get("/api/v1/events").set(headers({ Cookie: "anon_session=visitor" }));
    expect(anonymousResponse.status).toBe(401);
    expectNoRetryAfter(anonymousResponse);
    expect(anonymous.authenticate).not.toHaveBeenCalled();

    for (const authorizationHeader of ["Bearer workspace-token", "Basic dXNlcjpwYXNz", "Token opaque-value"]) {
      const authorization = await createRouteFixture();
      const authorizationResponse = await request(authorization.app)
        .get("/api/v1/events")
        .set(headers({ Authorization: authorizationHeader }));
      expect(authorizationResponse.status).toBe(401);
      expectNoRetryAfter(authorizationResponse);
      expect(authorization.authenticate).not.toHaveBeenCalled();
    }

    const duplicate = await createRouteFixture();
    const duplicateResponse = await request(duplicate.app)
      .get("/api/v1/events")
      .set(headers({ Cookie: `radioso_session=first; radioso_session=second` }));
    expect(duplicateResponse.status).toBe(401);
    expectNoRetryAfter(duplicateResponse);
    expect(duplicate.authenticate).not.toHaveBeenCalled();

    const customCookie = await createRouteFixture({ sessionCookieName: "custom_dashboard", rollout: { allows: vi.fn(() => false) } });
    const customResponse = await request(customCookie.app)
      .get("/api/v1/events")
      .set(headers({ Cookie: `other=1; custom_dashboard=${sessionToken}; trailing=3` }));
    expect(customResponse.status).toBe(404);
    expectNoRetryAfter(customResponse);
    expect(customCookie.authenticate).toHaveBeenCalledWith(expect.objectContaining({ sessionToken }));
  });

  it.each([
    ["invalid", 401],
    ["forbidden", 403],
  ] as const)("maps typed authentication outcome %s without a resource leak", async (reason, statusCode) => {
    const authenticate = vi.fn().mockRejectedValue(authFailure(reason));
    const fixture = await createRouteFixture({ authenticate });
    const response = await request(fixture.app).get("/api/v1/events").set(headers());
    expect(response.status).toBe(statusCode);
    expectNoRetryAfter(response);
    expect(response.text).not.toContain("internal session detail");
    expect(fixture.admit).not.toHaveBeenCalled();
    expect(fixture.attach).not.toHaveBeenCalled();
    expect(fixture.telemetryOutcome).toHaveBeenCalledWith("auth");
    expect(JSON.stringify(fixture.telemetryOutcome.mock.calls)).not.toMatch(/4d7293c8|user-42|dashboard-session-token|invalid|forbidden/);
  });

  it("returns 404 after authentication when realtime rollout is disabled", async () => {
    const rollout = { allows: vi.fn(() => false) };
    const fixture = await createRouteFixture({ rollout });
    const response = await request(fixture.app).get("/api/v1/events").set(headers());
    expect(response.status).toBe(404);
    expectNoRetryAfter(response);
    expect(fixture.authenticate).toHaveBeenCalledWith(expect.objectContaining({ sessionToken, requestedWorkspaceId: workspaceId, signal: expect.any(AbortSignal) }));
    expect(fixture.admit).not.toHaveBeenCalled();
    expect(fixture.attach).not.toHaveBeenCalled();
    expect(fixture.rollout.allows).toHaveBeenCalledWith({ accountId });
    expect(fixture.telemetryOutcome).toHaveBeenCalledWith("disabled");
  });

  it("keeps the boundary order authenticate -> rollout -> reconnect -> admit -> attach -> commit", async () => {
    const fixture = await createRouteFixture();
    const phases: string[] = [];
    const firstChunk = readFirstSseChunk(fixture.app, headers(), () => phases.push("commit"));
    await vi.waitFor(() => expect(fixture.attach).toHaveBeenCalledOnce());
    resolveAttachment(fixture);
    const response = await firstChunk;

    expect(fixture.authenticate).toHaveBeenCalledWith(expect.objectContaining({
      sessionToken,
      requestedWorkspaceId: workspaceId,
      signal: expect.any(AbortSignal),
    }));
    expect(fixture.rollout.allows).toHaveBeenCalledWith({ accountId });
    expect(fixture.checkReconnect).toHaveBeenCalledWith({ accountId, workspaceId, principalId });
    expect(fixture.admit).toHaveBeenCalledWith({ accountId, workspaceId, principalId });
    expect(response.body).toBe('event: ready\ndata: {"protocolVersion":1}\n\n');
    expect(phases).toEqual(["commit"]);

    const orders = [
      fixture.mocks.authenticate.mock.invocationCallOrder[0],
      fixture.mocks.rolloutAllows.mock.invocationCallOrder[0],
      fixture.mocks.checkReconnect.mock.invocationCallOrder[0],
      fixture.mocks.admit.mock.invocationCallOrder[0],
      fixture.mocks.attach.mock.invocationCallOrder[0],
    ];
    expect(orders).toEqual([...orders].sort((left, right) => left - right));
  });

  it.each([
    ["reconnect", 429, -1, "1"],
    ["reconnect", 503, Number.NaN, "1"],
    ["admit", 429, 1_001, "2"],
    ["admit", 503, Number.POSITIVE_INFINITY, "30"],
    ["admit", 503, Number.MAX_SAFE_INTEGER, "30"],
  ] as const)("maps %s overload to the exact bounded Retry-After", async (stage, statusCode, retryAfterMs, retryAfter) => {
    const reason = statusCode === 429 ? "workspace_limit" : "redis_unavailable";
    const failure = new RealtimeAdmissionError(reason, statusCode, retryAfterMs);
    const checkReconnect = stage === "reconnect"
      ? vi.fn().mockRejectedValue(failure)
      : fixtureCheckReconnect();
    const admit = stage === "admit"
      ? vi.fn().mockRejectedValue(failure)
      : vi.fn(async () => { throw new Error("admit must not run after reconnect rejection"); });
    const fixture = await createRouteFixture({ admission: {
      checkReconnect,
      admit,
    } });
    const response = await request(fixture.app).get("/api/v1/events").set(headers());
    expect(response.status).toBe(statusCode);
    expect(response.headers["retry-after"]).toBe(retryAfter);
    expect(fixture.attach).not.toHaveBeenCalled();
    expect(fixture.telemetryOutcome).toHaveBeenCalledWith("overload");
  });

  it("sanitizes generic precommit failures and supplies only a bounded retry hint", async () => {
    const admit = vi.fn().mockRejectedValue(new Error("redis password and internal topology"));
    const fixture = await createRouteFixture({ admission: { checkReconnect: fixtureCheckReconnect(), admit } });
    const response = await request(fixture.app).get("/api/v1/events").set(headers());
    expect(response.status).toBe(503);
    expect(response.headers["retry-after"]).toBe("1");
    expect(response.body).toEqual({ error: { code: "service_unavailable", message: "Realtime updates temporarily unavailable" } });
    expect(response.text).not.toContain("redis password");
    expect(response.text).not.toContain("internal topology");
    expect(fixture.attach).not.toHaveBeenCalled();
    expect(fixture.telemetryOutcome).toHaveBeenCalledWith("overload");
  });

  it("commits exact SSE headers once and sends ready first without an error envelope", async () => {
    const fixture = await createRouteFixture();
    const firstChunk = readFirstSseChunk(fixture.app, headers());
    await vi.waitFor(() => expect(fixture.attach).toHaveBeenCalledOnce());
    resolveAttachment(fixture);
    const response = await firstChunk;
    expect(response.statusCode).toBe(200);
    expect(response.headers["content-type"]).toBe("text/event-stream");
    expect(response.headers["cache-control"]).toBe("no-cache, no-transform");
    expect(response.headers.connection).toBe("keep-alive");
    expect(response.headers["x-accel-buffering"]).toBe("no");
    expect(response.headers["content-length"]).toBeUndefined();
    expect(response.headers["content-encoding"]).toBeUndefined();
    expect(response.body).toBe('event: ready\ndata: {"protocolVersion":1}\n\n');
    expect(response.body).not.toContain('"error"');
    expect(fixture.telemetryOutcome).toHaveBeenCalledWith("ready");
  });

  it("does not rewrite a committed stream as JSON when the gateway requests shutdown", async () => {
    const fixture = await createRouteFixture();
    const firstChunk = readFirstSseChunk(fixture.app, headers(), () => fixture.attachedConnection?.requestClose("shutdown"));
    await vi.waitFor(() => expect(fixture.attach).toHaveBeenCalledOnce());
    resolveAttachment(fixture);
    const response = await firstChunk;
    await vi.waitFor(() => expect(fixture.leaseRelease).toHaveBeenCalledOnce());
    await vi.waitFor(() => expect(fixture.attachmentRelease).toHaveBeenCalledOnce());

    expect(response.statusCode).toBe(200);
    expect(response.body).toBe('event: ready\ndata: {"protocolVersion":1}\n\n');
    expect(response.body).not.toContain("service_unavailable");
    expect(response.headers["content-type"]).toBe("text/event-stream");
  });

  it("aborts deferred authentication on disconnect before rollout, admission, or attachment", async () => {
    const pending = deferred<RouteIdentity>();
    let authSignal: AbortSignal | undefined;
    const authenticate = vi.fn(async (input: Parameters<RealtimeSessionAuthPort["authenticate"]>[0] & { signal: AbortSignal }) => {
      authSignal = input.signal;
      return pending.promise;
    });
    const fixture = await createRouteFixture({ authenticate });
    const server = http.createServer(fixture.app);
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("test server did not bind");
    const client = http.request({ hostname: "127.0.0.1", port: address.port, path: "/api/v1/events", method: "GET", headers: headers() });
    client.on("error", () => undefined);
    client.end();
    await vi.waitFor(() => expect(fixture.authenticate).toHaveBeenCalledOnce());
    client.destroy();
    await vi.waitFor(() => expect(authSignal?.aborted).toBe(true));
    pending.resolve(identity());
    await new Promise<void>((resolve) => setImmediate(resolve));

    expect(fixture.rollout.allows).not.toHaveBeenCalled();
    expect(fixture.checkReconnect).not.toHaveBeenCalled();
    expect(fixture.admit).not.toHaveBeenCalled();
    expect(fixture.attach).not.toHaveBeenCalled();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  it("releases a late admission lease once when disconnect abandons deferred admission", async () => {
    const pendingAdmission = deferred<RealtimeAdmissionLease>();
    const lateRelease = vi.fn(async (): Promise<void> => undefined);
    const lateLease: RealtimeAdmissionLease = { risk: new Promise(() => undefined), release: lateRelease };
    const admit = vi.fn(async (_input: Parameters<RealtimeAdmissionController["admit"]>[0]) => pendingAdmission.promise);
    let requestSignal: AbortSignal | undefined;
    const authenticate = vi.fn(async (input: Parameters<RealtimeSessionAuthPort["authenticate"]>[0] & { signal: AbortSignal }) => {
      requestSignal = input.signal;
      return identity();
    });
    const fixture = await createRouteFixture({ authenticate, admission: { checkReconnect: fixtureCheckReconnect(), admit } });
    const server = http.createServer(fixture.app);
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("test server did not bind");
    const client = http.request({ hostname: "127.0.0.1", port: address.port, path: "/api/v1/events", method: "GET", headers: headers() });
    client.on("error", () => undefined);
    client.end();
    await vi.waitFor(() => expect(fixture.admit).toHaveBeenCalledOnce());
    client.destroy();
    await vi.waitFor(() => expect(requestSignal?.aborted).toBe(true));
    pendingAdmission.resolve(lateLease);
    await vi.waitFor(() => expect(lateRelease).toHaveBeenCalledOnce());

    expect(lateRelease).toHaveBeenCalledOnce();
    expect(fixture.attach).not.toHaveBeenCalled();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  it("aborts request and attachment signals on native disconnect and releases late ownership once", async () => {
    const fixture = await createRouteFixture();
    const server = http.createServer(fixture.app);
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("test server did not bind");
    const client = http.request({ hostname: "127.0.0.1", port: address.port, path: "/api/v1/events", method: "GET", headers: headers() });
    client.on("error", () => undefined);
    client.end();
    await vi.waitFor(() => expect(fixture.attach).toHaveBeenCalledOnce());
    client.destroy();
    await vi.waitFor(() => expect(fixture.attachedSignal?.aborted).toBe(true));
    resolveAttachment(fixture);
    await vi.waitFor(() => expect(fixture.leaseRelease).toHaveBeenCalledOnce());
    await vi.waitFor(() => expect(fixture.attachmentRelease).toHaveBeenCalledOnce());
    expect(fixture.leaseRelease).toHaveBeenCalledOnce();
    expect(fixture.attachmentRelease).toHaveBeenCalledOnce();
    expect(fixture.attachedSignal?.aborted).toBe(true);
    fixture.shutdown.abort();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  it("keeps route imports independent from the full application composition", async () => {
    const source = await readFile(new URL("../../src/modules/realtime/http/workspaceEventsRoutes.ts", import.meta.url), "utf8");
    expect(source).not.toMatch(/AppDependencies|createApp|defaultComposition|mainRouter|apiRouter|app\/server\/|app\/composition\/|app\/http\/routes\//);
  });
});

const fixtureCheckReconnect = () => vi.fn(async (_input: Parameters<RealtimeAdmissionController["checkReconnect"]>[0]) => undefined);
