import { Router } from "express";

import type { AppDependencies } from "../../server/types.js";
import { requireWorkspaceSession } from "../middleware/requireWorkspaceSession.js";
import { initializeSse, sendSseIterable, writeSseEvent } from "../presenters/ssePresenter.js";

export const createWorkspaceEventsRoutes = (dependencies: AppDependencies): Router => {
  const router = Router();
  let connectionCount = 0;

  router.get("/", (req, res, next) => {
    if (!dependencies.env.WORKSPACE_PUSH_ENABLED) {
      res.status(404).end();
      return;
    }
    requireWorkspaceSession(dependencies)(req, res, next);
  }, async (req, res) => {
    const workspaceId = res.locals.workspaceId as string;
    let closed = false;
    let heartbeat: ReturnType<typeof setInterval> | undefined;
    connectionCount += 1;
    void dependencies.telemetryService.emit({
      eventType: "workspace_push.sse_connection_opened",
      metrics: { connectionCount },
    });
    dependencies.logger.info({ workspaceId, connectionCount }, "Workspace push SSE connection opened");
    const subscription = dependencies.workspaceEventBus.subscribe(workspaceId);
    const iterator = subscription[Symbol.asyncIterator]();
    // Register teardown before the ready() await below: the client can
    // disconnect during that window and Node emits 'close' only once, so a
    // handler installed after the await would miss it and leak the subscription
    // (unbounded queue growth in the bus), the heartbeat, and the connection
    // count. Releasing the iterator here is what removes the bus subscriber.
    const cleanup = () => {
      if (closed) {
        return;
      }
      closed = true;
      if (heartbeat) {
        clearInterval(heartbeat);
      }
      connectionCount -= 1;
      void dependencies.telemetryService.emit({
        eventType: "workspace_push.sse_connection_closed",
        metrics: { connectionCount },
      });
      void iterator.return?.();
      dependencies.logger.info({ workspaceId, connectionCount }, "Workspace push SSE connection closed");
    };
    req.on("close", cleanup);
    res.on("close", cleanup);
    initializeSse(res, "no-cache, no-transform");
    // The ready frame triggers the client's refetch, so it must not be sent
    // before the transport can deliver events — otherwise a change landing in
    // that gap is invisible until the reconcile floor. Capped so an unreachable
    // database still degrades to poll-only instead of a hung connection.
    await Promise.race([
      dependencies.workspaceEventBus.ready(),
      new Promise<void>((resolve) => setTimeout(resolve, 2_000).unref?.()),
    ]);
    if (closed || res.writableEnded) {
      return;
    }
    writeSseEvent(res, "ready", { workspaceId });
    heartbeat = setInterval(() => {
      if (!closed && !res.writableEnded) {
        res.write(": heartbeat\n\n");
      }
    }, 25_000);
    void sendSseIterable(res, { [Symbol.asyncIterator]: () => iterator }, (event) => {
      if (subscription.consumeResync?.()) {
        writeSseEvent(res, "ready", { workspaceId });
      }
      writeSseEvent(res, "push", event);
    }, { cancelOnClose: true }).catch((error) => {
      dependencies.logger.warn({ err: error }, "Workspace push SSE stream failed");
      cleanup();
    });
  });

  return router;
};
