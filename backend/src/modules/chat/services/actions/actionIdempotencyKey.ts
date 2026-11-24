import { createHash } from "node:crypto";

// Content-addressed idempotency key so a retried turn that re-emits the same request
// (same conversation + action type + payload) enqueues it once.
export const actionIdempotencyKey = (
  conversationId: string,
  type: string,
  payload: Record<string, unknown>,
): string =>
  `routine-action:${conversationId}:${type}:${createHash("sha256").update(JSON.stringify(payload)).digest("hex")}`;
