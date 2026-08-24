import type { Response } from "express";

export const initializeSse = (res: Response, cacheControl = "no-cache"): void => {
  if (res.headersSent) {
    return;
  }
  res.status(200);
  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", cacheControl);
  res.setHeader("Connection", "keep-alive");
  res.setHeader("X-Accel-Buffering", "no");
  res.flushHeaders();
};

const writeSseChunk = async (res: Response, chunk: string): Promise<void> => {
  if (res.writableEnded) {
    return;
  }
  if (res.write(chunk) !== false) {
    return;
  }
  await new Promise<void>((resolve) => {
    const finish = () => {
      res.removeListener("drain", finish);
      res.removeListener("close", finish);
      res.removeListener("error", finish);
      resolve();
    };
    res.once("drain", finish);
    res.once("close", finish);
    res.once("error", finish);
  });
};

export const writeSseEvent = (
  res: Response,
  eventName: string,
  payload: unknown,
): Promise<void> => (async () => {
  await writeSseChunk(res, `event: ${eventName}\n`);
  await writeSseChunk(res, `data: ${JSON.stringify(payload)}\n\n`);
})();

export const writeSseComment = (res: Response, comment: string): Promise<void> =>
  writeSseChunk(res, `: ${comment}\n\n`);

export const sendSseIterable = async <T>(
  res: Response,
  events: AsyncIterable<T>,
  writeEvent: (event: T) => void | Promise<void>,
  options: {
    /**
     * When true, stop consuming and return the iterator as soon as the client
     * disconnects — for long-lived subscription streams that would otherwise
     * never end. Defaults to false: request-scoped work (a chat turn) must run
     * to completion even if the browser goes away, so the turn still persists;
     * writes are suppressed after close either way.
     */
    cancelOnClose?: boolean;
  } = {},
): Promise<void> => {
  let closed = false;
  let resolveClosed: (() => void) | undefined;
  const closedPromise = new Promise<void>((resolve) => {
    resolveClosed = resolve;
  });
  res.on("close", () => {
    closed = true;
    resolveClosed?.();
  });

  const iterator = events[Symbol.asyncIterator]();
  try {
    while (!(options.cancelOnClose && closed)) {
      const next = options.cancelOnClose
        ? await Promise.race([iterator.next(), closedPromise.then(() => undefined)])
        : await iterator.next();
      if (!next || next.done) {
        break;
      }
      if (!closed && !res.writableEnded) {
        await writeEvent(next.value);
      }
    }
  } finally {
    if (closed && typeof iterator.return === "function") {
      await iterator.return();
    }
    if (res.headersSent && !res.writableEnded) {
      res.end();
    }
  }
};
