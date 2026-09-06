import { describe, expect, it, vi } from "vitest";

import type { AccessGrant } from "../../src/modules/accessGrants/domain.js";
import { AgentConverseSessionService } from "../../src/modules/settings/services/agentConverseSessionService.js";

const grant: AccessGrant = {
  id: "11111111-1111-4111-8111-111111111111",
  workspaceId: "22222222-2222-4222-8222-222222222222",
  agentId: "33333333-3333-4333-8333-333333333333",
  label: "MCP",
  principalKind: "agent-api",
  role: "agent",
  channel: "mcp-converse",
  tokenPrefix: "radioso_mcp",
  tokenHash: "hash",
  encryptedToken: null,
  originConstraint: { mode: "allow-all", origins: [] },
  enabled: true,
  expiresAt: new Date(Date.now() + 60_000),
  createdAt: new Date(),
  lastUsedAt: null,
  revokedAt: null,
};

describe("AgentConverseSessionService last-use boundary", () => {
  it("does not record exchange or validation and records only explicit successful use", async () => {
    const touchGrant = vi.fn().mockResolvedValue(undefined);
    const service = new AgentConverseSessionService({
      accessGrantService: {
        resolvePublicLaunchGrant: vi.fn().mockResolvedValue(null),
        resolveConverseGrant: vi.fn().mockResolvedValue(grant),
        findGrantById: vi.fn().mockResolvedValue(grant),
        evaluate: vi.fn().mockReturnValue({ allowed: true }),
        touchGrant,
        recordAuthFailure: vi.fn(),
      },
      agentLookup: { findByIdAndWorkspaceId: vi.fn().mockResolvedValue({ id: grant.agentId, name: "Agent" }) },
      sessionMapping: { resolvePublicSessionId: vi.fn().mockResolvedValue("44444444-4444-4444-8444-444444444444") },
      publicChatSessionSecret: "0123456789abcdef0123456789abcdef",
    });

    const exchanged = await service.exchange({ launchToken: "secret" });
    await service.validate(exchanged.sessionToken);

    expect(touchGrant).not.toHaveBeenCalled();
    service.recordSuccessfulUse(await service.validate(exchanged.sessionToken));

    expect(touchGrant).toHaveBeenCalledTimes(1);
    expect(touchGrant).toHaveBeenLastCalledWith(grant.id);
  });

  it("does not record use when the successful-exchange audit fails", async () => {
    const touchGrant = vi.fn().mockResolvedValue(undefined);
    const service = new AgentConverseSessionService({
      accessGrantService: {
        resolvePublicLaunchGrant: vi.fn().mockResolvedValue(null),
        resolveConverseGrant: vi.fn().mockResolvedValue(grant),
        findGrantById: vi.fn(),
        evaluate: vi.fn().mockReturnValue({ allowed: true }),
        touchGrant,
        recordAuthFailure: vi.fn(),
      },
      agentLookup: { findByIdAndWorkspaceId: vi.fn().mockResolvedValue({ id: grant.agentId, name: "Agent" }) },
      sessionMapping: { resolvePublicSessionId: vi.fn().mockResolvedValue("44444444-4444-4444-8444-444444444444") },
      publicChatSessionSecret: "0123456789abcdef0123456789abcdef",
      audit: {
        recordExchangeDenied: vi.fn(),
        recordExchangeSucceeded: vi.fn().mockRejectedValue(new Error("audit unavailable")),
        recordValidationDenied: vi.fn(),
      },
    });

    await expect(service.exchange({ launchToken: "secret" })).rejects.toThrow("audit unavailable");
    expect(touchGrant).not.toHaveBeenCalled();
  });

  it("keeps successful-use persistence failures nonblocking", async () => {
    const asynchronousFailure = new Error("async persistence failed");
    const accessGrantService = {
      resolvePublicLaunchGrant: vi.fn(),
      resolveConverseGrant: vi.fn(),
      findGrantById: vi.fn(),
      evaluate: vi.fn(),
      touchGrant: vi.fn().mockRejectedValue(asynchronousFailure),
      recordAuthFailure: vi.fn(),
    };
    const service = new AgentConverseSessionService({
      accessGrantService,
      agentLookup: { findByIdAndWorkspaceId: vi.fn() },
      sessionMapping: { resolvePublicSessionId: vi.fn() },
      publicChatSessionSecret: "0123456789abcdef0123456789abcdef",
    });

    expect(() => service.recordSuccessfulUse({ grantId: grant.id })).not.toThrow();
    await new Promise((resolve) => setImmediate(resolve));

    accessGrantService.touchGrant.mockImplementationOnce(() => {
      throw new Error("sync persistence failed");
    });
    expect(() => service.recordSuccessfulUse({ grantId: grant.id })).not.toThrow();
  });
});
