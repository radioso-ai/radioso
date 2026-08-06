/**
 * Pushes a hint that the action outbox has new work, mirroring
 * `DocumentJobDispatcherPort` (documents module) for `routine_action_requests`.
 *
 * The push carries no row-specific payload: a delivered task just triggers one
 * drain batch (`ActionDispatcher.dispatchPending`), which claims whatever is
 * currently due via the outbox's existing `FOR UPDATE SKIP LOCKED` + lease/attempt
 * model. That makes at-least-once delivery (Cloud Tasks) and duplicate/racing
 * pushes safe by construction — a redundant push just finds nothing new to claim.
 */
export interface ActionDrainDispatcherPort {
  requestDrain(): Promise<void>;
}

/** Default when no push transport is configured (local dev): the interval-loop
 * poller in `ActionDispatchWorker` (started only by `startWorkerRuntime`) remains
 * the sole drain path, exactly as it was before per-action push existed. */
export class NoopActionDrainDispatcher implements ActionDrainDispatcherPort {
  async requestDrain(): Promise<void> {}
}
