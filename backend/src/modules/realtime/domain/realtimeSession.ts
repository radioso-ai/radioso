import type { WorkspaceInvalidationKind } from "@radioso/workspace-invalidation-contract";

export type PendingRealtimeSessionState = { type: "invalidate"; changeKinds: WorkspaceInvalidationKind[] } | { type: "resync" } | undefined;

export class RealtimeSession {
  private closed = false;
  private pendingState: PendingRealtimeSessionState;

  constructor(readonly identity: { connectionId: string; workspaceId: string }) {}

  mergeInvalidation(kinds: readonly WorkspaceInvalidationKind[]): void {
    if (this.closed || this.pendingState?.type === "resync") return;
    this.pendingState = { type: "invalidate", changeKinds: [...new Set([...(this.pendingState?.changeKinds ?? []), ...kinds])] };
  }

  requireResync(): void { if (!this.closed) this.pendingState = { type: "resync" }; }
  pending(): PendingRealtimeSessionState { return this.pendingState; }
  /** Atomically removes the current marker so a concurrent merge lands in a fresh slot. */
  takePending(): PendingRealtimeSessionState { const pending = this.pendingState; this.pendingState = undefined; return pending; }
  /** Restores only if no newer marker arrived; resync remains dominant. */
  restorePending(pending: PendingRealtimeSessionState): void {
    if (!pending || this.closed || this.pendingState?.type === "resync") return;
    if (pending.type === "resync") this.pendingState = pending;
    else this.mergeInvalidation(pending.changeKinds);
  }
  close(): boolean { if (this.closed) return false; this.closed = true; this.pendingState = undefined; return true; }
}
