import { describe, expect, it, vi } from "vitest";

import { createAuditLogger, createInMemoryAuditSink } from "../src/audit/auditLogger.js";
import { createInMemoryApprovalStore } from "../src/auth/approvalStore.js";
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

  it("issues and consumes approval grants with expiry and remaining-use checks", async () => {
    const store = createInMemoryApprovalStore();
    const now = new Date("2026-04-21T12:00:00.000Z");

    await store.save({
      approvalToken: "mcp_appr_test",
      expiresAt: new Date("2026-04-21T12:10:00.000Z"),
      issuedAt: new Date("2026-04-21T12:00:00.000Z"),
      reason: "create onboarding doc",
      remainingUses: 1,
      allowedTools: ["create_document"],
      approvalId: "appr_01",
      sessionId: "sess_01",
    });

    await expect(store.consumeByToken("mcp_appr_test", now)).resolves.toMatchObject({
      approvalId: "appr_01",
      remainingUses: 0,
    });
    await expect(store.consumeByToken("mcp_appr_test", now)).resolves.toBeNull();
  });

  it("does not burn an approval grant on wrong-session or wrong-tool checks", async () => {
    const policy = createCapabilityPolicyRegistry({
      allowedReadTools: ["describe_capabilities"],
      allowedWriteTools: ["create_document", "update_document"],
      approvalRequiredWriteTools: ["create_document", "update_document"],
    });
    const sessionStore = createInMemorySessionStore();
    const approvalStore = createInMemoryApprovalStore();
    const auth = createAuthService({
      approvalStore,
      policy,
      sessionStore,
      signingSecret: "dev-signing-secret",
      validateWorkspaceToken: vi.fn().mockResolvedValue(defaultWorkspaceValidation),
      now: () => new Date("2026-04-21T12:00:00.000Z"),
    });

    const sessionA = await auth.exchangeWorkspaceToken({
      radiosoApiToken: "radioso_a",
      requestedTools: ["create_document"],
    });
    const sessionB = await auth.exchangeWorkspaceToken({
      radiosoApiToken: "radioso_b",
      requestedTools: ["create_document"],
    });
    const approval = await auth.issueApproval({
      accessToken: sessionA.accessToken,
      reason: "Create a document",
      tools: ["create_document"],
    });

    await expect(
      auth.verifyApproval(sessionB.accessToken, approval.approvalToken, "create_document"),
    ).rejects.toMatchObject({
      code: "approval_forbidden",
    });
    await expect(
      auth.verifyApproval(sessionA.accessToken, approval.approvalToken, "update_document"),
    ).rejects.toMatchObject({
      code: "approval_forbidden",
    });
    await expect(
      auth.verifyApproval(sessionA.accessToken, approval.approvalToken, "create_document"),
    ).resolves.toMatchObject({
      approvalId: approval.approvalId,
    });
  });

  it("consumes multi-tool approvals one tool at a time", async () => {
    const policy = createCapabilityPolicyRegistry({
      allowedReadTools: ["describe_capabilities"],
      allowedWriteTools: ["create_document", "update_document"],
      approvalRequiredWriteTools: ["create_document", "update_document"],
    });
    const sessionStore = createInMemorySessionStore();
    const approvalStore = createInMemoryApprovalStore();
    const auth = createAuthService({
      approvalStore,
      policy,
      sessionStore,
      signingSecret: "dev-signing-secret",
      validateWorkspaceToken: vi.fn().mockResolvedValue(defaultWorkspaceValidation),
      now: () => new Date("2026-04-21T12:00:00.000Z"),
    });

    const session = await auth.exchangeWorkspaceToken({
      radiosoApiToken: "radioso_multi",
      requestedTools: ["create_document", "update_document"],
    });
    const approval = await auth.issueApproval({
      accessToken: session.accessToken,
      reason: "Create and update a document",
      tools: ["create_document", "update_document"],
    });

    await expect(
      auth.verifyApproval(session.accessToken, approval.approvalToken, "create_document"),
    ).resolves.toMatchObject({
      allowedTools: ["update_document"],
      remainingUses: 1,
    });
    await expect(
      auth.verifyApproval(session.accessToken, approval.approvalToken, "create_document"),
    ).rejects.toMatchObject({
      code: "approval_forbidden",
    });
    await expect(
      auth.verifyApproval(session.accessToken, approval.approvalToken, "update_document"),
    ).resolves.toMatchObject({
      allowedTools: [],
      remainingUses: 0,
    });
    await expect(
      auth.verifyApproval(session.accessToken, approval.approvalToken, "update_document"),
    ).rejects.toMatchObject({
      code: "approval_required",
    });
  });

  it("exchanges a workspace token for a session and rejects disallowed requested tools", async () => {
    const policy = createCapabilityPolicyRegistry({
      allowedReadTools: ["describe_capabilities", "search_documents"],
      allowedWriteTools: ["create_document"],
      approvalRequiredWriteTools: ["create_document"],
    });
    const sessionStore = createInMemorySessionStore();
    const approvalStore = createInMemoryApprovalStore();
    const validateWorkspaceToken = vi.fn().mockResolvedValue({
      ...defaultWorkspaceValidation,
      workspaceHint: "workspace-123",
    });

    const auth = createAuthService({
      approvalStore,
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

  it("keeps repeated exchanges isolated while approvals can span the same workspace token", async () => {
    const sessionStore = createInMemorySessionStore();
    const auth = createAuthService({
      approvalStore: createInMemoryApprovalStore(),
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
    const approval = await auth.issueApproval({
      accessToken: first.accessToken,
      reason: "cross-entry approval",
      tools: ["create_document"],
    });

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
    await expect(auth.verifyApproval(second.accessToken, approval.approvalToken, "create_document")).resolves.toMatchObject({
      approvalId: approval.approvalId,
    });
  });

  it("emits audit events for denied exchange and approval requests", async () => {
    const { events, sink } = createInMemoryAuditSink();
    const auth = createAuthService({
      approvalStore: createInMemoryApprovalStore(),
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

    await expect(
      auth.issueApproval({
        accessToken: "missing-token",
        reason: "Create a document",
        tools: ["create_document"],
      }),
    ).rejects.toMatchObject({
      code: "invalid_access_token",
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
        expect.objectContaining({
          eventType: "approval.denied",
          metadata: expect.objectContaining({
            code: "invalid_access_token",
            tools: ["create_document"],
          }),
          outcome: "denied",
        }),
      ]),
    );
  });

  it("intersects workspace policy and upstream capability support before granting tools", async () => {
    const auth = createAuthService({
      approvalStore: createInMemoryApprovalStore(),
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

  it("allows approval-free write tools when policy removes them from the approval set", async () => {
    const auth = createAuthService({
      approvalStore: createInMemoryApprovalStore(),
      policy: createCapabilityPolicyRegistry({
        allowedReadTools: ["describe_capabilities"],
        allowedWriteTools: ["create_document"],
        approvalRequiredWriteTools: [],
      }),
      sessionStore: createInMemorySessionStore(),
      signingSecret: "dev-signing-secret",
      validateWorkspaceToken: vi.fn().mockResolvedValue(defaultWorkspaceValidation),
      now: () => new Date("2026-04-21T12:00:00.000Z"),
    });

    const exchange = await auth.exchangeWorkspaceToken({
      radiosoApiToken: "radioso_test",
      requestedTools: ["create_document"],
    });

    expect(exchange).toMatchObject({
      approvalRequiredTools: [],
      grantedTools: ["create_document"],
    });
  });
});
