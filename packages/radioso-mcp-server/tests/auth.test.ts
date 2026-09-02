import { describe, expect, it, vi } from "vitest";

import { createAuthService } from "../src/auth/authService.js";
import { createInMemorySessionStore } from "../src/auth/sessionStore.js";
import { RadiosoApiError, type ConverseApiAdapter } from "../src/converseApiAdapter.js";

const createConverseApi = (): ConverseApiAdapter => ({
  ask: vi.fn(),
  exchange: vi.fn().mockResolvedValue({
    agent: { id: "agent-1", name: "Agent" },
    conversationId: "conversation-1",
    expiresAt: "2026-04-21T12:10:00.000Z",
    sessionToken: "converse-session-token",
  }),
  validate: vi.fn().mockResolvedValue({
    agentId: "agent-1",
    conversationId: "conversation-1",
    permissions: ["public_chat.turn.create"],
    valid: true,
    workspaceId: "workspace-1",
  }),
  recordUse: vi.fn().mockResolvedValue(undefined),
});

describe("agent-channel MCP authentication", () => {
  it("exchanges an agent credential into a cached ask_agent session", async () => {
    const converseApi = createConverseApi();
    const auth = createAuthService({
      converseApi,
      now: () => new Date("2026-04-21T12:00:00.000Z"),
      sessionStore: createInMemorySessionStore(),
    });

    await expect(auth.resolveBearerSession("agent-channel-credential")).resolves.toMatchObject({
      clientName: "radioso-mcp-converse",
      conversationId: "conversation-1",
      converseSessionToken: "converse-session-token",
    });
    expect(converseApi.exchange).toHaveBeenCalledWith({
      client: { name: "radioso-mcp-server" },
      launchToken: "agent-channel-credential",
    }, { sourceDigest: undefined });

    await auth.resolveBearerSession("agent-channel-credential");
    expect(converseApi.exchange).toHaveBeenCalledTimes(1);
    expect(converseApi.validate).toHaveBeenCalledTimes(2);
  });

  it("coalesces concurrent cache misses for one agent credential into one backend exchange", async () => {
    const converseApi = createConverseApi();
    let releaseExchange!: () => void;
    vi.mocked(converseApi.exchange).mockImplementationOnce(async () => {
      await new Promise<void>((resolve) => {
        releaseExchange = resolve;
      });
      return {
        agent: { id: "agent-1", name: "Agent" },
        conversationId: "conversation-1",
        expiresAt: "2026-04-21T12:10:00.000Z",
        sessionToken: "converse-session-token",
      };
    });
    const auth = createAuthService({
      converseApi,
      now: () => new Date("2026-04-21T12:00:00.000Z"),
      sessionStore: createInMemorySessionStore(),
    });

    const first = auth.resolveBearerSession("agent-channel-credential");
    const second = auth.resolveBearerSession("agent-channel-credential");
    await vi.waitFor(() => expect(converseApi.exchange).toHaveBeenCalledTimes(1));

    releaseExchange();
    const [firstSession, secondSession] = await Promise.all([first, second]);

    expect(firstSession).not.toBeNull();
    expect(secondSession).toEqual(firstSession);
    expect(converseApi.exchange).toHaveBeenCalledTimes(1);
  });

  it("removes a cached session when backend validation rejects it", async () => {
    const converseApi = createConverseApi();
    const store = createInMemorySessionStore();
    const auth = createAuthService({
      converseApi,
      now: () => new Date("2026-04-21T12:00:00.000Z"),
      sessionStore: store,
    });

    await auth.resolveBearerSession("agent-channel-credential");
    vi.mocked(converseApi.validate).mockRejectedValueOnce(new RadiosoApiError("Forbidden", 403, "forbidden"));

    await expect(auth.getSession("agent-channel-credential")).resolves.toBeNull();
    await expect(store.getByAccessToken("agent-channel-credential")).resolves.toBeNull();
  });

  it("rejects an unknown credential without creating a local session", async () => {
    const converseApi = createConverseApi();
    vi.mocked(converseApi.exchange).mockRejectedValueOnce(new RadiosoApiError("Forbidden", 403, "forbidden"));
    const auth = createAuthService({
      converseApi,
      sessionStore: createInMemorySessionStore(),
    });

    await expect(auth.resolveBearerSession("invalid-credential")).resolves.toBeNull();
  });

  it("refreshes successful cached use within five minutes without notifying on every response", async () => {
    const converseApi = createConverseApi();
    let now = new Date("2026-04-21T12:00:00.000Z");
    const auth = createAuthService({
      converseApi,
      now: () => now,
      sessionStore: createInMemorySessionStore(),
    });
    const session = await auth.resolveBearerSession("agent-channel-credential");
    if (!session) throw new Error("Expected a session");

    auth.recordSuccessfulUse(session, "source-digest");
    await vi.waitFor(() => expect(converseApi.recordUse).toHaveBeenCalledTimes(1));
    now = new Date("2026-04-21T12:04:59.999Z");
    auth.recordSuccessfulUse(session, "source-digest");
    await new Promise((resolve) => setImmediate(resolve));
    expect(converseApi.recordUse).toHaveBeenCalledTimes(1);

    now = new Date("2026-04-21T12:05:00.000Z");
    auth.recordSuccessfulUse(session, "source-digest");
    await vi.waitFor(() => expect(converseApi.recordUse).toHaveBeenCalledTimes(2));
    expect(converseApi.recordUse).toHaveBeenLastCalledWith("converse-session-token", { sourceDigest: "source-digest" });
  });

  it("keeps sync and async successful-use notification failures nonblocking and retryable", async () => {
    const converseApi = createConverseApi();
    vi.mocked(converseApi.recordUse)
      .mockRejectedValueOnce(new Error("async notification failure"))
      .mockImplementationOnce(() => {
        throw new Error("sync notification failure");
      })
      .mockResolvedValueOnce(undefined);
    const auth = createAuthService({
      converseApi,
      now: () => new Date("2026-04-21T12:00:00.000Z"),
      sessionStore: createInMemorySessionStore(),
    });
    const session = await auth.resolveBearerSession("agent-channel-credential");
    if (!session) throw new Error("Expected a session");

    expect(() => auth.recordSuccessfulUse(session)).not.toThrow();
    await new Promise((resolve) => setImmediate(resolve));
    expect(() => auth.recordSuccessfulUse(session)).not.toThrow();
    expect(() => auth.recordSuccessfulUse(session)).not.toThrow();
    await vi.waitFor(() => expect(converseApi.recordUse).toHaveBeenCalledTimes(3));
  });
});
