import type { Response } from "express";

/**
 * Aborts the moment the client goes away: the response closes before it was ended. A response
 * that finished normally also closes, after `end()`, and leaves the signal alone.
 */
export const clientDisconnectSignal = (res: Pick<Response, "once" | "writableEnded">): AbortSignal => {
  const controller = new AbortController();
  res.once("close", () => {
    if (!res.writableEnded) {
      controller.abort();
    }
  });
  return controller.signal;
};
