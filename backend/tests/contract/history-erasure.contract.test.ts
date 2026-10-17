import { randomUUID } from "node:crypto";

import request from "supertest";
import { describe, expect, it, vi } from "vitest";

import { apiPrincipalRoutePolicy } from "../../src/app/http/apiPrincipalRoutePolicy.js";
import type { ConversationErasure } from "../../src/modules/privacy/public.js";
import { forbidden, notFound } from "../../src/shared/domain/errors.js";
import { adminSessionHeaders, createTestApp, issueTestSession, issueTestToken } from "../support/testApp.js";

const receipt = { conversationCount: 1, messageCount: 4, rowsByOwner: {} };

const harness = async () => {
  const erasure = {
    eraseConversation: vi.fn<ConversationErasure["eraseConversation"]>(async () => receipt),
    eraseVisitor: vi.fn<ConversationErasure["eraseVisitor"]>(async () => receipt),
  };
  const { app, dependencies } = createTestApp({ conversationErasure: erasure });
  const session = await issueTestSession(app, `history-erasure-${randomUUID()}@example.com`);
  return { app, dependencies, erasure, session, headers: adminSessionHeaders(session) };
};

/** Denies the one permission, as a role without it would. */
const denyPermission = (h: Awaited<ReturnType<typeof harness>>, denied: string) =>
  vi.spyOn(h.dependencies.accountAccessService, "requirePermission").mockImplementation(async ({ permission }) => {
    if (permission === denied) throw forbidden("You do not have permission to perform this action");
    return null;
  });

describe("history erasure contract", () => {
  it("erases a conversation for a signed-in teammate and answers 204 with no body", async () => {
    const h = await harness();
    const conversationId = randomUUID();

    const response = await request(h.app).delete(`/api/v1/history/chat/${conversationId}`).set(h.headers);

    expect(response.status).toBe(204);
    expect(response.text).toBe("");
    expect(h.erasure.eraseConversation).toHaveBeenCalledWith({
      workspaceId: h.session.workspaceId,
      conversationId,
      actor: { accountId: h.session.accountId, userId: h.session.userId },
    });
  });

  it("erases a visitor and their conversations", async () => {
    const h = await harness();
    const visitorId = randomUUID();

    const response = await request(h.app).delete(`/api/v1/history/visitors/${visitorId}`).set(h.headers);

    expect(response.status).toBe(204);
    expect(h.erasure.eraseVisitor).toHaveBeenCalledWith({
      workspaceId: h.session.workspaceId,
      visitorId,
      actor: { accountId: h.session.accountId, userId: h.session.userId },
    });
  });

  it("answers 404 for a conversation or visitor the workspace does not have", async () => {
    const h = await harness();
    h.erasure.eraseConversation.mockRejectedValueOnce(notFound("Conversation not found"));
    h.erasure.eraseVisitor.mockRejectedValueOnce(notFound("Visitor not found"));

    await request(h.app).delete(`/api/v1/history/chat/${randomUUID()}`).set(h.headers).expect(404);
    await request(h.app).delete(`/api/v1/history/visitors/${randomUUID()}`).set(h.headers).expect(404);
  });

  it("refuses an id that is not a uuid before erasing anything", async () => {
    const h = await harness();

    await request(h.app).delete("/api/v1/history/chat/not-a-uuid").set(h.headers).expect(400);
    await request(h.app).delete("/api/v1/history/visitors/not-a-uuid").set(h.headers).expect(400);
    expect(h.erasure.eraseConversation).not.toHaveBeenCalled();
    expect(h.erasure.eraseVisitor).not.toHaveBeenCalled();
  });

  it("refuses a teammate without workspace.history.delete, even one who can read history", async () => {
    const h = await harness();
    denyPermission(h, "workspace.history.delete");

    await request(h.app).delete(`/api/v1/history/chat/${randomUUID()}`).set(h.headers).expect(403);
    await request(h.app).delete(`/api/v1/history/visitors/${randomUUID()}`).set(h.headers).expect(403);
    await request(h.app).get("/api/v1/history/chat").set(h.headers).expect(200);
    expect(h.erasure.eraseConversation).not.toHaveBeenCalled();
    expect(h.erasure.eraseVisitor).not.toHaveBeenCalled();
  });

  it("accepts a workspace credential, so a data-subject request can be automated", async () => {
    const h = await harness();
    const { token, workspaceId } = await issueTestToken(h.app);
    const conversationId = randomUUID();

    await request(h.app).delete(`/api/v1/history/chat/${conversationId}`).set("Authorization", `Bearer ${token}`).expect(204);

    expect(h.erasure.eraseConversation).toHaveBeenCalledWith(expect.objectContaining({ workspaceId, conversationId }));
    for (const route of ["DELETE /api/v1/history/chat/:conversationId", "DELETE /api/v1/history/visitors/:visitorId"]) {
      expect(apiPrincipalRoutePolicy[route]).toEqual({
        permission: "workspace.history.delete",
        allowedPrincipalKinds: ["session_user", "personal_api_credential", "service_account_credential"],
        sessionOnly: false,
      });
    }
  });
});
