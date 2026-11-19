import type { AuditPort } from "../audit/contracts/index.js";
import type { StoredLogEvent, WorkspaceEventLogStore } from "../../shared/domain/workspaceEventLog.js";
import type {
  DueEventSubscription,
  EventSubscriptionDisabledReason,
  SealedEventSubscription,
  WorkspaceEventSubscriptionStore,
} from "../../shared/domain/workspaceEventSubscriptions.js";
import { createSignedWebhookHeaders, WebhookResponseStatusError } from "../../shared/infra/http/signedWebhook.js";
import type { AppLogger } from "../../shared/observability/logger.js";
import type { MetricsRegistry } from "../../shared/observability/metrics/metricsRegistry.js";
import { traceOperation } from "../../shared/observability/tracing/operations.js";
import { failedDeliveryStreak } from "./deliveryPolicy.js";
import { presentWorkspaceEvent } from "./envelope.js";
import type { EventSubscriptionOwnerCheck } from "./ownerCheck.js";
import { permissionsToReadEventTypes } from "./readPermissions.js";
import type { SubscriptionSealer } from "./subscriptionSecrets.js";

/** Posts one signed body. Resolves with the accepting status; a non-2xx answer throws {@link WebhookResponseStatusError}. */
interface EventDeliveryClient {
  post(request: { url: string; rawBody: string; headers: Record<string, string> }): Promise<{ status: number }>;
}

/** The outbound URL guard refused a hop at delivery: the target now resolves to an address that is not public. */
export class EventDeliveryTargetRefusedError extends Error {
  constructor() {
    super("The event subscription's target does not resolve to a public address");
    this.name = "EventDeliveryTargetRefusedError";
  }
}

/** How one push ended, as metrics label it. */
type PushOutcome =
  | { kind: "delivered"; status: number }
  | { kind: "gone"; status: number }
  | { kind: "failed"; status: number | null; errorClass: string }
  | { kind: "blocked"; status: null; errorClass: string };

/** Why a drain run stopped. */
type DrainStop = "caught_up" | "missing" | "inactive" | "not_due" | "failing" | "gone" | "creator_revoked" | "budget" | "aborted";

interface EventDrainResult {
  delivered: number;
  stoppedBy: DrainStop;
}

const DEFAULT_PAGE_SIZE = 50;
/** Stays inside the job's deadline with room for one last push's 10 s timeout. */
const DEFAULT_BUDGET_MS = 90_000;

const DURATION_BUCKETS_MS = [25, 50, 100, 250, 500, 1_000, 2_500, 5_000, 10_000];
const LAG_BUCKETS_MS = [250, 1_000, 5_000, 15_000, 60_000, 300_000, 900_000, 3_600_000, 21_600_000, 86_400_000];

/**
 * Delivers one subscription's events in log order (#1852): one event per signed POST, read through
 * the log's own horizon-safe reader, after re-checking at every push that the subscription's creator
 * may still read them. A 2xx moves its cursor past the event. A `410 Gone` deletes the subscription,
 * as Zapier unsubscribes. Anything else records a failure and waits out a backoff, with every newer
 * event behind it, and a day of failures disables it. Delivery is at-least-once: a crash between a
 * POST and its cursor write sends the event again, under the same `Idempotency-Key`.
 *
 * It throws only when the database does, so the job's own retries cover outages, never a target.
 */
export class WorkspaceEventDeliveryDrain {
  constructor(private readonly dependencies: {
    subscriptions: Pick<WorkspaceEventSubscriptionStore, "findSealed" | "recordDelivered" | "recordFailed" | "disable" | "delete">;
    log: WorkspaceEventLogStore;
    owners: EventSubscriptionOwnerCheck;
    client: EventDeliveryClient;
    sealer: SubscriptionSealer;
    /** Runs the drain again once this run ends, for a backlog longer than one run's budget. */
    requeue: (target: DueEventSubscription) => Promise<void>;
    audit: Pick<AuditPort, "record">;
    metrics: Pick<MetricsRegistry, "incrementCounter" | "observeHistogram"> | null;
    logger: Pick<AppLogger, "warn" | "info">;
    clock?: () => Date;
    pageSize?: number;
    budgetMs?: number;
  }) {}

  private now(): Date {
    return this.dependencies.clock?.() ?? new Date();
  }

  async drain(target: DueEventSubscription, signal?: AbortSignal): Promise<EventDrainResult> {
    const startedAt = this.now().getTime();
    const budgetMs = this.dependencies.budgetMs ?? DEFAULT_BUDGET_MS;
    let delivered = 0;
    for (;;) {
      const subscription = await this.dependencies.subscriptions.findSealed(target.workspaceId, target.subscriptionId);
      if (!subscription) return { delivered, stoppedBy: "missing" };
      if (subscription.status !== "active") return { delivered, stoppedBy: "inactive" };
      if (subscription.nextAttemptAt && subscription.nextAttemptAt.getTime() > this.now().getTime()) {
        return { delivered, stoppedBy: "not_due" };
      }
      const { events } = await this.dependencies.log.readPage({
        workspaceId: subscription.workspaceId,
        types: subscription.eventTypes,
        after: subscription.cursor,
        limit: this.dependencies.pageSize ?? DEFAULT_PAGE_SIZE,
      });
      if (events.length === 0) return { delivered, stoppedBy: "caught_up" };

      const destination = {
        url: this.dependencies.sealer.open(subscription.targetUrlCiphertext),
        secret: this.dependencies.sealer.open(subscription.secretCiphertext),
      };
      let failures = subscription.consecutiveFailures;
      for (const event of events) {
        if (signal?.aborted) return { delivered, stoppedBy: "aborted" };
        if (!(await this.creatorPermits(subscription))) {
          await this.disable(subscription, "creator_revoked");
          this.countOutcome("creator_revoked");
          return { delivered, stoppedBy: "creator_revoked" };
        }
        const outcome = await this.push(subscription, event, destination, failures + 1);
        if (outcome.kind === "delivered") {
          await this.recordDelivered(subscription, event, outcome.status, failures);
          failures = 0;
          delivered += 1;
        } else if (outcome.kind === "gone") {
          await this.remove(subscription, event);
          return { delivered, stoppedBy: "gone" };
        } else {
          await this.recordFailed(subscription, event, outcome, failures);
          return { delivered, stoppedBy: "failing" };
        }
        if (this.now().getTime() - startedAt >= budgetMs) {
          await this.dependencies.requeue({ workspaceId: subscription.workspaceId, subscriptionId: subscription.id });
          return { delivered, stoppedBy: "budget" };
        }
      }
    }
  }

  private creatorPermits(subscription: SealedEventSubscription): Promise<boolean> {
    return this.dependencies.owners.permits({
      workspaceId: subscription.workspaceId,
      createdBy: subscription.createdBy,
      permissions: permissionsToReadEventTypes(subscription.eventTypes),
    });
  }

  /** One signed POST of one event. The span names the subscription and the event's type, never the URL or the body. */
  private push(
    subscription: SealedEventSubscription,
    event: StoredLogEvent,
    target: { url: string; secret: string },
    attempt: number,
  ): Promise<PushOutcome> {
    const startedAt = Date.now();
    return traceOperation({
      name: "workspace_event.deliver",
      attributes: {
        "radioso.workspace_id": subscription.workspaceId,
        "workspace_event.subscription_id": subscription.id,
        "workspace_event.type": event.type,
        "workspace_event.attempt": attempt,
      },
      run: async (): Promise<PushOutcome> => {
        const rawBody = JSON.stringify(presentWorkspaceEvent(event));
        const headers = createSignedWebhookHeaders({ rawBody, secret: target.secret, idempotencyKey: event.id });
        try {
          const { status } = await this.dependencies.client.post({ url: target.url, rawBody, headers });
          return { kind: "delivered", status };
        } catch (error) {
          if (error instanceof WebhookResponseStatusError) {
            return error.status === 410
              ? { kind: "gone", status: error.status }
              : { kind: "failed", status: error.status, errorClass: error.name };
          }
          if (error instanceof EventDeliveryTargetRefusedError) {
            return { kind: "blocked", status: null, errorClass: error.name };
          }
          return { kind: "failed", status: null, errorClass: error instanceof Error ? error.name : "unknown" };
        }
      },
      resultAttributes: (outcome) => ({
        "workspace_event.outcome": outcome.kind,
        ...(outcome.status === null ? {} : { "http.response.status_code": outcome.status }),
      }),
    }).then((outcome) => {
      this.dependencies.metrics?.observeHistogram("workspace_event_delivery_duration_ms", {
        help: "How long one workspace event push took, by outcome.",
        labels: { outcome: outcome.kind },
        value: Date.now() - startedAt,
        buckets: DURATION_BUCKETS_MS,
      });
      this.countOutcome(outcome.kind);
      if (outcome.kind === "delivered") {
        this.dependencies.metrics?.observeHistogram("workspace_event_delivery_lag_ms", {
          help: "How long after it was recorded a workspace event reached its subscription's target.",
          value: Math.max(0, this.now().getTime() - event.occurredAt.getTime()),
          buckets: LAG_BUCKETS_MS,
        });
      }
      return outcome;
    });
  }

  private async recordDelivered(subscription: SealedEventSubscription, event: StoredLogEvent, status: number, previousFailures: number): Promise<void> {
    await this.dependencies.subscriptions.recordDelivered({
      workspaceId: subscription.workspaceId,
      subscriptionId: subscription.id,
      position: { tx: event.tx, position: event.position },
      statusCode: status,
      at: this.now(),
    });
    if (previousFailures > 0) {
      this.dependencies.logger.info(
        { workspaceId: subscription.workspaceId, subscriptionId: subscription.id, eventId: event.id, statusCode: status, failures: previousFailures },
        "Workspace event subscription delivering again",
      );
    }
  }

  private async recordFailed(
    subscription: SealedEventSubscription,
    event: StoredLogEvent,
    outcome: Extract<PushOutcome, { kind: "failed" | "blocked" }>,
    previousFailures: number,
  ): Promise<void> {
    const at = this.now();
    const streak = failedDeliveryStreak({
      previousFailures,
      failingSince: previousFailures > 0 ? subscription.failingSince : null,
      at,
    });
    await this.dependencies.subscriptions.recordFailed({
      workspaceId: subscription.workspaceId,
      subscriptionId: subscription.id,
      statusCode: outcome.status,
      at,
      ...streak,
    });
    const fields = {
      workspaceId: subscription.workspaceId,
      subscriptionId: subscription.id,
      eventId: event.id,
      statusCode: outcome.status,
      errorClass: outcome.errorClass,
    };
    if (previousFailures === 0) {
      this.dependencies.logger.warn(fields, "Workspace event subscription delivery failing");
    }
    if (streak.disable) {
      await this.auditDisabled(subscription, "delivery_failing");
      this.dependencies.logger.warn({ ...fields, failures: streak.consecutiveFailures }, "Workspace event subscription disabled after a day of failed deliveries");
    }
  }

  private async disable(subscription: SealedEventSubscription, reason: EventSubscriptionDisabledReason): Promise<void> {
    const disabled = await this.dependencies.subscriptions.disable({
      workspaceId: subscription.workspaceId,
      subscriptionId: subscription.id,
      reason,
      at: this.now(),
    });
    if (!disabled) return;
    await this.auditDisabled(subscription, reason);
    this.dependencies.logger.warn(
      { workspaceId: subscription.workspaceId, subscriptionId: subscription.id, reason },
      "Workspace event subscription disabled",
    );
  }

  private async remove(subscription: SealedEventSubscription, event: StoredLogEvent): Promise<void> {
    const removed = await this.dependencies.subscriptions.delete(subscription.workspaceId, subscription.id);
    if (!removed) return;
    await this.dependencies.audit.record({
      workspaceId: subscription.workspaceId,
      eventType: "workspace_event_subscription.removed",
      eventStatus: "success",
      metadata: { ...this.auditFields(subscription), reason: "target_gone" },
    });
    this.dependencies.logger.warn(
      { workspaceId: subscription.workspaceId, subscriptionId: subscription.id, eventId: event.id, statusCode: 410 },
      "Workspace event subscription removed: its target answered 410 Gone",
    );
  }

  private auditDisabled(subscription: SealedEventSubscription, reason: EventSubscriptionDisabledReason): Promise<void> {
    return this.dependencies.audit.record({
      workspaceId: subscription.workspaceId,
      eventType: "workspace_event_subscription.disabled",
      eventStatus: "success",
      metadata: { ...this.auditFields(subscription), reason },
    });
  }

  private auditFields(subscription: SealedEventSubscription): Record<string, unknown> {
    return {
      subscriptionId: subscription.id,
      label: subscription.label,
      targetHost: subscription.targetHost,
      eventTypes: subscription.eventTypes,
      createdByKind: subscription.createdBy.kind,
    };
  }

  private countOutcome(outcome: PushOutcome["kind"] | "creator_revoked"): void {
    this.dependencies.metrics?.incrementCounter("workspace_event_deliveries_total", {
      help: "Workspace event pushes to subscribed URLs, by outcome.",
      labels: { outcome },
    });
  }
}
