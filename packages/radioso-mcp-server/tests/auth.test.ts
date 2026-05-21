import { describe, expect, it, vi } from "vitest";

import { createAuditLogger, createInMemoryAuditSink } from "../src/audit/auditLogger.js";
import { createAuthService } from "../src/auth/authService.js";
import { createInMemorySessionStore } from "../src/auth/sessionStore.js";
import { createCapabilityPolicyRegistry } from "../src/policy/capabilityPolicy.js";

const defaultWorkspaceValidation = {
  apiVersion: "0.1.0",
  mcpContextVersion: "2026-04-22",
  supportedTools: [
    "describe_capabilities",
    "search_documents",
    "list_documents",
    "create_document",
    "update_document",
  ],
  workspaceHint: "Default",
  workspaceId: "3f3caef3-050c-46a7-8fd7-2fa48f17fe98",
  workspaceName: "Default",
};

describe("auth foundations", () => {
  it("stores and resolves access sessions by opaque token without exposing the raw token", async () => {
    const store = createInMemorySessionStore();
    const now = new Date("2026-04-21T12:00:00.000Z");

    await store.save({
      accessToken: "mcp_sess_test",
      expiresAt: new Date("2026-04-21T12:10:00.000Z"),
      grantedTools: ["search_documents"],
      issuedAt: new Date("2026-04-21T12:00:00.000Z"),
      sessionId: "sess_01",
      upstreamApiToken: "radioso_test",
    });

    await expect(store.getByAccessToken("mcp_sess_test", now)).resolves.toMatchObject({
      grantedTools: ["search_documents"],
      sessionId: "sess_01",
      upstreamApiToken: "radioso_test",
    });
    await expect(store.getByAccessToken("wrong-token", now)).resolves.toBeNull();
  });

  it("exchanges a workspace token for a session and rejects disallowed requested tools", async () => {
    const policy = createCapabilityPolicyRegistry({
      allowedReadTools: ["describe_capabilities", "search_documents"],
      allowedWriteTools: ["create_document"],
      approvalRequiredWriteTools: ["create_document"],
    });
    const sessionStore = createInMemorySessionStore();
    const validateWorkspaceToken = vi.fn().mockResolvedValue({
      ...defaultWorkspaceValidation,
      workspaceHint: "workspace-123",
    });

    const auth = createAuthService({
      policy,
      sessionStore,
      signingSecret: "dev-signing-secret",
      validateWorkspaceToken,
      now: () => new Date("2026-04-21T12:00:00.000Z"),
    });

    const exchange = await auth.exchangeWorkspaceToken({
      clientName: "cursor-local",
      radiosoApiToken: "radioso_test",
      requestedTools: ["search_documents", "create_document"],
    });

    expect(exchange).toMatchObject({
      approvalRequiredTools: ["create_document"],
      grantedTools: ["search_documents", "create_document"],
      tokenType: "Bearer",
    });
    expect(validateWorkspaceToken).toHaveBeenCalledWith("radioso_test");
    await expect(
      sessionStore.getByAccessToken(exchange.accessToken, new Date("2026-04-21T12:05:00.000Z")),
    ).resolves.toMatchObject({
      grantedTools: ["search_documents", "create_document"],
      workspaceHint: "workspace-123",
    });

    await expect(
      auth.exchangeWorkspaceToken({
        radiosoApiToken: "radioso_test",
        requestedTools: ["delete_document"],
      }),
    ).rejects.toMatchObject({
      code: "capability_forbidden",
    });
  });

  it("keeps repeated exchanges isolated", async () => {
    const sessionStore = createInMemorySessionStore();
    const auth = createAuthService({
      policy: createCapabilityPolicyRegistry({
        allowedReadTools: ["search_documents"],
        allowedWriteTools: ["create_document"],
        approvalRequiredWriteTools: ["create_document"],
      }),
      sessionStore,
      signingSecret: "dev-signing-secret",
      validateWorkspaceToken: vi.fn().mockResolvedValue(defaultWorkspaceValidation),
      now: () => new Date("2026-04-21T12:00:00.000Z"),
    });

    const first = await auth.exchangeWorkspaceToken({
      radiosoApiToken: "radioso_test",
      requestedTools: ["search_documents", "create_document"],
    });
    const second = await auth.exchangeWorkspaceToken({
      radiosoApiToken: "radioso_test",
      requestedTools: ["search_documents", "create_document"],
    });

    expect(first.accessToken).not.toBe(second.accessToken);

    await expect(
      sessionStore.getByAccessToken(first.accessToken, new Date("2026-04-21T12:05:00.000Z")),
    ).resolves.toMatchObject({
      grantedTools: ["search_documents", "create_document"],
    });
    await expect(
      sessionStore.getByAccessToken(second.accessToken, new Date("2026-04-21T12:05:00.000Z")),
    ).resolves.toMatchObject({
      grantedTools: ["search_documents", "create_document"],
    });
  });

  it("emits audit events for denied exchange requests", async () => {
    const { events, sink } = createInMemoryAuditSink();
    const auth = createAuthService({
      auditLogger: createAuditLogger([sink]),
      policy: createCapabilityPolicyRegistry({
        allowedReadTools: ["describe_capabilities"],
        allowedWriteTools: ["create_document"],
        approvalRequiredWriteTools: ["create_document"],
      }),
      sessionStore: createInMemorySessionStore(),
      signingSecret: "dev-signing-secret",
      validateWorkspaceToken: vi.fn().mockResolvedValue(defaultWorkspaceValidation),
      now: () => new Date("2026-04-21T12:00:00.000Z"),
    });

    await expect(
      auth.exchangeWorkspaceToken({
        radiosoApiToken: "radioso_test",
        requestedTools: ["delete_document"],
      }),
    ).rejects.toMatchObject({
      code: "capability_forbidden",
    });

    expect(events).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          eventType: "auth.exchange_failed",
          metadata: expect.objectContaining({
            code: "capability_forbidden",
            requestedTools: ["delete_document"],
          }),
          outcome: "denied",
        }),
      ]),
    );
  });

  it("intersects workspace policy and upstream capability support before granting tools", async () => {
    const auth = createAuthService({
      policy: createCapabilityPolicyRegistry({
        allowedReadTools: ["describe_capabilities", "search_documents", "list_documents"],
        allowedWriteTools: ["create_document", "update_document"],
        approvalRequiredWriteTools: ["create_document", "update_document"],
      }),
      resolvePolicy: (workspaceId) => ({
        policy: createCapabilityPolicyRegistry({
          allowedReadTools: workspaceId
            ? ["describe_capabilities", "search_documents"]
            : ["describe_capabilities", "search_documents", "list_documents"],
          allowedWriteTools: ["create_document"],
          approvalRequiredWriteTools: ["create_document"],
        }),
        source: workspaceId ? "workspace" : "global",
        workspaceId,
      }),
      sessionStore: createInMemorySessionStore(),
      signingSecret: "dev-signing-secret",
      validateWorkspaceToken: vi.fn().mockResolvedValue({
        ...defaultWorkspaceValidation,
        supportedTools: ["describe_capabilities", "create_document"],
      }),
      now: () => new Date("2026-04-21T12:00:00.000Z"),
    });

    const exchange = await auth.exchangeWorkspaceToken({
      radiosoApiToken: "radioso_test",
      requestedTools: ["describe_capabilities", "search_documents", "create_document"],
    });

    expect(exchange).toMatchObject({
      approvalRequiredTools: ["create_document"],
      grantedTools: ["describe_capabilities", "create_document"],
      policySource: "workspace",
      unsupportedTools: ["search_documents"],
      workspaceId: "3f3caef3-050c-46a7-8fd7-2fa48f17fe98",
      workspaceName: "Default",
    });
  });
});
