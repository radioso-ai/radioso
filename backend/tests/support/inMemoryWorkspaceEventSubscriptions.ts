import { randomUUID } from "node:crypto";

import type {
  DueEventSubscription,
  SealedEventSubscription,
  StoredEventSubscription,
  WorkspaceEventSubscriptionStore,
} from "../../src/shared/domain/workspaceEventSubscriptions.js";
import type { SubscriptionSealer } from "../../src/modules/workspaceEventLog/subscriptionSecrets.js";

/** Seals by tagging, so a test can see a value was sealed and open it again. Never for production. */
export const taggingSealer: SubscriptionSealer = {
  seal: (plaintext) => `sealed:${plaintext}`,
  open: (ciphertext) => ciphertext.replace(/^sealed:/u, ""),
};

/** The subscription store in memory, for route tests. Delivery writes are recorded as given. */
export class InMemoryWorkspaceEventSubscriptionStore implements WorkspaceEventSubscriptionStore {
  readonly rows = new Map<string, SealedEventSubscription>();

  async createWithinCap(input: Parameters<WorkspaceEventSubscriptionStore["createWithinCap"]>[0]): Promise<StoredEventSubscription | null> {
    const held = [...this.rows.values()].filter((row) => row.workspaceId === input.workspaceId).length;
    if (held >= input.cap) return null;
    const creator = input.createdBy;
    const row: SealedEventSubscription = {
      id: randomUUID(),
      workspaceId: input.workspaceId,
      label: input.label,
      targetHost: input.targetHost,
      targetUrlCiphertext: input.targetUrlCiphertext,
      secretCiphertext: input.secretCiphertext,
      eventTypes: [...input.eventTypes],
      status: "active",
      disabledReason: null,
      disabledAt: null,
      createdAt: new Date(),
      createdBy: {
        kind: creator.kind,
        credentialId: creator.kind === "teammate" ? null : creator.credentialId,
        serviceAccountId: creator.kind === "service_account" ? creator.serviceAccountId : null,
        userId: creator.kind === "service_account" ? null : creator.userId,
        label: null,
      },
      cursor: { tx: "1", position: "0" },
      lastDelivery: null,
      consecutiveFailures: 0,
      failingSince: null,
      nextAttemptAt: null,
    };
    this.rows.set(row.id, row);
    return row;
  }

  async list(workspaceId: string): Promise<StoredEventSubscription[]> {
    return [...this.rows.values()].filter((row) => row.workspaceId === workspaceId).reverse();
  }

  async find(workspaceId: string, subscriptionId: string): Promise<StoredEventSubscription | null> {
    return this.findSealed(workspaceId, subscriptionId);
  }

  async findSealed(workspaceId: string, subscriptionId: string): Promise<SealedEventSubscription | null> {
    const row = this.rows.get(subscriptionId);
    return row && row.workspaceId === workspaceId ? row : null;
  }

  async delete(workspaceId: string, subscriptionId: string): Promise<StoredEventSubscription | null> {
    const row = await this.findSealed(workspaceId, subscriptionId);
    if (row) this.rows.delete(subscriptionId);
    return row;
  }

  async recordDelivered(input: Parameters<WorkspaceEventSubscriptionStore["recordDelivered"]>[0]): Promise<boolean> {
    const row = await this.findSealed(input.workspaceId, input.subscriptionId);
    if (!row || row.status !== "active") return false;
    Object.assign(row, {
      cursor: input.position,
      lastDelivery: { at: input.at, outcome: "delivered", statusCode: input.statusCode },
      consecutiveFailures: 0,
      failingSince: null,
      nextAttemptAt: null,
    });
    return true;
  }

  async recordFailed(input: Parameters<WorkspaceEventSubscriptionStore["recordFailed"]>[0]): Promise<boolean> {
    const row = await this.findSealed(input.workspaceId, input.subscriptionId);
    if (!row || row.status !== "active") return false;
    Object.assign(row, {
      lastDelivery: { at: input.at, outcome: "failed", statusCode: input.statusCode },
      consecutiveFailures: input.consecutiveFailures,
      failingSince: input.failingSince,
      nextAttemptAt: input.nextAttemptAt,
      ...(input.disable ? { status: "disabled", disabledReason: "delivery_failing", disabledAt: input.at } : {}),
    });
    return true;
  }

  async disable(input: Parameters<WorkspaceEventSubscriptionStore["disable"]>[0]): Promise<boolean> {
    const row = await this.findSealed(input.workspaceId, input.subscriptionId);
    if (!row || row.status !== "active") return false;
    Object.assign(row, { status: "disabled", disabledReason: input.reason, disabledAt: input.at });
    return true;
  }

  async findDue(): Promise<DueEventSubscription[]> {
    return [];
  }
}
