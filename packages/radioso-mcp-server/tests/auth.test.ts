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
      converseSessionToken: "converse-session-token",
    });
    expect(converseApi.exchange).toHaveBeenCalledWith({
      client: { name: "radioso-mcp-server" },
      launchToken: "agent-channel-credential",
    });

    await auth.resolveBearerSession("agent-channel-credential");
    expect(converseApi.exchange).toHaveBeenCalledTimes(1);
    expect(converseApi.validate).toHaveBeenCalledTimes(2);
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
});
