import type { LogPosition, WorkspaceEventType } from "./workspaceEventLog.js";

/**
 * Workspace event subscriptions' contract (#1852): a URL an automation client registers to receive
 * the event log's events as signed POSTs, and the port the subscriptions are stored through. It
 * lives beside the log's own contract because the Postgres store in `db/repositories` implements
 * it, and an adapter there may not import a module.
 */

/** Who registered the subscription, as the client names itself. Display only. */
export const EVENT_SUBSCRIPTION_LABELS = ["zapier", "n8n", "custom"] as const;
export type EventSubscriptionLabel = typeof EVENT_SUBSCRIPTION_LABELS[number];

export const EVENT_SUBSCRIPTION_STATUSES = ["active", "disabled"] as const;
export type EventSubscriptionStatus = typeof EVENT_SUBSCRIPTION_STATUSES[number];

/**
 * Why a subscription stopped: its target kept failing for a day, or the credential or teammate that
 * created it may no longer read what it subscribes to.
 */
export const EVENT_SUBSCRIPTION_DISABLED_REASONS = ["delivery_failing", "creator_revoked"] as const;
export type EventSubscriptionDisabledReason = typeof EVENT_SUBSCRIPTION_DISABLED_REASONS[number];

export const EVENT_DELIVERY_OUTCOMES = ["delivered", "failed"] as const;
export type EventDeliveryOutcome = typeof EVENT_DELIVERY_OUTCOMES[number];

export const EVENT_SUBSCRIPTION_CREATOR_KINDS = ["service_account", "personal_token", "teammate"] as const;
export type EventSubscriptionCreatorKind = typeof EVENT_SUBSCRIPTION_CREATOR_KINDS[number];

/** How many subscriptions a workspace may hold, active and disabled together. */
export const WORKSPACE_EVENT_SUBSCRIPTION_CAP = 25;

/** The caller that creates a subscription, which every push is re-checked against. */
export type EventSubscriptionCreator =
  | { kind: "service_account"; credentialId: string; serviceAccountId: string }
  | { kind: "personal_token"; credentialId: string; userId: string }
  | { kind: "teammate"; userId: string };

/**
 * The creator as stored. An id is null once its row is gone, which the owner check reads as
 * revoked. `label` is the service account's or token's name, or the teammate's, read with the row.
 */
export interface StoredEventSubscriptionCreator {
  kind: EventSubscriptionCreatorKind;
  credentialId: string | null;
  serviceAccountId: string | null;
  userId: string | null;
  label: string | null;
}

export interface EventSubscriptionLastDelivery {
  at: Date;
  outcome: EventDeliveryOutcome;
  statusCode: number | null;
}

/** A subscription as stored, without its sealed target URL and secret. */
export interface StoredEventSubscription {
  id: string;
  workspaceId: string;
  label: EventSubscriptionLabel;
  targetHost: string;
  eventTypes: WorkspaceEventType[];
  status: EventSubscriptionStatus;
  disabledReason: EventSubscriptionDisabledReason | null;
  disabledAt: Date | null;
  createdAt: Date;
  createdBy: StoredEventSubscriptionCreator;
  /** The last event its target accepted, or the log's horizon when it was created. */
  cursor: LogPosition;
  lastDelivery: EventSubscriptionLastDelivery | null;
  consecutiveFailures: number;
  failingSince: Date | null;
  nextAttemptAt: Date | null;
}

/** A subscription with its target URL and signing secret, both encrypted, for delivery. */
export interface SealedEventSubscription extends StoredEventSubscription {
  targetUrlCiphertext: string;
  secretCiphertext: string;
}

/** A subscription a drain should run for. */
export interface DueEventSubscription {
  workspaceId: string;
  subscriptionId: string;
}

/**
 * Where subscriptions are stored. Delivery writes go to an active subscription only, so a drain
 * that races a delete or a disable writes nothing.
 */
export interface WorkspaceEventSubscriptionStore {
  /**
   * Creates the subscription at the log's horizon, unless the workspace already holds `cap`; null
   * then. Counting and inserting are serialized per workspace, so two creates never pass the cap.
   */
  createWithinCap(input: {
    workspaceId: string;
    label: EventSubscriptionLabel;
    targetHost: string;
    targetUrlCiphertext: string;
    secretCiphertext: string;
    eventTypes: readonly WorkspaceEventType[];
    createdBy: EventSubscriptionCreator;
    cap: number;
  }): Promise<StoredEventSubscription | null>;
  list(workspaceId: string): Promise<StoredEventSubscription[]>;
  find(workspaceId: string, subscriptionId: string): Promise<StoredEventSubscription | null>;
  findSealed(workspaceId: string, subscriptionId: string): Promise<SealedEventSubscription | null>;
  /** Deletes it, and returns what was deleted. */
  delete(workspaceId: string, subscriptionId: string): Promise<StoredEventSubscription | null>;
  /** Its target accepted the event at `position`: the cursor moves past it and the streak ends. */
  recordDelivered(input: {
    workspaceId: string;
    subscriptionId: string;
    position: LogPosition;
    statusCode: number;
    at: Date;
  }): Promise<boolean>;
  /** A push failed: the streak, when the next attempt is due, and, when the streak is long enough, disabled. */
  recordFailed(input: {
    workspaceId: string;
    subscriptionId: string;
    statusCode: number | null;
    at: Date;
    consecutiveFailures: number;
    failingSince: Date;
    nextAttemptAt: Date;
    disable: boolean;
  }): Promise<boolean>;
  disable(input: {
    workspaceId: string;
    subscriptionId: string;
    reason: EventSubscriptionDisabledReason;
    at: Date;
  }): Promise<boolean>;
  /**
   * Active subscriptions that are due and have an event below the log's horizon after their cursor:
   * across every workspace, or in one.
   */
  findDue(input: { workspaceId?: string; limit: number }): Promise<DueEventSubscription[]>;
}

/**
 * Asks for the workspace's due subscriptions to be delivered now, after a change that recorded an
 * event has committed. Best-effort and never awaited: it never throws, and a lost request only waits
 * for the periodic sweep.
 */
export interface WorkspaceEventDeliveryWake {
  requestDelivery(workspaceId: string): void;
}
