import { describe, expect, it, vi } from "vitest";

import { createAuthService } from "../src/auth/authService.js";
import { createInMemorySessionStore } from "../src/auth/sessionStore.js";
import { mintWalkInHandle, verifyWalkInHandle, walkInStoreKey } from "../src/auth/walkInHandle.js";
import type { ConverseApiAdapter } from "../src/converseApiAdapter.js";

const SECRET = "0123456789abcdef0123456789abcdef";
const PUBLIC_ID = "ag_abcdefghijklmnopqrstuv";
const SOURCE = "D0GJ62ZQvM0QF23UXwB8Y6v6nTS26zrXbA_oYopE07g";
const OTHER_SOURCE = "Xq4L62ZQvM0QF23UXwB8Y6v6nTS26zrXbA_oYopE07g";

const createConverseApi = (): ConverseApiAdapter => ({
  ask: vi.fn(),
  messages: vi.fn(),
  tools: vi.fn().mockResolvedValue({ agent: { name: "Agent", description: null }, tools: [] }),
  exchange: vi.fn().mockImplementation(async () => ({
    agent: { id: "agent-1", name: "Agent" },
    conversationId: `conversation-${Math.random()}`,
    expiresAt: new Date(Date.now() + 600_000).toISOString(),
    sessionToken: `converse-session-${Math.random()}`,
  })),
  validate: vi.fn().mockResolvedValue({
    agentId: "agent-1",
    conversationId: "conversation-1",
    permissions: ["public_chat.turn.create"],
    valid: true,
    workspaceId: "workspace-1",
  }),
  recordUse: vi.fn().mockResolvedValue(undefined),
});

const createWalkInAuth = (overrides: { signingSecret?: string } = {}) => {
  const converseApi = createConverseApi();
  const sessionStore = createInMemorySessionStore();
  const auth = createAuthService({
    converseApi,
    sessionStore,
    warn: () => undefined,
    ...("signingSecret" in overrides ? { signingSecret: overrides.signingSecret } : { signingSecret: SECRET }),
  });
  return { auth, converseApi, sessionStore };
};

describe("walk-in continuity handles", () => {
  it("verifies only a handle it minted for this agent and this source", () => {
    const handle = mintWalkInHandle({ secret: SECRET, publicId: PUBLIC_ID, sourceDigest: SOURCE });

    expect(verifyWalkInHandle({ secret: SECRET, publicId: PUBLIC_ID, sourceDigest: SOURCE, handle })).toBe(
      handle.split(".")[0],
    );
    // A different agent, a different source, or a different secret all fail closed.
    expect(verifyWalkInHandle({ secret: SECRET, publicId: "ag_someoneelsesagentid1", sourceDigest: SOURCE, handle })).toBeNull();
    expect(verifyWalkInHandle({ secret: SECRET, publicId: PUBLIC_ID, sourceDigest: OTHER_SOURCE, handle })).toBeNull();
    expect(verifyWalkInHandle({ secret: "f".repeat(32), publicId: PUBLIC_ID, sourceDigest: SOURCE, handle })).toBeNull();
  });

  it("refuses a handle a client chose for itself", () => {
    for (const handle of ["default", "session-1", "aaaaaaaaaaaaaaaaaaaaaaaa.bbbbbbbbbbbbbbbbbbbbbbbb", ""]) {
      expect(verifyWalkInHandle({ secret: SECRET, publicId: PUBLIC_ID, sourceDigest: SOURCE, handle })).toBeNull();
    }
  });

  it("mints a fresh handle rather than adopting a forged one", async () => {
    const { auth, converseApi } = createWalkInAuth();

    const forged = await auth.resolveWalkInSession({
      publicId: PUBLIC_ID,
      walkInKey: "default",
      sourceDigest: SOURCE,
    });

    expect(forged?.walkInKey).not.toBe("default");
    expect(verifyWalkInHandle({ secret: SECRET, publicId: PUBLIC_ID, sourceDigest: SOURCE, handle: forged!.walkInKey })).toEqual(expect.any(String));
    expect(converseApi.exchange).toHaveBeenCalledTimes(1);
  });

  it("keeps one conversation for a caller that echoes its handle from the same source", async () => {
    const { auth, converseApi } = createWalkInAuth();

    const first = await auth.resolveWalkInSession({ publicId: PUBLIC_ID, walkInKey: null, sourceDigest: SOURCE });
    const second = await auth.resolveWalkInSession({
      publicId: PUBLIC_ID,
      walkInKey: first!.walkInKey,
      sourceDigest: SOURCE,
    });

    expect(second?.walkInKey).toBe(first?.walkInKey);
    expect(second?.session.sessionId).toBe(first?.session.sessionId);
    expect(converseApi.exchange).toHaveBeenCalledTimes(1);
  });

  it("opens a new conversation when a handle is replayed from another source", async () => {
    const { auth, converseApi } = createWalkInAuth();
    const first = await auth.resolveWalkInSession({ publicId: PUBLIC_ID, walkInKey: null, sourceDigest: SOURCE });

    const replayed = await auth.resolveWalkInSession({
      publicId: PUBLIC_ID,
      walkInKey: first!.walkInKey,
      sourceDigest: OTHER_SOURCE,
    });

    expect(replayed?.session.sessionId).not.toBe(first?.session.sessionId);
    expect(replayed?.walkInKey).not.toBe(first?.walkInKey);
    expect(converseApi.exchange).toHaveBeenCalledTimes(2);
  });

  it("refuses a walk-in store key presented as a bearer credential", async () => {
    const { auth, converseApi, sessionStore } = createWalkInAuth();
    const opened = await auth.resolveWalkInSession({ publicId: PUBLIC_ID, walkInKey: null, sourceDigest: SOURCE });
    const storeKey = walkInStoreKey({
      publicId: PUBLIC_ID,
      sourceDigest: SOURCE,
      id: opened!.walkInKey.split(".")[0] ?? "",
    });
    // The key really does name the session; the bearer door is what refuses it.
    expect(await sessionStore.getByAccessToken(storeKey)).not.toBeNull();
    (converseApi.exchange as ReturnType<typeof vi.fn>).mockClear();

    const throughBearer = await auth.resolveBearerSession(storeKey, SOURCE);

    expect(throughBearer).toBeNull();
    // It must not fall through to the credential exchange either.
    expect(converseApi.exchange).not.toHaveBeenCalled();
  });

  it("gives every call a fresh conversation when no signing secret is configured", async () => {
    const { auth, converseApi } = createWalkInAuth({ signingSecret: undefined });

    const first = await auth.resolveWalkInSession({ publicId: PUBLIC_ID, walkInKey: null, sourceDigest: SOURCE });
    const second = await auth.resolveWalkInSession({
      publicId: PUBLIC_ID,
      walkInKey: first!.walkInKey,
      sourceDigest: SOURCE,
    });

    expect(second?.session.sessionId).not.toBe(first?.session.sessionId);
    expect(converseApi.exchange).toHaveBeenCalledTimes(2);
  });
});
