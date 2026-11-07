/**
 * What a handler that finished without throwing reports. `dispatched` means every destination it
 * is configured to reach was attempted; `partial` means it reached some and, by design, not all,
 * with the reason the rest were left out. A handler with a single destination may return nothing,
 * which reads as `dispatched`.
 */
export type ActionDispatchOutcome =
  | { disposition: "dispatched" }
  | { disposition: "partial"; reason: string };

/** A handler completed but its configured transport intentionally did not deliver. */
export class ActionDispatchSkippedError extends Error {
  constructor(readonly reason: string) {
    super(reason);
    this.name = "ActionDispatchSkippedError";
  }
}
