import { randomBytes } from "node:crypto";

import type { AccountPermission } from "../account/public.js";
import type { AuditPort } from "../audit/contracts/index.js";
import { AppError, notFound } from "../../shared/domain/errors.js";
import type { WorkspaceEventType } from "../../shared/domain/workspaceEventLog.js";
import {
  WORKSPACE_EVENT_SUBSCRIPTION_CAP,
  type EventDeliveryOutcome,
  type EventSubscriptionCreator,
  type EventSubscriptionCreatorKind,
  type EventSubscriptionDisabledReason,
  type EventSubscriptionLabel,
  type EventSubscriptionStatus,
  type StoredEventSubscription,
  type WorkspaceEventSubscriptionStore,
} from "../../shared/domain/workspaceEventSubscriptions.js";
import { normalizeWebhookTargetUrl, type WebhookUrlGuard } from "../../shared/infra/http/signedWebhook.js";
import type { SubscriptionSealer } from "./subscriptionSecrets.js";

/** The permission that creates, lists and deletes subscriptions. Each subscribed type also needs its read permission. */
export const WORKSPACE_EVENT_SUBSCRIPTIONS_MANAGE_PERMISSION =
  "workspace.event_subscriptions.manage" as const satisfies AccountPermission;

/** A subscription as the API and Settings show it: the target's host, never its URL or secret. */
export interface EventSubscriptionView {
  id: string;
  label: EventSubscriptionLabel;
  targetHost: string;
  eventTypes: WorkspaceEventType[];
  status: EventSubscriptionStatus;
  disabledReason: EventSubscriptionDisabledReason | null;
  createdAt: string;
  createdBy: { kind: EventSubscriptionCreatorKind; label: string | null };
  lastDelivery: { at: string; outcome: EventDeliveryOutcome; statusCode: number | null } | null;
  failingSince: string | null;
}

const presentEventSubscription = (subscription: StoredEventSubscription): EventSubscriptionView => ({
  id: subscription.id,
  label: subscription.label,
  targetHost: subscription.targetHost,
  eventTypes: subscription.eventTypes,
  status: subscription.status,
  disabledReason: subscription.disabledReason,
  createdAt: subscription.createdAt.toISOString(),
  createdBy: { kind: subscription.createdBy.kind, label: subscription.createdBy.label },
  lastDelivery: subscription.lastDelivery
    ? { at: subscription.lastDelivery.at.toISOString(), outcome: subscription.lastDelivery.outcome, statusCode: subscription.lastDelivery.statusCode }
    : null,
  failingSince: subscription.failingSince?.toISOString() ?? null,
});

const invalidTargetUrl = (): AppError =>
  new AppError(400, "invalid_target_url", "The target URL must be a valid https URL whose host resolves to a public address");

const subscriptionNotFound = (): AppError => notFound("Event subscription not found");

/** Who acted, for the audit record. */
interface EventSubscriptionActor {
  accountId: string | null;
}

/**
 * Creates, lists and deletes a workspace's event subscriptions (#1852). A subscription receives
 * only types its creator may read, at a public https URL, and holds its secret sealed. The caller
 * resolves which types its principal may read; asking for any other is refused, as the log refuses it.
 */
export class EventSubscriptionService {
  constructor(private readonly dependencies: {
    store: WorkspaceEventSubscriptionStore;
    sealer: SubscriptionSealer;
    audit: Pick<AuditPort, "record">;
    assertPublicUrl: WebhookUrlGuard;
    allowHttpLoopback: boolean;
    generateSecret?: () => string;
  }) {}

  async create(input: {
    workspaceId: string;
    actor: EventSubscriptionActor;
    createdBy: EventSubscriptionCreator;
    targetUrl: string;
    eventTypes: readonly WorkspaceEventType[];
    label: EventSubscriptionLabel;
    readableTypes: readonly WorkspaceEventType[];
  }): Promise<{ subscription: EventSubscriptionView; signingSecret: string }> {
    const eventTypes = [...new Set(input.eventTypes)];
    const readable = new Set(input.readableTypes);
    const refused = eventTypes.filter((type) => !readable.has(type));
    if (refused.length > 0) {
      throw new AppError(403, "event_type_not_permitted", "The caller may not read these event types", { types: refused });
    }
    const targetUrl = await this.normalizeTargetUrl(input.targetUrl);
    const signingSecret = this.dependencies.generateSecret?.() ?? randomBytes(32).toString("base64url");
    const created = await this.dependencies.store.createWithinCap({
      workspaceId: input.workspaceId,
      label: input.label,
      targetHost: new URL(targetUrl).host,
      targetUrlCiphertext: this.dependencies.sealer.seal(targetUrl),
      secretCiphertext: this.dependencies.sealer.seal(signingSecret),
      eventTypes,
      createdBy: input.createdBy,
      cap: WORKSPACE_EVENT_SUBSCRIPTION_CAP,
    });
    if (!created) {
      throw new AppError(
        409,
        "event_subscription_limit_reached",
        `A workspace holds at most ${WORKSPACE_EVENT_SUBSCRIPTION_CAP} event subscriptions; delete one first`,
        { limit: WORKSPACE_EVENT_SUBSCRIPTION_CAP },
      );
    }
    await this.audit("workspace_event_subscription.created", input.actor, created);
    return { subscription: presentEventSubscription(created), signingSecret };
  }

  async list(workspaceId: string): Promise<EventSubscriptionView[]> {
    return (await this.dependencies.store.list(workspaceId)).map(presentEventSubscription);
  }

  async get(workspaceId: string, subscriptionId: string): Promise<EventSubscriptionView> {
    const subscription = await this.dependencies.store.find(workspaceId, subscriptionId);
    if (!subscription) throw subscriptionNotFound();
    return presentEventSubscription(subscription);
  }

  async delete(workspaceId: string, subscriptionId: string, actor: EventSubscriptionActor): Promise<void> {
    const deleted = await this.dependencies.store.delete(workspaceId, subscriptionId);
    if (!deleted) throw subscriptionNotFound();
    await this.audit("workspace_event_subscription.deleted", actor, deleted);
  }

  private async normalizeTargetUrl(value: string): Promise<string> {
    try {
      return await normalizeWebhookTargetUrl(value, {
        assertPublicUrl: this.dependencies.assertPublicUrl,
        allowHttpLoopback: this.dependencies.allowHttpLoopback,
      });
    } catch {
      // Malformed, not https, or a host that is not public: one answer, so a probe learns nothing
      // about which private hosts resolve.
      throw invalidTargetUrl();
    }
  }

  private async audit(eventType: string, actor: EventSubscriptionActor, subscription: StoredEventSubscription): Promise<void> {
    await this.dependencies.audit.record({
      accountId: actor.accountId,
      workspaceId: subscription.workspaceId,
      eventType,
      eventStatus: "success",
      metadata: {
        subscriptionId: subscription.id,
        label: subscription.label,
        targetHost: subscription.targetHost,
        eventTypes: subscription.eventTypes,
        createdByKind: subscription.createdBy.kind,
      },
    });
  }
}
