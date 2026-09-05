import type { WorkspaceInvalidationEnvelope, WorkspaceInvalidationKind } from "@radioso/workspace-invalidation-contract";

export type { WorkspaceInvalidationKind } from "@radioso/workspace-invalidation-contract";

export interface WorkspaceInvalidationTransport {
  publish(envelope: WorkspaceInvalidationEnvelope, options: { signal: AbortSignal }): Promise<void>;
  close?(): Promise<void>;
}

export interface WorkspaceInterestTransport {
  /** The returned continuity generation fences gateway readiness after reconnects. */
  subscribe(workspaceId: string, listener: WorkspaceInvalidationListener): Promise<WorkspaceInterestSubscription>;
  /**
   * Detaches the exact listener from local fan-out before awaiting broker acknowledgement.
   * A rejection may mean remote state is uncertain, but the transport must retain no
   * callback reference and must heal channel state through its connection generation.
   */
  unsubscribe(workspaceId: string, listener: WorkspaceInvalidationListener): Promise<void>;
}

export type WorkspaceInvalidationListener = (changeKinds: readonly WorkspaceInvalidationKind[]) => void;
export type WorkspaceInterestSubscription = { generation: number };

/** Provider-neutral continuity is a convergence signal, never a Redis detail. */
export type WorkspaceInterestContinuity = { generation: number; state: "lost" | "restored" };
export type WorkspaceInterestContinuityListener = (event: WorkspaceInterestContinuity) => void;

export interface WorkspaceInterestContinuitySource {
  onContinuity(listener: WorkspaceInterestContinuityListener): () => void;
}

/** Phase 4 transport lifecycle vocabulary; Phase 2 only owns subscribing/active cleanup. */
export type WorkspaceInterestLifecycleState = "subscribing" | "active" | "reconnecting" | "releasing";

export type AdmissionLeaseRisk = { reason: "renewal_failed" | "expiry_risk" | "fenced"; closeAtMs: number };

export class RealtimeAdmissionError extends Error {
  constructor(
    readonly reason: "account_limit" | "workspace_limit" | "principal_limit" | "reconnect_limit" | "cleanup_backlog" | "redis_unavailable" | "local_capacity" | "fenced",
    readonly statusCode: 429 | 503,
    readonly retryAfterMs: number,
  ) {
    super(`Realtime admission ${reason}`);
    this.name = "RealtimeAdmissionError";
  }
}

export interface RealtimeAdmissionLease {
  risk: Promise<AdmissionLeaseRisk>;
  release(): Promise<void>;
}

/** Provider-neutral readiness signal for the future gateway admission seam. */
export type RealtimeAdmissionHealth = { state: "degraded" | "restored" };
export type RealtimeAdmissionHealthListener = (health: RealtimeAdmissionHealth) => void;

export interface RealtimeAdmissionController {
  admit(input: { accountId: string; workspaceId: string; principalId: string }): Promise<RealtimeAdmissionLease>;
  checkReconnect(input: { accountId: string; workspaceId: string; principalId: string }): Promise<void>;
  onHealth(listener: RealtimeAdmissionHealthListener): () => void;
}

export interface RealtimeSessionRecord {
  sessionId: string;
  accountId: string;
  userId: string;
  workspaceId: string;
  sessionExpiresAt: Date;
  sessionActive: boolean;
  accountMembershipActive: boolean;
  workspaceOwned: boolean;
  credentialType: "dashboard_session" | "workspace_api_token";
}

export interface RealtimeSessionStore {
  lookup(input: { sessionToken: string; workspaceId: string }): Promise<RealtimeSessionRecord | null>;
  touchLastSeen(sessionId: string): Promise<void>;
}
