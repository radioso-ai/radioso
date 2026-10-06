import type { Response } from "express";

import type { TestExecutionEvent } from "../../../modules/test-execution/testExecution.js";
import { markHttpResponseFailed } from "../middleware/httpResponseCompletion.js";
import { consumeSseWithDisconnectCeiling } from "../shared/sseDisconnectCeiling.js";

interface TestExecutionPresentationOptions {
  onDisconnectCeilingExceeded?: () => void | Promise<void>;
  /** Overrides the production disconnect ceiling; tests only. */
  disconnectAbortCeilingMs?: number;
}

export const sendTestExecutionSse = async (
  res: Response,
  events: AsyncIterable<TestExecutionEvent>,
  options: TestExecutionPresentationOptions = {},
): Promise<void> => {
  let heartbeat: ReturnType<typeof setInterval> | undefined;
  try {
    const result = await consumeSseWithDisconnectCeiling({
      response: res,
      events,
      onReady: () => {
        res.status(200).setHeader("Content-Type", "text/event-stream");
        res.setHeader("Cache-Control", "no-cache, no-transform");
        res.setHeader("Connection", "keep-alive");
        res.setHeader("X-Accel-Buffering", "no");
        res.flushHeaders();
        heartbeat = setInterval(() => {
          if (!res.destroyed && !res.writableEnded) {
            res.write(": keepalive\n\n");
          }
        }, 15_000);
      },
      onEvent: (event) => {
        res.write(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
      },
      onDisconnectCeilingExceeded: options.onDisconnectCeilingExceeded,
      disconnectAbortCeilingMs: options.disconnectAbortCeilingMs,
    });
    if (result.ceilingExceeded) {
      markHttpResponseFailed(res);
    }
  } catch (error) {
    markHttpResponseFailed(res);
    if (!res.headersSent) {
      throw error;
    }
  } finally {
    if (heartbeat) {
      clearInterval(heartbeat);
    }
    if (res.headersSent && !res.destroyed && !res.writableEnded) {
      res.end();
    }
  }
};
