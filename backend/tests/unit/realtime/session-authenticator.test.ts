import { describe, expect, it, vi } from "vitest";
import { RealtimeSessionAuthenticator } from "../../../src/modules/realtime/http/realtimeSessionAuthenticator.js";

const workspaceId = "4d7293c8-d241-4f8f-a4db-3df5b88da44c";
const session = { sessionId: "session", accountId: "account", userId: "user", workspaceId, sessionExpiresAt: new Date(Date.now() + 60_000), sessionActive: true, accountMembershipActive: true, workspaceOwned: true, credentialType: "dashboard_session" as const };

describe("realtime session authenticator", () => {
  it("performs one bounded lookup, returns session expiry, and touches last_seen best-effort", async () => {
    const lookup = vi.fn().mockResolvedValue(session);
    const touchLastSeen = vi.fn().mockRejectedValue(new Error("best effort"));
    const authenticator = new RealtimeSessionAuthenticator({ store: { lookup, touchLastSeen }, touchIntervalMs: 60_000 });
    await expect(authenticator.authenticate({ sessionToken: "session", workspaceId })).resolves.toMatchObject({ accountId: "account", sessionExpiresAt: session.sessionExpiresAt });
    expect(lookup).toHaveBeenCalledTimes(1);
    expect(touchLastSeen).toHaveBeenCalledTimes(1);
  });

  it("rejects expired, revoked, mismatched, switched-account, and workspace-token credentials", async () => {
    for (const patch of [
      { sessionActive: false }, { accountMembershipActive: false }, { workspaceOwned: false },
      { credentialType: "workspace_api_token" as const },
    ]) {
      const authenticator = new RealtimeSessionAuthenticator({ store: { lookup: async () => ({ ...session, ...patch }), touchLastSeen: async () => undefined } });
      await expect(authenticator.authenticate({ sessionToken: "session", workspaceId })).rejects.toThrow(/realtime session/i);
    }
    const authenticator = new RealtimeSessionAuthenticator({ store: { lookup: async () => ({ ...session, sessionExpiresAt: new Date(Date.now() - 1) }), touchLastSeen: async () => undefined } });
    await expect(authenticator.authenticate({ sessionToken: "session", workspaceId, headerWorkspaceId: "b4f5c8d3-d241-4f8f-a4db-3df5b88da44c" })).rejects.toThrow();
    const switched = new RealtimeSessionAuthenticator({ store: { lookup: async () => session, touchLastSeen: async () => undefined } });
    await expect(switched.authenticate({ sessionToken: "session", workspaceId, expectedAccountId: "different-account" })).rejects.toThrow(/realtime session/i);
  });

  it("uses bounded LRU last_seen tracking so new sessions keep receiving best-effort touches", async () => {
    let now = 0;
    const touchLastSeen = vi.fn().mockResolvedValue(undefined);
    const authenticator = new RealtimeSessionAuthenticator({
      store: { lookup: async ({ sessionToken }) => ({ ...session, sessionId: sessionToken }), touchLastSeen },
      maxTrackedTouches: 2,
      now: () => now,
    });
    for (const sessionToken of ["one", "two", "three"]) {
      await authenticator.authenticate({ sessionToken, workspaceId });
      now += 1;
    }
    expect(touchLastSeen).toHaveBeenCalledTimes(3);
    await authenticator.authenticate({ sessionToken: "one", workspaceId });
    expect(touchLastSeen).toHaveBeenCalledTimes(4);
  });

  it("uses its injected clock for exact expiry and zero-time throttling", async () => {
    let now = 0;
    const touchLastSeen = vi.fn().mockResolvedValue(undefined);
    const authenticator = new RealtimeSessionAuthenticator({ store: { lookup: async () => ({ ...session, sessionExpiresAt: new Date(0) }), touchLastSeen }, now: () => now });
    await expect(authenticator.authenticate({ sessionToken: "expired", workspaceId })).rejects.toThrow(/not authorized/i);
    const valid = new RealtimeSessionAuthenticator({ store: { lookup: async () => ({ ...session, sessionExpiresAt: new Date(1) }), touchLastSeen }, now: () => now });
    await valid.authenticate({ sessionToken: "live", workspaceId });
    await valid.authenticate({ sessionToken: "live", workspaceId });
    expect(touchLastSeen).toHaveBeenCalledTimes(1);
  });

  it("rejects non-positive bounded touch options", () => {
    expect(() => new RealtimeSessionAuthenticator({ store: { lookup: async () => null, touchLastSeen: async () => undefined }, touchIntervalMs: 0 })).toThrow(/positive/i);
    expect(() => new RealtimeSessionAuthenticator({ store: { lookup: async () => null, touchLastSeen: async () => undefined }, maxTrackedTouches: 0 })).toThrow(/positive/i);
  });
});
