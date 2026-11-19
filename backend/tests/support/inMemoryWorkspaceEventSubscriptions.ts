import { createHash, randomUUID } from "node:crypto";

import type {
  DueEventSubscription,
  EventSubscriptionDeliveryStore,
  SealedEventSubscription,
  StoredEventSubscription,
  WorkspaceEventSubscriptionStore,
} from "../../src/shared/domain/workspaceEventSubscriptions.js";
import type { SubscriptionSealer } from "../../src/modules/workspaceEventLog/subscriptionSecrets.js";

/** Seals by tagging, so a test can see a value was sealed and open it again. Never for production. */
export const taggingSealer: SubscriptionSealer = {
  seal: (plaintext) => `sealed:${plaintext}`,
  open: (ciphertext) => ciphertext.replace(/^sealed:/u, ""),
  targetHashes: (normalizedUrl) => [createHash("sha256").update(normalizedUrl).digest("hex")],
};

const compare = (left: { tx: string; position: string }, right: { tx: string; position: string }): number => {
  const tx = BigInt(left.tx) - BigInt(right.tx);
  if (tx !== 0n) return tx < 0n ? -1 : 1;
  const position = BigInt(left.position) - BigInt(right.position);
  return position === 0n ? 0 : position < 0n ? -1 : 1;
};

/** What the store returns from its lifecycle reads: never the sealed columns. */
const unsealed = ({ targetUrlCiphertext: _url, secretCiphertext: _secret, ...stored }: SealedEventSubscription & { targetUrlHash: string }): StoredEventSubscription => stored;

/** The subscription store in memory, for route and drain tests. Delivery writes follow the Postgres store's guards. */
export class InMemoryWorkspaceEventSubscriptionStore implements WorkspaceEventSubscriptionStore, EventSubscriptionDeliveryStore {
  readonly rows = new Map<string, SealedEventSubscription & { targetUrlHash: string }>();

  async upsertWithinCap(input: Parameters<WorkspaceEventSubscriptionStore["upsertWithinCap"]>[0]): Promise<{ subscription: StoredEventSubscription; replacedSubscriptionId: string | null } | null> {
    const creator = input.createdBy;
    const existing = [...this.rows.values()]
      .find((row) => row.workspaceId === input.workspaceId && input.targetUrlHashes.includes(row.targetUrlHash));
    if (existing) {
      this.rows.delete(existing.id);
    } else if ([...this.rows.values()].filter((row) => row.workspaceId === input.workspaceId).length >= input.cap) {
      return null;
    }
    const row = {
      id: randomUUID(),
      workspaceId: input.workspaceId,
      label: input.label,
      targetHost: input.targetHost,
      targetUrlCiphertext: input.targetUrlCiphertext,
      targetUrlHash: input.targetUrlHashes[0],
      secretCiphertext: input.secretCiphertext,
      eventTypes: [...input.eventTypes],
      createdBy: {
        kind: creator.kind,
        credentialId: creator.kind === "teammate" ? null : creator.credentialId,
        serviceAccountId: creator.kind === "service_account" ? creator.serviceAccountId : null,
        userId: creator.kind === "service_account" ? null : creator.userId,
        label: null,
      },
      status: "active" as const,
      disabledReason: null,
      disabledAt: null,
      createdAt: new Date(),
      cursor: existing?.status === "active" ? existing.cursor : { tx: "1", position: "0" },
      lastDelivery: null,
      consecutiveFailures: 0,
      failingSince: null,
      nextAttemptAt: null,
    };
    this.rows.set(row.id, row);
    return { subscription: unsealed(row), replacedSubscriptionId: existing?.id ?? null };
  }

  async list(workspaceId: string): Promise<StoredEventSubscription[]> {
    return [...this.rows.values()].filter((row) => row.workspaceId === workspaceId).reverse().map(unsealed);
  }

  async find(workspaceId: string, subscriptionId: string): Promise<StoredEventSubscription | null> {
    const row = this.row(workspaceId, subscriptionId);
    return row ? unsealed(row) : null;
  }

  async findSealed(workspaceId: string, subscriptionId: string): Promise<SealedEventSubscription | null> {
    return this.row(workspaceId, subscriptionId);
  }

  async delete(workspaceId: string, subscriptionId: string): Promise<StoredEventSubscription | null> {
    const row = this.row(workspaceId, subscriptionId);
    if (row) this.rows.delete(subscriptionId);
    return row ? unsealed(row) : null;
  }

  async recordDelivered(input: Parameters<EventSubscriptionDeliveryStore["recordDelivered"]>[0]): Promise<boolean> {
    const row = this.active(input.workspaceId, input.subscriptionId);
    if (!row || compare(row.cursor, input.position) >= 0) return false;
    Object.assign(row, {
      cursor: input.position,
      lastDelivery: { at: input.at, outcome: "delivered", statusCode: input.statusCode },
      consecutiveFailures: 0,
      failingSince: null,
      nextAttemptAt: null,
    });
    return true;
  }

  async advanceCursor(input: Parameters<EventSubscriptionDeliveryStore["advanceCursor"]>[0]): Promise<void> {
    const row = this.active(input.workspaceId, input.subscriptionId);
    if (row && compare(row.cursor, input.position) < 0) row.cursor = input.position;
  }

  async recordFailed(input: Parameters<EventSubscriptionDeliveryStore["recordFailed"]>[0]): ReturnType<EventSubscriptionDeliveryStore["recordFailed"]> {
    const row = this.active(input.workspaceId, input.subscriptionId);
    if (!row) return null;
    const streak = { consecutiveFailures: row.consecutiveFailures + 1, failingSince: row.failingSince ?? input.at };
    const { nextAttemptAt, disable } = input.schedule(streak);
    Object.assign(row, {
      ...streak,
      lastDelivery: { at: input.at, outcome: "failed", statusCode: input.statusCode },
      nextAttemptAt,
      ...(disable ? { status: "disabled", disabledReason: "delivery_failing", disabledAt: input.at } : {}),
    });
    return { ...streak, disabled: disable };
  }

  async disable(input: Parameters<EventSubscriptionDeliveryStore["disable"]>[0]): Promise<boolean> {
    const row = this.active(input.workspaceId, input.subscriptionId);
    if (!row) return false;
    Object.assign(row, { status: "disabled", disabledReason: input.reason, disabledAt: input.at });
    return true;
  }

  async findDue(): Promise<DueEventSubscription[]> {
    return [];
  }

  private row(workspaceId: string, subscriptionId: string) {
    const row = this.rows.get(subscriptionId);
    return row && row.workspaceId === workspaceId ? row : null;
  }

  private active(workspaceId: string, subscriptionId: string) {
    const row = this.row(workspaceId, subscriptionId);
    return row?.status === "active" ? row : null;
  }
}
