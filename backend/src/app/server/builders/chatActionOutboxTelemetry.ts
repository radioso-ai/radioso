import type { ActionRequestRepository } from "../../../db/repositories/actionRequestRepository.js";
import type { AppLogger } from "../../../shared/observability/logger.js";
import type { TelemetryService } from "../../../shared/observability/telemetry/telemetryService.js";

/**
 * Outbox depth / oldest-pending-age — the operator-alertable signal for a stuck
 * outbox. Shared by the poll worker's own interval (`PeriodicTaskRunner` in
 * `chat.ts`, the old 5 s carried over unchanged) and the push worker's task route
 * (`actionDispatchWorkerTaskRoutes.ts`), which has no interval of its own — Cloud
 * Run's push worker only runs while a request is in flight, so without a call after
 * every pushed drain and sweep, production never emits this signal at all.
 * Best-effort and self-contained: never throws, so a reporting failure never fails
 * the drain or sweep request it rides on.
 */
export const createActionOutboxQueueStateReporter = (
  actionOutbox: ActionRequestRepository,
  telemetryService: TelemetryService,
  logger: AppLogger,
) => async (): Promise<void> => {
  try {
    const snapshot = await actionOutbox.getPendingDepthSnapshot();
    const oldestPendingAgeMs = snapshot.oldestPendingCreatedAt
      ? Math.max(0, Date.now() - snapshot.oldestPendingCreatedAt.getTime())
      : 0;
    await telemetryService.emit({
      eventType: "action.dispatch.queue_state",
      metrics: {
        pendingCount: snapshot.pendingCount,
        inProgressCount: snapshot.inProgressCount,
        oldestPendingAgeMs,
      },
    });
  } catch (error) {
    logger.error(
      { err: error },
      "Action dispatch queue-depth reporting failed",
    );
  }
};
