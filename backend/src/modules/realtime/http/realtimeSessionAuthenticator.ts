import type { RealtimeSessionRecord, RealtimeSessionStore } from "../domain/contracts.js";

export interface AuthenticatedRealtimeSession {
  accountId: string;
  userId: string;
  workspaceId: string;
  sessionExpiresAt: Date;
}

export class RealtimeSessionAuthenticator {
  private readonly touchedSessions = new Map<string, number>();
  private readonly touchIntervalMs: number;
  private readonly maxTrackedTouches: number;
  private readonly now: () => number;

  constructor(private readonly input: { store: RealtimeSessionStore; touchIntervalMs?: number; maxTrackedTouches?: number; now?: () => number }) {
    this.touchIntervalMs = input.touchIntervalMs ?? 60_000;
    this.maxTrackedTouches = input.maxTrackedTouches ?? 1024;
    if (this.touchIntervalMs <= 0 || this.maxTrackedTouches <= 0) throw new Error("realtime session touch options must be positive");
    this.now = input.now ?? Date.now;
  }

  async authenticate(input: { sessionToken: string; workspaceId: string; headerWorkspaceId?: string; expectedAccountId?: string }): Promise<AuthenticatedRealtimeSession> {
    if (input.headerWorkspaceId && input.headerWorkspaceId !== input.workspaceId) throw new Error("realtime session workspace header mismatch");
    const record = await this.input.store.lookup({ sessionToken: input.sessionToken, workspaceId: input.workspaceId });
    if (!this.isValid(record, input.workspaceId) || (input.expectedAccountId && record.accountId !== input.expectedAccountId)) throw new Error("realtime session is not authorized");
    this.touchLastSeenBestEffort(record.sessionId);
    return { accountId: record.accountId, userId: record.userId, workspaceId: record.workspaceId, sessionExpiresAt: record.sessionExpiresAt };
  }

  private isValid(record: RealtimeSessionRecord | null, workspaceId: string): record is RealtimeSessionRecord {
    return Boolean(record && record.credentialType === "dashboard_session" && record.workspaceId === workspaceId && record.sessionActive && record.accountMembershipActive && record.workspaceOwned && record.sessionExpiresAt.getTime() > this.now());
  }

  private touchLastSeenBestEffort(sessionId: string): void {
    const now = this.now();
    const previous = this.touchedSessions.get(sessionId);
    if (previous !== undefined && now - previous < this.touchIntervalMs) return;
    if (previous === undefined && this.touchedSessions.size >= this.maxTrackedTouches) {
      const oldestSessionId = this.touchedSessions.keys().next().value;
      if (oldestSessionId) this.touchedSessions.delete(oldestSessionId);
    }
    // Refreshing an entry moves it to the LRU tail.
    if (previous !== undefined) this.touchedSessions.delete(sessionId);
    this.touchedSessions.set(sessionId, now);
    void this.input.store.touchLastSeen(sessionId).catch(() => undefined);
  }
}
