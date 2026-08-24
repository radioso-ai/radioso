import type { WorkspaceInvalidationEnvelope, WorkspaceInvalidationKind, WorkspaceInvalidationPublisher } from "@radioso/workspace-invalidation-contract";

export type { WorkspaceInvalidationKind, WorkspaceInvalidationPublisher } from "@radioso/workspace-invalidation-contract";

export interface WorkspaceInvalidationTransport {
  publish(envelope: WorkspaceInvalidationEnvelope, options: { signal: AbortSignal }): Promise<void>;
  close?(): Promise<void>;
}

export interface WorkspaceInterestTransport {
  subscribe(workspaceId: string, listener: WorkspaceInvalidationListener): Promise<void>;
  /**
   * Detaches the exact listener from local fan-out before awaiting broker acknowledgement.
   * A rejection may mean remote state is uncertain, but the transport must retain no
   * callback reference and must heal channel state through its connection generation.
   */
  unsubscribe(workspaceId: string, listener: WorkspaceInvalidationListener): Promise<void>;
}

export type WorkspaceInvalidationListener = (changeKinds: readonly WorkspaceInvalidationKind[]) => void;

/** Phase 4 transport lifecycle vocabulary; Phase 2 only owns subscribing/active cleanup. */
export type WorkspaceInterestLifecycleState = "subscribing" | "active" | "reconnecting" | "releasing";

export interface RealtimeAdmissionLease {
  release(): Promise<void>;
}

export interface RealtimeAdmissionController {
  admit(input: { accountId: string; workspaceId: string; principalId: string }): Promise<RealtimeAdmissionLease>;
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
