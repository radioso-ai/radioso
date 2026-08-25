import { describe, expect, it, vi } from "vitest";
import { RealtimeSessionAuthenticator } from "../../../src/modules/realtime/http/realtimeSessionAuthenticator.js";
import type { RealtimeSessionAuthError, RealtimeSessionAuthPort } from "../../../src/modules/realtime/http/realtimeSessionAuthenticator.js";

const workspaceId = "4d7293c8-d241-4f8f-a4db-3df5b88da44c";
const session = { sessionId: "session", accountId: "account", userId: "user", workspaceId, sessionExpiresAt: new Date(Date.now() + 60_000), sessionActive: true, accountMembershipActive: true, workspaceOwned: true, credentialType: "dashboard_session" as const };

const canonicalAuthPort = (authenticator: RealtimeSessionAuthPort): RealtimeSessionAuthPort => authenticator;

const expectTypedAuthError = (statusCode: RealtimeSessionAuthError["statusCode"]) =>
  expect.objectContaining({ statusCode, reason: expect.any(String) });

describe("realtime session authenticator", () => {
  it("performs one bounded lookup, returns session expiry, and touches last_seen best-effort", async () => {
    const lookup = vi.fn().mockResolvedValue(session);
    const touchLastSeen = vi.fn().mockRejectedValue(new Error("best effort"));
    const authenticator = new RealtimeSessionAuthenticator({ store: { lookup, touchLastSeen }, touchIntervalMs: 60_000 });
    await expect(authenticator.authenticate({ sessionToken: "session", requestedWorkspaceId: workspaceId, signal: new AbortController().signal })).resolves.toMatchObject({ accountId: "account", sessionExpiresAt: session.sessionExpiresAt });
    expect(lookup).toHaveBeenCalledTimes(1);
    expect(touchLastSeen).toHaveBeenCalledTimes(1);
  });

  it("rejects inactive, expired, workspace-mismatched, and workspace-token credentials", async () => {
    for (const patch of [
      { sessionActive: false }, { accountMembershipActive: false }, { workspaceOwned: false },
      { credentialType: "workspace_api_token" as const },
    ]) {
      const authenticator = new RealtimeSessionAuthenticator({ store: { lookup: async () => ({ ...session, ...patch }), touchLastSeen: async () => undefined } });
      await expect(authenticator.authenticate({ sessionToken: "session", requestedWorkspaceId: workspaceId, signal: new AbortController().signal })).rejects.toThrow(/realtime session/i);
    }
    const authenticator = new RealtimeSessionAuthenticator({ store: { lookup: async () => ({ ...session, sessionExpiresAt: new Date(Date.now() - 1) }), touchLastSeen: async () => undefined } });
    await expect(authenticator.authenticate({ sessionToken: "session", requestedWorkspaceId: "b4f5c8d3-d241-4f8f-a4db-3df5b88da44c", signal: new AbortController().signal })).rejects.toThrow();
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
      await authenticator.authenticate({ sessionToken, requestedWorkspaceId: workspaceId, signal: new AbortController().signal });
      now += 1;
    }
    expect(touchLastSeen).toHaveBeenCalledTimes(3);
    await authenticator.authenticate({ sessionToken: "one", requestedWorkspaceId: workspaceId, signal: new AbortController().signal });
    expect(touchLastSeen).toHaveBeenCalledTimes(4);
  });

  it("uses its injected clock for exact expiry and zero-time throttling", async () => {
    let now = 0;
    const touchLastSeen = vi.fn().mockResolvedValue(undefined);
    const authenticator = new RealtimeSessionAuthenticator({ store: { lookup: async () => ({ ...session, sessionExpiresAt: new Date(0) }), touchLastSeen }, now: () => now });
    await expect(authenticator.authenticate({ sessionToken: "expired", requestedWorkspaceId: workspaceId, signal: new AbortController().signal })).rejects.toThrow(/not authorized/i);
    const valid = new RealtimeSessionAuthenticator({ store: { lookup: async () => ({ ...session, sessionExpiresAt: new Date(1) }), touchLastSeen }, now: () => now });
    await valid.authenticate({ sessionToken: "live", requestedWorkspaceId: workspaceId, signal: new AbortController().signal });
    await valid.authenticate({ sessionToken: "live", requestedWorkspaceId: workspaceId, signal: new AbortController().signal });
    expect(touchLastSeen).toHaveBeenCalledTimes(1);
  });

  it("exposes the narrow route identity and maps userId to principalId", async () => {
    const lookup = vi.fn().mockResolvedValue(session);
    const touchLastSeen = vi.fn().mockResolvedValue(undefined);
    const authenticator = canonicalAuthPort(new RealtimeSessionAuthenticator({ store: { lookup, touchLastSeen } }));
    const signal = new AbortController().signal;
    await expect(authenticator.authenticate({ sessionToken: "session", requestedWorkspaceId: workspaceId, signal })).resolves.toMatchObject({
      accountId: "account",
      workspaceId,
      principalId: "user",
      sessionExpiresAt: session.sessionExpiresAt,
    });
    expect(lookup).toHaveBeenCalledWith({ sessionToken: "session", workspaceId });
  });

  it.each([
    [{ sessionActive: false }, 401],
    [{ sessionExpiresAt: new Date(Date.now() - 1) }, 401],
    [{ accountMembershipActive: false }, 403],
    [{ workspaceOwned: false }, 403],
    [{ workspaceId: "b4f5c8d3-d241-4d9d-a4db-8f8f4a4db44c" }, 403],
  ] as const)("returns typed auth status %s without touching last_seen for authorization failures", async (patch, statusCode) => {
    const touchLastSeen = vi.fn().mockResolvedValue(undefined);
    const lookup = vi.fn().mockResolvedValue({ ...session, ...patch });
    const authenticator = canonicalAuthPort(new RealtimeSessionAuthenticator({ store: { lookup, touchLastSeen } }));
    await expect(authenticator.authenticate({ sessionToken: "session", requestedWorkspaceId: workspaceId, signal: new AbortController().signal })).rejects.toMatchObject(expectTypedAuthError(statusCode));
    expect(touchLastSeen).not.toHaveBeenCalled();
  });

  it.each([
    ["missing", null],
    ["revoked", null],
    ["expired", { ...session, sessionExpiresAt: new Date(Date.now() - 1) }],
    ["workspace token", { ...session, credentialType: "workspace_api_token" as const }],
  ] as const)("maps %s credential absence to typed 401 without last_seen", async (_label, record) => {
    const touchLastSeen = vi.fn().mockResolvedValue(undefined);
    const lookup = vi.fn().mockResolvedValue(record);
    const authenticator = canonicalAuthPort(new RealtimeSessionAuthenticator({ store: { lookup, touchLastSeen } }));
    await expect(authenticator.authenticate({ sessionToken: "session", requestedWorkspaceId: workspaceId, signal: new AbortController().signal })).rejects.toMatchObject(expectTypedAuthError(401));
    expect(touchLastSeen).not.toHaveBeenCalled();
  });

  it("stops before lookup and last_seen when the route signal is already aborted", async () => {
    const controller = new AbortController();
    controller.abort();
    const lookup = vi.fn().mockResolvedValue(session);
    const touchLastSeen = vi.fn().mockResolvedValue(undefined);
    const authenticator = canonicalAuthPort(new RealtimeSessionAuthenticator({ store: { lookup, touchLastSeen } }));
    await expect(authenticator.authenticate({ sessionToken: "session", requestedWorkspaceId: workspaceId, signal: controller.signal })).rejects.toMatchObject(expect.objectContaining({ name: "AbortError", reason: expect.any(String) }));
    expect(lookup).not.toHaveBeenCalled();
    expect(touchLastSeen).not.toHaveBeenCalled();
  });

  it("aborts a deferred lookup and ignores a late valid row without touching last_seen", async () => {
    const controller = new AbortController();
    const pending = new Promise<typeof session>((resolve) => setImmediate(() => resolve(session)));
    const lookup = vi.fn().mockReturnValue(pending);
    const touchLastSeen = vi.fn().mockResolvedValue(undefined);
    const authenticator = canonicalAuthPort(new RealtimeSessionAuthenticator({ store: { lookup, touchLastSeen } }));
    const result = authenticator.authenticate({ sessionToken: "session", requestedWorkspaceId: workspaceId, signal: controller.signal });
    controller.abort();
    await expect(result).rejects.toMatchObject(expect.objectContaining({ name: "AbortError" }));
    expect(touchLastSeen).not.toHaveBeenCalled();
  });

  it("rejects non-positive bounded touch options", () => {
    expect(() => new RealtimeSessionAuthenticator({ store: { lookup: async () => null, touchLastSeen: async () => undefined }, touchIntervalMs: 0 })).toThrow(/positive/i);
    expect(() => new RealtimeSessionAuthenticator({ store: { lookup: async () => null, touchLastSeen: async () => undefined }, maxTrackedTouches: 0 })).toThrow(/positive/i);
  });
});
