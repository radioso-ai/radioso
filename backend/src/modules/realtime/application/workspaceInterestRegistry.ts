import type { WorkspaceInvalidationKind } from "@radioso/workspace-invalidation-contract";
import type { WorkspaceInterestTransport, WorkspaceInvalidationListener } from "../domain/contracts.js";
import { RealtimeSession } from "../domain/realtimeSession.js";

interface Interest {
  sessions: Map<string, RealtimeSession>;
  listener: WorkspaceInvalidationListener;
  attached: boolean;
  queue: Promise<void>;
}

/** Serializes desired local interest so attach/detach races cannot leak a listener. */
export class WorkspaceInterestRegistry {
  private readonly interests = new Map<string, Interest>();

  constructor(private readonly input: { transport: WorkspaceInterestTransport; maxWorkspaces: number }) {}

  async add(session: RealtimeSession): Promise<void> {
    const workspaceId = session.identity.workspaceId;
    let interest = this.interests.get(workspaceId);
    if (!interest) {
      if (this.interests.size >= this.input.maxWorkspaces) throw new Error("workspace interest capacity exceeded");
      interest = {
        sessions: new Map(),
        listener: (kinds) => this.deliver(workspaceId, kinds),
        attached: false,
        queue: Promise.resolve(),
      };
      this.interests.set(workspaceId, interest);
    }
    interest.sessions.set(session.identity.connectionId, session);
    await this.reconcile(workspaceId, interest);
  }

  async remove(session: RealtimeSession): Promise<void> {
    const workspaceId = session.identity.workspaceId;
    const interest = this.interests.get(workspaceId);
    if (!interest || !interest.sessions.delete(session.identity.connectionId)) return;
    await this.reconcile(workspaceId, interest);
  }

  deliver(workspaceId: string, kinds: readonly WorkspaceInvalidationKind[]): void {
    for (const session of this.interests.get(workspaceId)?.sessions.values() ?? []) session.mergeInvalidation(kinds);
  }

  private reconcile(workspaceId: string, interest: Interest): Promise<void> {
    const run = async () => {
      if (this.interests.get(workspaceId) !== interest) {
        if (interest.sessions.size > 0) throw new Error("workspace interest lifecycle was superseded");
        return;
      }
      const desired = interest.sessions.size > 0;
      if (desired && !interest.attached) {
        try {
          await this.input.transport.subscribe(workspaceId, interest.listener);
          if (this.interests.get(workspaceId) !== interest) return;
          interest.attached = true;
        } catch (error) {
          interest.attached = false;
          if (this.interests.get(workspaceId) === interest) this.interests.delete(workspaceId);
          throw error;
        }
      }
      if (!desired && interest.attached) {
        try {
          await this.input.transport.unsubscribe(workspaceId, interest.listener);
        } catch (error) {
          // The port guarantees local detachment before rejecting. If a new
          // session arrived during the failed release, re-establish its known
          // local/remote interest before its queued admission can resolve.
          interest.attached = false;
          if (this.interests.get(workspaceId) !== interest) throw error;
          if (interest.sessions.size > 0) {
            try {
              await this.input.transport.subscribe(workspaceId, interest.listener);
              if (this.interests.get(workspaceId) !== interest) throw error;
              interest.attached = true;
              return;
            } catch (reattachError) {
              if (this.interests.get(workspaceId) === interest) this.interests.delete(workspaceId);
              throw reattachError;
            }
          }
          this.interests.delete(workspaceId);
          throw error;
        }
        interest.attached = false;
        if (interest.sessions.size > 0) return;
      }
      if (this.interests.get(workspaceId) === interest && interest.sessions.size === 0 && !interest.attached) this.interests.delete(workspaceId);
    };
    interest.queue = interest.queue.catch(() => undefined).then(run);
    return interest.queue;
  }
}
