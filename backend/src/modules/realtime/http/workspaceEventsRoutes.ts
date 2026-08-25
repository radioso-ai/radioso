import { Router, type Request, type Response } from "express";

import type { WorkspaceGatewayAttachment, WorkspaceGatewayConnection } from "../application/workspaceGateway.js";
import type { RealtimeAdmissionController } from "../domain/contracts.js";
import { RealtimeAdmissionError } from "../domain/contracts.js";
import type { RealtimeRolloutPolicy } from "../domain/realtimeRolloutPolicy.js";
import {
  SsePresenter,
  type SsePresenterClock,
  type SsePresenterLimits,
  type SsePresenterRegistration,
  type SsePresenterReservation,
  type SseResponse,
  type SseStreamTelemetry,
} from "./ssePresenter.js";
import { RealtimeSessionAuthError, type RealtimeSessionAuthPort } from "./realtimeSessionAuthenticator.js";

type RouteOutcome = "invalid" | "auth" | "disabled" | "overload" | "ready";

export interface WorkspaceEventsRouteTelemetry {
  outcome(outcome: RouteOutcome): void;
}

export type WorkspaceEventsRouteDeps = {
  authenticate: RealtimeSessionAuthPort["authenticate"];
  rollout: RealtimeRolloutPolicy;
  admission: Pick<RealtimeAdmissionController, "checkReconnect" | "admit">;
  gateway: { attach(connection: WorkspaceGatewayConnection, options: { signal: AbortSignal }): Promise<WorkspaceGatewayAttachment> };
  sessionCookieName: string;
  limits: SsePresenterLimits;
  clock: SsePresenterClock;
  streamAgeMs?: () => number;
  streamTelemetry?: SseStreamTelemetry;
  shutdown?: AbortSignal;
  telemetry?: WorkspaceEventsRouteTelemetry;
  presenters?: {
    reserve(): SsePresenterReservation;
    track(registration: SsePresenterRegistration): Promise<void>;
  };
};

const workspaceIdPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;

export const createWorkspaceEventsRoutes = (deps: WorkspaceEventsRouteDeps): Router => {
  const router = Router();
  router.use(async (request, response) => {
    if (request.path !== "/") {
      sendError(response, 404, "not_found", "Realtime endpoint not found");
      return;
    }
    if (request.method !== "GET") {
      response.setHeader("Allow", "GET");
      sendError(response, 405, "method_not_allowed", "Only GET is supported");
      return;
    }
    if (!acceptsEventStream(request)) {
      deps.telemetry?.outcome("invalid");
      sendError(response, 400, "invalid_request", "Accept must include text/event-stream");
      return;
    }
    const requestedWorkspaceId = singleWorkspaceId(request);
    if (!requestedWorkspaceId) {
      deps.telemetry?.outcome("invalid");
      sendError(response, 400, "invalid_request", "A single valid workspace header is required");
      return;
    }
    const sessionToken = dashboardSessionToken(request, deps.sessionCookieName);
    if (!sessionToken) {
      deps.telemetry?.outcome("auth");
      sendError(response, 401, "unauthorized", "Dashboard session authentication is required");
      return;
    }

    const requestAbort = new AbortController();
    const onAborted = () => requestAbort.abort();
    const onClose = () => requestAbort.abort();
    request.once("aborted", onAborted);
    response.once("close", onClose);
    const streamResponse = expressSseResponse(response, () => deps.telemetry?.outcome("ready"));
    let reservation: SsePresenterReservation | undefined;
    try {
      reservation = deps.presenters?.reserve();
    } catch (error) {
      request.off("aborted", onAborted);
      response.off("close", onClose);
      mapPrecommitError(response, error, deps.telemetry);
      return;
    }
    try {
      const limits = deps.streamAgeMs
        ? { ...deps.limits, streamAgeMs: deps.streamAgeMs() }
        : deps.limits;
      const presenter = new SsePresenter({
        authorize: async (signal) => {
          const authSignal = AbortSignal.any([requestAbort.signal, signal]);
          const identity = await deps.authenticate({ sessionToken, requestedWorkspaceId, signal: authSignal });
          if (authSignal.aborted) throw new RealtimeSessionAuthError("aborted");
          if (!deps.rollout.allows({ accountId: identity.accountId })) throw new RealtimeRolloutDisabledError();
          return identity;
        },
        admission: deps.admission,
        gateway: deps.gateway,
        response: streamResponse,
        signal: requestAbort.signal,
        shutdown: deps.shutdown,
        clock: deps.clock,
        limits,
        telemetry: deps.streamTelemetry,
      });
      const opening = presenter.start();
      await (reservation?.track({
        promise: opening,
        abortPreflight: () => { if (!response.headersSent) requestAbort.abort(); },
        forceDestroy: () => response.destroy(),
      }) ?? opening);
    } catch (error) {
      if (requestAbort.signal.aborted || response.headersSent) return;
      mapPrecommitError(response, error, deps.telemetry);
    } finally {
      reservation?.release();
      request.off("aborted", onAborted);
      response.off("close", onClose);
    }
  });
  return router;
};

class RealtimeRolloutDisabledError extends Error {}

const rawHeaderValues = (request: Request, name: string): string[] => {
  const values: string[] = [];
  for (let index = 0; index < request.rawHeaders.length; index += 2) {
    if (request.rawHeaders[index]?.toLowerCase() === name) values.push(request.rawHeaders[index + 1] ?? "");
  }
  return values;
};

const acceptsEventStream = (request: Request): boolean => {
  const values = rawHeaderValues(request, "accept");
  if (values.length === 0) return false;
  return values.some((value) => value.split(",").some((range) => range.split(";", 1)[0]?.trim().toLowerCase() === "text/event-stream"));
};

const singleWorkspaceId = (request: Request): string | undefined => {
  const values = rawHeaderValues(request, "x-workspace-id");
  if (values.length !== 1) return undefined;
  const value = values[0]!.trim();
  return workspaceIdPattern.test(value) ? value : undefined;
};

const dashboardSessionToken = (request: Request, cookieName: string): string | undefined => {
  if (rawHeaderValues(request, "authorization").length > 0) return undefined;
  const matches: string[] = [];
  for (const header of rawHeaderValues(request, "cookie")) {
    for (const pair of header.split(";")) {
      const separator = pair.indexOf("=");
      if (separator < 0 || pair.slice(0, separator).trim() !== cookieName) continue;
      const rawValue = pair.slice(separator + 1).trim();
      try {
        matches.push(decodeURIComponent(rawValue));
      } catch {
        return undefined;
      }
    }
  }
  return matches.length === 1 && matches[0]!.length > 0 ? matches[0] : undefined;
};

const expressSseResponse = (response: Response, onCommit: () => void): SseResponse => ({
  commitSse: () => {
    response.status(200);
    response.setHeader("Content-Type", "text/event-stream");
    response.setHeader("Cache-Control", "no-cache, no-transform");
    response.setHeader("Connection", "keep-alive");
    response.setHeader("X-Accel-Buffering", "no");
    response.removeHeader("Content-Length");
    response.removeHeader("Content-Encoding");
    response.flushHeaders();
    onCommit();
  },
  write: (frame) => response.write(frame),
  get writableLength() { return response.writableLength; },
  end: () => response.end(),
  destroy: (error) => response.destroy(error instanceof Error ? error : undefined),
  on: (event, listener) => { response.on(event, listener); },
  off: (event, listener) => { response.off(event, listener); },
});

const mapPrecommitError = (response: Response, error: unknown, telemetry?: WorkspaceEventsRouteTelemetry): void => {
  if (error instanceof RealtimeSessionAuthError) {
    telemetry?.outcome("auth");
    sendError(response, error.statusCode, error.statusCode === 401 ? "unauthorized" : "forbidden", "Realtime session is not authorized");
    return;
  }
  if (error instanceof RealtimeRolloutDisabledError) {
    telemetry?.outcome("disabled");
    sendError(response, 404, "not_found", "Realtime endpoint not found");
    return;
  }
  telemetry?.outcome("overload");
  if (error instanceof RealtimeAdmissionError) {
    response.setHeader("Retry-After", retryAfterSeconds(error.retryAfterMs));
    sendError(response, error.statusCode, "service_unavailable", "Realtime updates temporarily unavailable");
    return;
  }
  response.setHeader("Retry-After", "1");
  sendError(response, 503, "service_unavailable", "Realtime updates temporarily unavailable");
};

const retryAfterSeconds = (retryAfterMs: number): string => {
  if (Number.isNaN(retryAfterMs) || retryAfterMs <= 0) return "1";
  if (!Number.isFinite(retryAfterMs)) return "30";
  return String(Math.min(30, Math.max(1, Math.ceil(retryAfterMs / 1_000))));
};

const sendError = (response: Response, status: number, code: string, message: string): void => {
  response.status(status).json({ error: { code, message } });
};
