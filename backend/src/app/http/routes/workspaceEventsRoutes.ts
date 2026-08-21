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
    connectionCount += 1;
    dependencies.logger.info({ workspaceId, connectionCount }, "Workspace push SSE connection opened");
    const subscription = dependencies.workspaceEventBus.subscribe(workspaceId);
    initializeSse(res, "no-cache, no-transform");
    // The ready frame triggers the client's refetch, so it must not be sent
    // before the transport can deliver events — otherwise a change landing in
    // that gap is invisible until the reconcile floor. Capped so an unreachable
    // database still degrades to poll-only instead of a hung connection.
    await Promise.race([
      dependencies.workspaceEventBus.ready(),
      new Promise<void>((resolve) => setTimeout(resolve, 2_000).unref?.()),
    ]);
    writeSseEvent(res, "ready", { workspaceId });
    const heartbeat = setInterval(() => {
      if (!closed && !res.writableEnded) {
        res.write(": heartbeat\n\n");
      }
    }, 25_000);
    const cleanup = () => {
      if (closed) {
        return;
      }
      closed = true;
      clearInterval(heartbeat);
      connectionCount -= 1;
      dependencies.logger.info({ workspaceId, connectionCount }, "Workspace push SSE connection closed");
    };
    req.on("close", cleanup);
    res.on("close", cleanup);
    void sendSseIterable(res, subscription, (event) => {
      writeSseEvent(res, "push", event);
    }, { cancelOnClose: true }).catch((error) => {
      dependencies.logger.warn({ err: error }, "Workspace push SSE stream failed");
      cleanup();
    });
  });

  return router;
};
