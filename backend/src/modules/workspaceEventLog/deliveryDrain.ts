import type { AuditPort } from "../audit/contracts/index.js";
import { PublicHostUnresolvedError, PublicNetworkPolicyError } from "../../shared/domain/publicNetwork.js";
import type { StoredLogEvent, WorkspaceEventLogStore } from "../../shared/domain/workspaceEventLog.js";
import type {
  DueEventSubscription,
  EventSubscriptionDeliveryStore,
  EventSubscriptionDisabledReason,
  SealedEventSubscription,
  WorkspaceEventSubscriptionStore,
} from "../../shared/domain/workspaceEventSubscriptions.js";
import { createSignedWebhookHeaders, WebhookResponseStatusError } from "../../shared/infra/http/signedWebhook.js";
import type { AppLogger } from "../../shared/observability/logger.js";
import type { MetricsRegistry } from "../../shared/observability/metrics/metricsRegistry.js";
import { traceOperation } from "../../shared/observability/tracing/operations.js";
import { scheduleAfterFailure } from "./deliveryPolicy.js";
import { presentWorkspaceEvent } from "./envelope.js";
import type { EventSubscriptionOwnerCheck } from "./ownerCheck.js";
import { permissionsToReadEventTypes } from "./readPermissions.js";
import type { SubscriptionSealer } from "./subscriptionSecrets.js";

/**
 * Posts one signed body and resolves with the accepting status. A non-2xx answer throws
 * {@link WebhookResponseStatusError}; the outbound URL guard's refusal throws a
 * `PublicNetworkPolicyError`, directly or as a cause. `signal` abandons the post.
 */
interface EventDeliveryClient {
  send(request: { url: string; rawBody: string; headers: Record<string, string>; signal?: AbortSignal }): Promise<{ status: number }>;
}

/** How one push ended, as metrics label it. `blocked` is the outbound URL guard refusing the target's address. */
type PushOutcome =
  | { kind: "delivered"; status: number }
  | { kind: "gone"; status: number }
  | { kind: "failed"; status: number | null; errorClass: string }
  | { kind: "blocked"; status: null; errorClass: string };

/** Why a drain run stopped. `missing` covers a subscription deleted, disabled or advanced by another run while this one ran. */
type DrainStop = "caught_up" | "missing" | "inactive" | "not_due" | "unreadable" | "failing" | "gone" | "creator_revoked" | "more_waiting" | "aborted";

interface EventDrainResult {
  delivered: number;
  stoppedBy: DrainStop;
}

/**
 * One run posts at most this many events, and stops early past its time budget, then hands the
 * rest to its next run, which queues behind other work: a tenant's slow receiver never holds the
 * shared queue's worker for long.
 */
const DEFAULT_EVENTS_PER_RUN = 10;
const DEFAULT_BUDGET_MS = 20_000;

const DURATION_BUCKETS_MS = [25, 50, 100, 250, 500, 1_000, 2_500, 5_000, 10_000];
const LAG_BUCKETS_MS = [250, 1_000, 5_000, 15_000, 60_000, 300_000, 900_000, 3_600_000, 21_600_000, 86_400_000];

/** An error and its causes, outermost first: a refused connection arrives as `fetch failed` caused by the guard. */
const causeChain = (error: unknown): unknown[] => {
  const chain: unknown[] = [];
  let current: unknown = error;
  for (let depth = 0; current !== undefined && current !== null && depth < 5; depth += 1) {
    chain.push(current);
    current = current instanceof Error ? current.cause : undefined;
  }
  return chain;
};

const errorClassOf = (error: unknown): string => (error instanceof Error ? error.name : "unknown");

/** A failed push as metrics label it: refused by the outbound URL guard, or a failure of the target or the network. */
const classifyFailure = (error: unknown): PushOutcome => {
  if (error instanceof WebhookResponseStatusError) {
    return error.status === 410 ? { kind: "gone", status: error.status } : { kind: "failed", status: error.status, errorClass: error.name };
  }
  const chain = causeChain(error);
  const unresolved = chain.find((cause) => cause instanceof PublicHostUnresolvedError);
  if (unresolved) return { kind: "failed", status: null, errorClass: errorClassOf(unresolved) };
  const refused = chain.find((cause) => cause instanceof PublicNetworkPolicyError);
  if (refused) return { kind: "blocked", status: null, errorClass: errorClassOf(refused) };
  return { kind: "failed", status: null, errorClass: errorClassOf(error) };
};

/**
 * Delivers one subscription's events in log order (#1852): one event per signed POST, read through
 * the log's own horizon-safe reader, after re-checking at every push that the subscription's creator
 * may still read them. A 2xx moves its cursor to the event. A `410 Gone` deletes the subscription,
 * as Zapier unsubscribes. Anything else records a failure and waits out a backoff, with every newer
 * event behind it, and a day of failures disables it. Delivery is at-least-once: a crash between a
 * POST and its cursor write sends the event again, under the same `Idempotency-Key`.
 *
 * It throws only when the database does, so the job's own retries cover outages, never a target.
 */
export class WorkspaceEventDeliveryDrain {
  constructor(private readonly dependencies: {
    subscriptions: Pick<EventSubscriptionDeliveryStore, "findSealed" | "recordDelivered" | "advanceCursor" | "recordFailed" | "disable">
      & Pick<WorkspaceEventSubscriptionStore, "delete">;
    log: WorkspaceEventLogStore;
    owners: EventSubscriptionOwnerCheck;
    client: EventDeliveryClient;
    sealer: Pick<SubscriptionSealer, "open">;
    /** Runs the drain again after this run, behind other queued work, for events it left waiting. */
    requeue: (target: DueEventSubscription) => Promise<void>;
    audit: Pick<AuditPort, "record">;
    metrics: Pick<MetricsRegistry, "incrementCounter" | "observeHistogram"> | null;
    logger: Pick<AppLogger, "warn" | "info">;
    clock?: () => Date;
    eventsPerRun?: number;
    budgetMs?: number;
  }) {}

  private now(): Date {
    return this.dependencies.clock?.() ?? new Date();
  }

  async drain(target: DueEventSubscription, signal?: AbortSignal): Promise<EventDrainResult> {
    const startedAt = this.now().getTime();
    const eventsPerRun = this.dependencies.eventsPerRun ?? DEFAULT_EVENTS_PER_RUN;
    const subscription = await this.dependencies.subscriptions.findSealed(target.workspaceId, target.subscriptionId);
    if (!subscription) return { delivered: 0, stoppedBy: "missing" };
    if (subscription.status !== "active") return { delivered: 0, stoppedBy: "inactive" };
    if (subscription.nextAttemptAt && subscription.nextAttemptAt.getTime() > this.now().getTime()) {
      return { delivered: 0, stoppedBy: "not_due" };
    }
    const { events, horizon } = await this.dependencies.log.readPage({
      workspaceId: subscription.workspaceId,
      types: subscription.eventTypes,
      after: subscription.cursor,
      limit: eventsPerRun,
    });
    // A short page read every event of these types below the horizon, so the cursor may move to the
    // horizon once they are delivered, as the log's own `nextCursor` does; a subscription to a quiet
    // type then never trails the log by far.
    const caughtUp = async (delivered: number): Promise<EventDrainResult> => {
      await this.dependencies.subscriptions.advanceCursor({
        workspaceId: subscription.workspaceId,
        subscriptionId: subscription.id,
        position: { tx: horizon, position: "0" },
      });
      return { delivered, stoppedBy: "caught_up" };
    };
    if (events.length === 0) return caughtUp(0);

    const destination = this.openDestination(subscription);
    if (!destination) return { delivered: 0, stoppedBy: "unreadable" };
    let failures = subscription.consecutiveFailures;
    let delivered = 0;
    for (const event of events) {
      if (signal?.aborted) return { delivered, stoppedBy: "aborted" };
      if (!(await this.creatorPermits(subscription))) {
        await this.disable(subscription, "creator_revoked");
        return { delivered, stoppedBy: "creator_revoked" };
      }
      const outcome = await this.push(subscription, event, destination, failures + 1, signal);
      if (outcome.kind === "delivered") {
        if (!(await this.recordDelivered(subscription, event, outcome.status, failures))) return { delivered, stoppedBy: "missing" };
        failures = 0;
        delivered += 1;
      } else if (outcome.kind === "gone") {
        await this.remove(subscription, event);
        return { delivered, stoppedBy: "gone" };
      } else {
        const recorded = await this.recordFailed(subscription, event, outcome, failures);
        return { delivered, stoppedBy: recorded ? "failing" : "missing" };
      }
      if (delivered < events.length && this.now().getTime() - startedAt >= (this.dependencies.budgetMs ?? DEFAULT_BUDGET_MS)) {
        return this.requeue(subscription, delivered);
      }
    }
    return events.length < eventsPerRun ? caughtUp(delivered) : this.requeue(subscription, delivered);
  }

  private async requeue(subscription: SealedEventSubscription, delivered: number): Promise<EventDrainResult> {
    await this.dependencies.requeue({ workspaceId: subscription.workspaceId, subscriptionId: subscription.id });
    return { delivered, stoppedBy: "more_waiting" };
  }

  /**
   * The target URL and secret, or null when they cannot be opened (the key that sealed them is no
   * longer configured). That is logged and the run ends quietly: throwing would only park the job,
   * and the next sweep would start it again.
   */
  private openDestination(subscription: SealedEventSubscription): { url: string; secret: string } | null {
    try {
      return {
        url: this.dependencies.sealer.open(subscription.targetUrlCiphertext),
        secret: this.dependencies.sealer.open(subscription.secretCiphertext),
      };
    } catch (error) {
      this.dependencies.logger.warn(
        { workspaceId: subscription.workspaceId, subscriptionId: subscription.id, errorClass: errorClassOf(error) },
        "Workspace event subscription's target could not be opened; check CONNECTOR_ENCRYPTION_KEY",
      );
      return null;
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
    destination: { url: string; secret: string },
    attempt: number,
    signal: AbortSignal | undefined,
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
        const headers = createSignedWebhookHeaders({ rawBody, secret: destination.secret, idempotencyKey: event.id });
        try {
          const { status } = await this.dependencies.client.send({ url: destination.url, rawBody, headers, ...(signal ? { signal } : {}) });
          return { kind: "delivered", status };
        } catch (error) {
          return classifyFailure(error);
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

  /** False when the subscription went, or another run already moved past the event. */
  private async recordDelivered(subscription: SealedEventSubscription, event: StoredLogEvent, status: number, previousFailures: number): Promise<boolean> {
    const recorded = await this.dependencies.subscriptions.recordDelivered({
      workspaceId: subscription.workspaceId,
      subscriptionId: subscription.id,
      position: { tx: event.tx, position: event.position },
      statusCode: status,
      at: this.now(),
    });
    if (recorded && previousFailures > 0) {
      this.dependencies.logger.info(
        { workspaceId: subscription.workspaceId, subscriptionId: subscription.id, eventId: event.id, statusCode: status, failures: previousFailures },
        "Workspace event subscription delivering again",
      );
    }
    return recorded;
  }

  /** False when the subscription went while the push ran. */
  private async recordFailed(
    subscription: SealedEventSubscription,
    event: StoredLogEvent,
    outcome: Extract<PushOutcome, { kind: "failed" | "blocked" }>,
    previousFailures: number,
  ): Promise<boolean> {
    const at = this.now();
    const streak = await this.dependencies.subscriptions.recordFailed({
      workspaceId: subscription.workspaceId,
      subscriptionId: subscription.id,
      statusCode: outcome.status,
      at,
      schedule: (counted) => scheduleAfterFailure(counted, at),
    });
    if (!streak) return false;
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
    if (streak.disabled) {
      await this.auditDisabled(subscription, "delivery_failing");
      this.dependencies.logger.warn({ ...fields, failures: streak.consecutiveFailures }, "Workspace event subscription disabled after a day of failed deliveries");
    }
    return true;
  }

  private async disable(subscription: SealedEventSubscription, reason: EventSubscriptionDisabledReason): Promise<void> {
    const disabled = await this.dependencies.subscriptions.disable({
      workspaceId: subscription.workspaceId,
      subscriptionId: subscription.id,
      reason,
      at: this.now(),
    });
    if (!disabled) return;
    this.countOutcome("creator_revoked");
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
