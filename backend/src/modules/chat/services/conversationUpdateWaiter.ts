import type {
  ConversationUpdateWaitOutcome,
  ConversationUpdateWaiter,
} from "../contracts/conversationUpdates.js";
import type { PublicConversationEvent, PublicConversationEventBus } from "./publicConversationEventBus.js";

const DEFAULT_POLL_INTERVAL_MS = 2_000;
/** Spread of the poll tick around the interval, so parked callers do not re-query in lockstep. */
const JITTER_FLOOR = 0.8;
const JITTER_SPREAD = 0.4;

interface ConversationUpdateWaiterDependencies {
  bus: Pick<PublicConversationEventBus, "subscribe">;
  pollIntervalMs?: number;
  /** Returns a number in [0, 1); injected so a test can pin the tick. */
  jitter?: () => number;
}

/**
 * Races three things and resolves on the first: a conversation event on the in-process
 * bus (the fast path, and the only one that is sub-millisecond), a jittered poll tick
 * that simply tells the caller to re-query, and the deadline.
 *
 * The tick is what makes this correct on a multi-instance deployment. The bus is
 * per-process and unbuffered, so an operator reply handled by another instance is never
 * published here; without the tick the caller would wait out its whole deadline while
 * the reply sat in the database. Nothing here holds a database connection — the caller's
 * re-query is a short keyset read that returns its connection immediately.
 */
export const createConversationUpdateWaiter = (
  dependencies: ConversationUpdateWaiterDependencies,
): ConversationUpdateWaiter => {
  const pollIntervalMs = dependencies.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
  const jitter = dependencies.jitter ?? Math.random;

  return {
    wait: ({ conversationId, timeoutMs, signal }) => new Promise<ConversationUpdateWaitOutcome>((resolve) => {
      if (signal.aborted) {
        resolve("deadline");
        return;
      }

      const timers: NodeJS.Timeout[] = [];
      let settled = false;

      const settle = (outcome: ConversationUpdateWaitOutcome) => {
        if (settled) {
          return;
        }
        settled = true;
        for (const timer of timers) {
          clearTimeout(timer);
        }
        timers.length = 0;
        unsubscribe();
        signal.removeEventListener("abort", onAbort);
        resolve(outcome);
      };

      // An aborted request has no one left to answer; the caller stops its loop and the
      // handler returns without writing. Clearing here is what keeps a closed connection
      // from leaving a timer and a bus listener behind.
      const onAbort = () => settle("deadline");
      const unsubscribe = dependencies.bus.subscribe(conversationId, (event: PublicConversationEvent) => {
        if (event.conversationId === conversationId) {
          settle("woken");
        }
      });

      signal.addEventListener("abort", onAbort, { once: true });
      timers.push(setTimeout(() => settle("deadline"), timeoutMs));

      const tickMs = pollIntervalMs * (JITTER_FLOOR + JITTER_SPREAD * jitter());
      if (tickMs < timeoutMs) {
        timers.push(setTimeout(() => settle("woken"), tickMs));
      }
    }),
  };
};
