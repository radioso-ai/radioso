import { z } from "zod";

import {
  backgroundJobHandler,
  backgroundJobRequest,
  defineBackgroundJob,
  type BackgroundJobHandlerRegistration,
  type BackgroundJobQueue,
} from "../../shared/background-jobs/index.js";
import type {
  DueEventSubscription,
  WorkspaceEventDeliveryWake,
  EventSubscriptionDeliveryStore,
} from "../../shared/domain/workspaceEventSubscriptions.js";
import type { AppLogger } from "../../shared/observability/logger.js";
import type { WorkspaceEventDeliveryDrain } from "./deliveryDrain.js";

/**
 * One subscription's drain. Keyed by the subscription and level-triggered (`rerun`), so at most one
 * drain runs per subscription and its events go out in order, never two at once; a wake that
 * arrives mid-run runs it once more.
 */
const WORKSPACE_EVENT_DELIVERY_JOB = defineBackgroundJob({
  kind: "workspace_events.deliver",
  payload: z.object({ workspaceId: z.string().uuid(), subscriptionId: z.string().uuid() }).strict(),
  onDuplicateKey: "rerun",
  timeoutSeconds: 120,
  leaseSeconds: 180,
});

const deliveryRequest = (target: DueEventSubscription) =>
  backgroundJobRequest(WORKSPACE_EVENT_DELIVERY_JOB, target, { idempotencyKey: target.subscriptionId });

/** Enqueues a subscription's drain. */
export const requestSubscriptionDrain = async (
  queue: Pick<BackgroundJobQueue, "enqueue">,
  target: DueEventSubscription,
): Promise<void> => {
  await queue.enqueue(deliveryRequest(target));
};

export const workspaceEventDeliveryJobHandler = (
  drain: Pick<WorkspaceEventDeliveryDrain, "drain">,
): BackgroundJobHandlerRegistration =>
  backgroundJobHandler(WORKSPACE_EVENT_DELIVERY_JOB, async (target, context) => {
    await drain.drain(target, context.signal);
  });

/** How many due subscriptions one search returns; a sweep keeps searching past them until none are left. */
const SWEEP_BATCH = 500;

/**
 * Starts the drains that have work: every active, due subscription with an event below the log's
 * horizon after its cursor. The periodic sweep is the guarantee; the post-commit wake asks for one
 * workspace sooner. Neither starts a subscription still waiting out a backoff.
 */
export class WorkspaceEventDeliveryScheduler implements WorkspaceEventDeliveryWake {
  constructor(private readonly dependencies: {
    subscriptions: Pick<EventSubscriptionDeliveryStore, "findDue">;
    queue: Pick<BackgroundJobQueue, "enqueue">;
    logger: Pick<AppLogger, "warn">;
  }) {}

  /** Every workspace's due subscriptions. Returns how many drains it started. */
  async sweep(): Promise<number> {
    return this.startAll({});
  }

  /** One workspace's due subscriptions. */
  async deliverWorkspace(workspaceId: string): Promise<number> {
    return this.startAll({ workspaceId });
  }

  /** Pages through the due subscriptions in id order, so a backlog past one batch is reached in the same sweep. */
  private async startAll(scope: { workspaceId?: string }): Promise<number> {
    let started = 0;
    let afterSubscriptionId: string | undefined;
    for (;;) {
      const due = await this.dependencies.subscriptions.findDue({ ...scope, ...(afterSubscriptionId ? { afterSubscriptionId } : {}), limit: SWEEP_BATCH });
      started += await this.start(due);
      if (due.length < SWEEP_BATCH) return started;
      afterSubscriptionId = due.at(-1)!.subscriptionId;
    }
  }

  requestDelivery(workspaceId: string): void {
    void this.deliverWorkspace(workspaceId).catch((error: unknown) => {
      this.dependencies.logger.warn(
        { workspaceId, errorClass: error instanceof Error ? error.name : "unknown" },
        "Workspace event delivery wake failed; the periodic sweep delivers instead",
      );
    });
  }

  private async start(due: readonly DueEventSubscription[]): Promise<number> {
    for (const target of due) {
      await requestSubscriptionDrain(this.dependencies.queue, target);
    }
    return due.length;
  }
}
