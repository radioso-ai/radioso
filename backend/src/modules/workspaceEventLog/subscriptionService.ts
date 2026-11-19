import { randomBytes } from "node:crypto";

import type { AccountPermission } from "../account/public.js";
import type { AuditPort } from "../audit/contracts/index.js";
import { AppError, notFound } from "../../shared/domain/errors.js";
import type { WorkspaceEventType } from "../../shared/domain/workspaceEventLog.js";
import {
  WORKSPACE_EVENT_SUBSCRIPTION_CAP,
  type EventSubscriptionCreator,
  type EventSubscriptionLabel,
  type StoredEventSubscription,
  type WorkspaceEventSubscriptionStore,
} from "../../shared/domain/workspaceEventSubscriptions.js";
import { normalizeWebhookTargetUrl, type WebhookUrlGuard } from "../../shared/infra/http/signedWebhook.js";
import { permissionsToReadEventTypes } from "./readPermissions.js";
import type { SubscriptionSealer } from "./subscriptionSecrets.js";
import { presentEventSubscription, type EventSubscriptionView } from "./subscriptionView.js";

/** The permission that creates, lists and deletes subscriptions. Each subscribed type also needs its read permission. */
export const WORKSPACE_EVENT_SUBSCRIPTIONS_MANAGE_PERMISSION =
  "workspace.event_subscriptions.manage" as const satisfies AccountPermission;

/** The longest host `target_host` holds. */
const MAX_TARGET_HOST_LENGTH = 255;

const invalidTargetUrl = (): AppError =>
  new AppError(400, "invalid_target_url", "The target URL must be a valid https URL, without a username or password, whose host resolves to a public address");

const subscriptionNotFound = (): AppError => notFound("Event subscription not found");

/** Who acted, for the audit record. */
interface EventSubscriptionActor {
  accountId: string | null;
}

/** Whether the caller holds every permission listed, however the edge checks its permissions. */
type PermissionCheck = (permissions: readonly AccountPermission[]) => Promise<boolean>;

/**
 * Creates, lists and deletes a workspace's event subscriptions (#1852). A subscription receives
 * only types its creator may read, by the same rule every push re-checks, at a public https URL,
 * and holds its URL and secret sealed. Subscribing a URL the workspace already subscribed replaces
 * that subscription with a new one under a new id, so a client that retries a create it never heard
 * back from still has exactly one, and a late delete of the replaced id finds nothing to remove.
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
    permits: PermissionCheck;
  }): Promise<{ subscription: EventSubscriptionView; signingSecret: string }> {
    const eventTypes = [...new Set(input.eventTypes)];
    const refused: WorkspaceEventType[] = [];
    for (const type of eventTypes) {
      if (!(await input.permits(permissionsToReadEventTypes([type])))) refused.push(type);
    }
    if (refused.length > 0) {
      throw new AppError(403, "event_type_not_permitted", "The caller may not read these event types", { types: refused });
    }
    const target = await this.normalizeTarget(input.targetUrl);
    const signingSecret = this.dependencies.generateSecret?.() ?? randomBytes(32).toString("base64url");
    const { sealer } = this.dependencies;
    const stored = await this.dependencies.store.upsertWithinCap({
      workspaceId: input.workspaceId,
      label: input.label,
      targetHost: target.host,
      targetUrlCiphertext: sealer.seal(target.href),
      targetUrlHashes: sealer.targetHashes(target.href),
      secretCiphertext: sealer.seal(signingSecret),
      eventTypes,
      createdBy: input.createdBy,
      cap: WORKSPACE_EVENT_SUBSCRIPTION_CAP,
    });
    if (!stored) {
      throw new AppError(
        409,
        "event_subscription_limit_reached",
        `A workspace holds at most ${WORKSPACE_EVENT_SUBSCRIPTION_CAP} event subscriptions; delete one first`,
        { limit: WORKSPACE_EVENT_SUBSCRIPTION_CAP },
      );
    }
    if (stored.replacedSubscriptionId) {
      await this.audit("workspace_event_subscription.replaced", input.actor, stored.subscription, { previousSubscriptionId: stored.replacedSubscriptionId });
    } else {
      await this.audit("workspace_event_subscription.created", input.actor, stored.subscription);
    }
    return { subscription: presentEventSubscription(stored.subscription), signingSecret };
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

  /**
   * The target as stored and compared: the outbound URL rule's normalized URL, in its canonical
   * form. A URL that carries credentials in its userinfo is refused, so none is ever stored or
   * sent, and so is a host longer than the stored host column.
   */
  private async normalizeTarget(value: string): Promise<URL> {
    const parsed = URL.canParse(value) ? new URL(value) : null;
    if (!parsed || parsed.username !== "" || parsed.password !== "" || parsed.host.length > MAX_TARGET_HOST_LENGTH) {
      throw invalidTargetUrl();
    }
    try {
      return new URL(await normalizeWebhookTargetUrl(value, {
        assertPublicUrl: this.dependencies.assertPublicUrl,
        allowHttpLoopback: this.dependencies.allowHttpLoopback,
      }));
    } catch {
      // Malformed, not https, or a host that is not public: one answer, so a probe learns nothing
      // about which private hosts resolve.
      throw invalidTargetUrl();
    }
  }

  private async audit(
    eventType: string,
    actor: EventSubscriptionActor,
    subscription: StoredEventSubscription,
    extra: Record<string, string> = {},
  ): Promise<void> {
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
        ...extra,
      },
    });
  }
}
