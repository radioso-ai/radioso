import type { RealtimeSessionRecord, RealtimeSessionStore } from "../domain/contracts.js";

export type AuthenticatedRealtimeSession = {
  accountId: string;
  principalId: string;
  workspaceId: string;
  sessionExpiresAt: Date;
};

export type RealtimeSessionAuthInput = {
  sessionToken: string;
  requestedWorkspaceId: string;
  signal: AbortSignal;
};

export interface RealtimeSessionAuthPort {
  authenticate(input: RealtimeSessionAuthInput): Promise<AuthenticatedRealtimeSession>;
}

export class RealtimeSessionAuthError extends Error {
  readonly statusCode: 401 | 403;

  constructor(readonly reason: "invalid" | "forbidden" | "aborted") {
    super(reason === "aborted" ? "Realtime session authentication aborted" : "Realtime session is not authorized");
    this.name = reason === "aborted" ? "AbortError" : "RealtimeSessionAuthError";
    this.statusCode = reason === "forbidden" ? 403 : 401;
  }
}

/** Canonical dashboard-session authentication boundary for the realtime route. */
export class RealtimeSessionAuthenticator implements RealtimeSessionAuthPort {
  private readonly touchedSessions = new Map<string, number>();
  private readonly touchIntervalMs: number;
  private readonly maxTrackedTouches: number;
  private readonly now: () => number;

  constructor(private readonly input: {
    store: RealtimeSessionStore;
    touchIntervalMs?: number;
    maxTrackedTouches?: number;
    now?: () => number;
  }) {
    this.touchIntervalMs = input.touchIntervalMs ?? 60_000;
    this.maxTrackedTouches = input.maxTrackedTouches ?? 1024;
    if (this.touchIntervalMs <= 0 || this.maxTrackedTouches <= 0) {
      throw new Error("realtime session touch options must be positive");
    }
    this.now = input.now ?? Date.now;
  }

  async authenticate(input: RealtimeSessionAuthInput): Promise<AuthenticatedRealtimeSession> {
    if (input.signal.aborted) throw new RealtimeSessionAuthError("aborted");
    const record = await this.withAbort(
      this.input.store.lookup({ sessionToken: input.sessionToken, workspaceId: input.requestedWorkspaceId }),
      input.signal,
    );
    if (input.signal.aborted) throw new RealtimeSessionAuthError("aborted");
    this.authorize(record, input.requestedWorkspaceId);
    this.touchLastSeenBestEffort(record.sessionId);
    return {
      accountId: record.accountId,
      principalId: record.userId,
      workspaceId: record.workspaceId,
      sessionExpiresAt: record.sessionExpiresAt,
    };
  }

  private authorize(record: RealtimeSessionRecord | null, requestedWorkspaceId: string): asserts record is RealtimeSessionRecord {
    if (
      !record
      || record.credentialType !== "dashboard_session"
      || !record.sessionActive
      || record.sessionExpiresAt.getTime() <= this.now()
    ) {
      throw new RealtimeSessionAuthError("invalid");
    }
    if (!record.accountMembershipActive || !record.workspaceOwned || record.workspaceId !== requestedWorkspaceId) {
      throw new RealtimeSessionAuthError("forbidden");
    }
  }

  private async withAbort<T>(operation: Promise<T>, signal: AbortSignal): Promise<T> {
    if (signal.aborted) throw new RealtimeSessionAuthError("aborted");
    return await new Promise<T>((resolve, reject) => {
      const onAbort = () => reject(new RealtimeSessionAuthError("aborted"));
      signal.addEventListener("abort", onAbort, { once: true });
      operation.then(resolve, reject).finally(() => signal.removeEventListener("abort", onAbort));
    });
  }

  private touchLastSeenBestEffort(sessionId: string): void {
    const now = this.now();
    const previous = this.touchedSessions.get(sessionId);
    if (previous !== undefined && now - previous < this.touchIntervalMs) return;
    if (previous === undefined && this.touchedSessions.size >= this.maxTrackedTouches) {
      const oldestSessionId = this.touchedSessions.keys().next().value;
      if (oldestSessionId) this.touchedSessions.delete(oldestSessionId);
    }
    if (previous !== undefined) this.touchedSessions.delete(sessionId);
    this.touchedSessions.set(sessionId, now);
    void this.input.store.touchLastSeen(sessionId).catch(() => undefined);
  }
}
