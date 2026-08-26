import { createServer, type Server } from "node:http";
import type { Socket } from "node:net";

import express, { type Router } from "express";

import type { RealtimeServerPort } from "./startRealtimeRuntime.js";

export const createRealtimeServer = (input: {
  eventsPath: string;
  eventsRouter: Router;
  health(): { liveness: number; readiness: number };
  port: number;
  host?: string;
}): RealtimeServerPort & { readonly server: Server } => {
  const app = express();
  app.disable("x-powered-by");
  app.get("/health/live", (_request, response) => response.sendStatus(input.health().liveness));
  app.get("/health/ready", (_request, response) => response.sendStatus(input.health().readiness));
  app.use(input.eventsPath, (_request, response, next) => {
    if (input.health().readiness === 200) {
      next();
      return;
    }
    response.setHeader("Retry-After", "1");
    response.status(503).json({ error: { code: "service_unavailable", message: "Realtime updates temporarily unavailable" } });
  });
  app.use(input.eventsPath, input.eventsRouter);

  const server = createServer(app);
  const sockets = new Set<Socket>();
  server.on("connection", (socket) => {
    sockets.add(socket);
    socket.once("close", () => sockets.delete(socket));
  });
  let listenPromise: Promise<void> | undefined;
  let closePromise: Promise<void> | undefined;

  return {
    server,
    listen: () => {
      if (closePromise) return Promise.reject(new Error("Realtime server is closed"));
      if (server.listening) return Promise.resolve();
      if (listenPromise) return listenPromise;
      listenPromise = new Promise<void>((resolve, reject) => {
        const onError = (error: Error) => {
          server.off("listening", onListening);
          reject(error);
        };
        const onListening = () => {
          server.off("error", onError);
          resolve();
        };
        server.once("error", onError);
        server.once("listening", onListening);
        server.listen(input.port, input.host);
      });
      return listenPromise;
    },
    close: () => {
      if (closePromise) return closePromise;
      closePromise = (async () => {
        await listenPromise?.catch(() => undefined);
        if (!server.listening) return;
        await new Promise<void>((resolve, reject) => {
          server.close((error) => {
            if (error) reject(error);
            else resolve();
          });
        });
      })();
      return closePromise;
    },
    forceDestroy: () => {
      for (const socket of sockets) socket.destroy();
      server.closeAllConnections();
    },
  };
};
