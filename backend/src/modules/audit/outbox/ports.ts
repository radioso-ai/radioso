import type { AuditOutboxPort } from "../contracts/index.js";

export type {
  AuditOutboxDispatcher,
  AuditOutboxDrainResult,
  AuditOutboxIntent,
  AuditOutboxPort,
} from "../contracts/index.js";

/** One event as a claim holds it, with the identity every delivery attempt carries. */
export interface ClaimedAuditOutboxEntry {
  eventId: string;
  accountId: string | null;
  /** Null when the row never named a workspace, or when that workspace is gone. */
  workspaceId: string | null;
  /** The former workspace, when `workspaceId` is null because that workspace is gone. */
  deletedWorkspaceId: string | null;
  eventType: string;
  eventStatus: "success" | "failure";
  metadata: Record<string, unknown>;
  attemptCount: number;
}

export interface AuditOutboxClaim {
  claimToken: string;
  entries: readonly ClaimedAuditOutboxEntry[];
}

/**
 * The repository surface the dispatcher depends on, beyond the enqueue every
 * caller uses. Claim and acknowledge are the dispatcher's alone: nothing outside
 * this module leases a batch or removes a row from it.
 */
export interface AuditOutboxRepositoryPort extends AuditOutboxPort {
  /**
   * Leases a bounded batch of unclaimed or lapsed entries and commits the lease
   * before anything is published.
   */
  claim(input: { limit: number; leaseSeconds: number }): Promise<AuditOutboxClaim>;
  /** Removes the entries this claim published, by the token that leased them. */
  acknowledge(input: { claimToken: string; eventIds: readonly string[] }): Promise<number>;
}
