import type { Response } from "express";

import { CHAT_BEHAVIOR } from "../../../shared/domain/behaviorConfig.js";

interface ConsumeSseWithDisconnectCeilingOptions<Event> {
  response: Pick<Response, "destroyed" | "writableEnded" | "on">;
  events: AsyncIterable<Event>;
  onReady?: () => void;
  onEvent: (event: Event) => void;
  onDisconnect?: () => void;
  onDisconnectCeilingExceeded?: () => void | Promise<void>;
  /** Overrides `CHAT_BEHAVIOR.streaming.disconnectAbortCeilingMs`; tests only. */
  disconnectAbortCeilingMs?: number;
}

interface SseConsumptionResult {
  disconnected: boolean;
  ceilingExceeded: boolean;
}

/**
 * Drains an SSE event source after the response closes so its turn may still
 * finish, but abandons a blocked pull once the post-disconnect ceiling wins.
 * Domain cancellation remains the caller's responsibility through the narrow
 * `onDisconnectCeilingExceeded` callback.
 */
export const consumeSseWithDisconnectCeiling = async <Event>(
  options: ConsumeSseWithDisconnectCeilingOptions<Event>,
): Promise<SseConsumptionResult> => {
  const iterator = options.events[Symbol.asyncIterator]();
  let disconnected = options.response.destroyed || options.response.writableEnded;
  let settled = false;
  let ceilingTimer: ReturnType<typeof setTimeout> | undefined;
  let resolveCeilingExceeded!: () => void;
  const ceilingExceeded = new Promise<void>((resolve) => {
    resolveCeilingExceeded = resolve;
  });

  const startCeiling = () => {
    if (settled || ceilingTimer) {
      return;
    }
    ceilingTimer = setTimeout(
      resolveCeilingExceeded,
      options.disconnectAbortCeilingMs ?? CHAT_BEHAVIOR.streaming.disconnectAbortCeilingMs,
    );
  };
  const observeDisconnect = () => {
    if (!disconnected) {
      disconnected = true;
      options.onDisconnect?.();
    }
    startCeiling();
  };

  options.response.on("close", observeDisconnect);
  if (disconnected) {
    options.onDisconnect?.();
    startCeiling();
  }

  const pullOrCeiling = (): Promise<
    | { ceiling: false; result: IteratorResult<Event> }
    | { ceiling: true }
  > => Promise.race([
    iterator.next().then((result) => ({ ceiling: false as const, result })),
    ceilingExceeded.then(() => ({ ceiling: true as const })),
  ]);

  let ceilingExceededFlag = false;
  try {
    let step = await pullOrCeiling();
    if (!step.ceiling && !disconnected) {
      options.onReady?.();
    }
    while (!step.ceiling && !step.result.done) {
      if (!disconnected) {
        options.onEvent(step.result.value);
      }
      step = await pullOrCeiling();
    }
    ceilingExceededFlag = step.ceiling;
  } finally {
    settled = true;
    if (ceilingTimer) {
      clearTimeout(ceilingTimer);
    }
    if (ceilingExceededFlag) {
      await options.onDisconnectCeilingExceeded?.();
      if (typeof iterator.return === "function") {
        void iterator.return().catch(() => undefined);
      }
    } else if (disconnected && typeof iterator.return === "function") {
      await iterator.return();
    }
  }

  return { disconnected, ceilingExceeded: ceilingExceededFlag };
};
