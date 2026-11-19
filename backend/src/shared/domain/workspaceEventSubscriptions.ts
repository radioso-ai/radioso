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
 * revoked. `label` is the service account's or token's name, or the teammate's display name (never
 * their email), read with the row; null for a teammate without one.
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

/** A failure streak as the store counted it: the attempt just recorded included. */
export interface FailedDeliveryStreak {
  consecutiveFailures: number;
  failingSince: Date;
}

/** Where the subscription lifecycle (create, list, delete) stores subscriptions. */
export interface WorkspaceEventSubscriptionStore {
  /**
   * Subscribes a target, one subscription per target per workspace. `targetUrlHashes` is the
   * target's keyed hash under every configured key, the current key's first, so a target hashed
   * before a key rotation is still found.
   *
   * Without a subscription for the target, creates one at the log's horizon, unless the workspace
   * already holds `cap` (null then). With one, replaces it with a new subscription under a new id,
   * so a late delete of the old id never removes the new one: it takes the old cursor when the old
   * one was active, so nothing is skipped or sent twice, and starts at the horizon when it was
   * disabled. `replacedSubscriptionId` names the one replaced. Serialized per workspace.
   */
  upsertWithinCap(input: {
    workspaceId: string;
    label: EventSubscriptionLabel;
    targetHost: string;
    targetUrlCiphertext: string;
    targetUrlHashes: readonly [string, ...string[]];
    secretCiphertext: string;
    eventTypes: readonly WorkspaceEventType[];
    createdBy: EventSubscriptionCreator;
    cap: number;
  }): Promise<{ subscription: StoredEventSubscription; replacedSubscriptionId: string | null } | null>;
  list(workspaceId: string): Promise<StoredEventSubscription[]>;
  find(workspaceId: string, subscriptionId: string): Promise<StoredEventSubscription | null>;
  /** Deletes it, and returns what was deleted. */
  delete(workspaceId: string, subscriptionId: string): Promise<StoredEventSubscription | null>;
}

/**
 * What delivery reads and writes. Every write goes to an active subscription only, so a drain that
 * races a delete, a disable or a newer run writes nothing and learns it from the `false` or `null`.
 */
export interface EventSubscriptionDeliveryStore {
  /** The subscription with its sealed target URL and secret. */
  findSealed(workspaceId: string, subscriptionId: string): Promise<SealedEventSubscription | null>;
  /**
   * Its target accepted the event at `position`: the cursor moves to it and the streak ends. False
   * when the subscription is no longer active or its cursor is already at or past `position`.
   */
  recordDelivered(input: {
    workspaceId: string;
    subscriptionId: string;
    position: LogPosition;
    statusCode: number;
    at: Date;
  }): Promise<boolean>;
  /** Moves the cursor forward to `position` when it is behind it: a read found nothing more below it. */
  advanceCursor(input: { workspaceId: string; subscriptionId: string; position: LogPosition }): Promise<void>;
  /**
   * A push failed. The store counts the attempt into the streak, then `schedule` decides from that
   * streak when the next attempt is due and whether the subscription is disabled for failing.
   * Null when the subscription is no longer active.
   */
  recordFailed(input: {
    workspaceId: string;
    subscriptionId: string;
    statusCode: number | null;
    at: Date;
    schedule: (streak: FailedDeliveryStreak) => { nextAttemptAt: Date; disable: boolean };
  }): Promise<(FailedDeliveryStreak & { disabled: boolean }) | null>;
  disable(input: {
    workspaceId: string;
    subscriptionId: string;
    reason: EventSubscriptionDisabledReason;
    at: Date;
  }): Promise<boolean>;
  /**
   * Active subscriptions that are due and have an event below the log's horizon after their cursor,
   * across every workspace or in one, in id order after `afterSubscriptionId`.
   */
  findDue(input: { workspaceId?: string; afterSubscriptionId?: string; limit: number }): Promise<DueEventSubscription[]>;
}

/**
 * Asks for the workspace's due subscriptions to be delivered now, after a change that recorded an
 * event has committed. Best-effort and never awaited: it never throws, and a lost request only waits
 * for the periodic sweep.
 */
export interface WorkspaceEventDeliveryWake {
  requestDelivery(workspaceId: string): void;
}
