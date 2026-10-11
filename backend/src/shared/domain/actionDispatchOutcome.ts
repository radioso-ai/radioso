/** A handler completed but its configured transport intentionally did not deliver. */
export class ActionDispatchSkippedError extends Error {
  constructor(readonly reason: string) {
    super(reason);
    this.name = "ActionDispatchSkippedError";
  }
}
