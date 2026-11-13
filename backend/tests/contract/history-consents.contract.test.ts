import { randomUUID } from "node:crypto";

import request from "supertest";
import { describe, expect, it, vi } from "vitest";

import { apiPrincipalRoutePolicy } from "../../src/app/http/apiPrincipalRoutePolicy.js";
import { createOpenApiDocument } from "../../src/app/http/openapi/openApiDocument.js";
import type { ConsentRecord, ConversationConsents } from "../../src/modules/privacy/public.js";
import { forbidden } from "../../src/shared/domain/errors.js";
import { adminSessionHeaders, createTestApp, issueTestSession, issueTestToken } from "../support/testApp.js";

const record = (overrides: Partial<ConsentRecord> = {}): ConsentRecord => ({
  id: randomUUID(),
  routineId: "routine-class-booking",
  consentKey: "health",
  slotKeys: ["injury"],
  decision: "granted",
  method: "button",
  defaulted: false,
  locale: "en",
  channel: "website_embed",
  wordingVersionId: "wording-version-1",
  wording: { body: "We ask about injuries only to adapt your class.", agreeLabel: "I agree", declineLabel: "No thanks" },
  decidedAt: new Date("2026-11-10T09:00:00.000Z"),
  withdrawnAt: null,
  ...overrides,
});

const presented = (consent: ConsentRecord) => ({
  ...consent,
  decidedAt: consent.decidedAt.toISOString(),
  withdrawnAt: consent.withdrawnAt?.toISOString() ?? null,
});

const harness = async () => {
  const consents = {
    list: vi.fn<ConversationConsents["list"]>(async () => []),
    withdraw: vi.fn<ConversationConsents["withdraw"]>(async () => ({ kind: "not_found" })),
  };
  const { app, dependencies } = createTestApp({ conversationConsents: consents });
  const session = await issueTestSession(app, `history-consents-${randomUUID()}@example.com`);
  return { app, dependencies, consents, session, headers: adminSessionHeaders(session) };
};

/** Denies the one permission, as a role without it would. */
const denyPermission = (h: Awaited<ReturnType<typeof harness>>, denied: string) =>
  vi.spyOn(h.dependencies.accountAccessService, "requirePermission").mockImplementation(async ({ permission }) => {
    if (permission === denied) throw forbidden("You do not have permission to perform this action");
    return null;
  });

describe("history consents contract", () => {
  it("lists a conversation's consent records with the wording each was decided on", async () => {
    const h = await harness();
    const conversationId = randomUUID();
    const granted = record();
    const declined = record({ decision: "declined", method: "reply", defaulted: true, channel: "email" });
    h.consents.list.mockResolvedValueOnce([granted, declined]);

    const response = await request(h.app).get(`/api/v1/history/chat/${conversationId}/consents`).set(h.headers);

    expect(response.status).toBe(200);
    expect(response.body).toEqual({ consents: [presented(granted), presented(declined)] });
    expect(h.consents.list).toHaveBeenCalledWith({ workspaceId: h.session.workspaceId, conversationId });
  });

  it("withdraws a granted consent for the signed-in teammate and answers the record as it stands", async () => {
    const h = await harness();
    const conversationId = randomUUID();
    const withdrawn = record({ withdrawnAt: new Date("2026-11-12T10:00:00.000Z") });
    h.consents.withdraw.mockResolvedValueOnce({ kind: "withdrawn", consent: withdrawn });

    const response = await request(h.app)
      .post(`/api/v1/history/chat/${conversationId}/consents/${withdrawn.id}/withdraw`)
      .set(h.headers);

    expect(response.status).toBe(200);
    expect(response.body).toEqual({ consent: presented(withdrawn) });
    expect(h.consents.withdraw).toHaveBeenCalledWith({
      workspaceId: h.session.workspaceId,
      conversationId,
      recordId: withdrawn.id,
      actor: { accountId: h.session.accountId, userId: h.session.userId },
    });
  });

  it("refuses a declined or already withdrawn consent with 409 and the reason, carrying the record as it stands", async () => {
    const h = await harness();
    const declined = record({ decision: "declined" });
    const withdrawn = record({ withdrawnAt: new Date("2026-11-11T08:00:00.000Z") });
    h.consents.withdraw
      .mockResolvedValueOnce({ kind: "not_withdrawable", reason: "declined", consent: declined })
      .mockResolvedValueOnce({ kind: "not_withdrawable", reason: "already_withdrawn", consent: withdrawn });

    const first = await request(h.app).post(`/api/v1/history/chat/${randomUUID()}/consents/${declined.id}/withdraw`).set(h.headers);
    const second = await request(h.app).post(`/api/v1/history/chat/${randomUUID()}/consents/${withdrawn.id}/withdraw`).set(h.headers);

    expect(first.status).toBe(409);
    expect(first.body.error).toEqual({
      code: "consent_not_withdrawable",
      message: expect.any(String),
      details: { reason: "declined", consent: presented(declined) },
    });
    expect(second.status).toBe(409);
    expect(second.body.error).toMatchObject({ code: "consent_not_withdrawable", details: { reason: "already_withdrawn", consent: presented(withdrawn) } });
  });

  it("answers 404 for a record the conversation does not have", async () => {
    const h = await harness();

    const response = await request(h.app).post(`/api/v1/history/chat/${randomUUID()}/consents/${randomUUID()}/withdraw`).set(h.headers);

    expect(response.status).toBe(404);
    expect(response.body.error).toMatchObject({ code: "not_found" });
  });

  it("refuses an id that is not a uuid before reading or withdrawing anything", async () => {
    const h = await harness();

    await request(h.app).get("/api/v1/history/chat/not-a-uuid/consents").set(h.headers).expect(400);
    await request(h.app).post(`/api/v1/history/chat/${randomUUID()}/consents/not-a-uuid/withdraw`).set(h.headers).expect(400);
    expect(h.consents.list).not.toHaveBeenCalled();
    expect(h.consents.withdraw).not.toHaveBeenCalled();
  });

  it("lets a teammate who can read history list consents, and only one who can delete it withdraw one", async () => {
    const h = await harness();
    denyPermission(h, "workspace.history.delete");

    await request(h.app).get(`/api/v1/history/chat/${randomUUID()}/consents`).set(h.headers).expect(200);
    await request(h.app).post(`/api/v1/history/chat/${randomUUID()}/consents/${randomUUID()}/withdraw`).set(h.headers).expect(403);
    expect(h.consents.withdraw).not.toHaveBeenCalled();
  });

  it("accepts a workspace credential, so a visitor's request can be handled over the API", async () => {
    const h = await harness();
    const { token, workspaceId } = await issueTestToken(h.app);
    const conversationId = randomUUID();
    const recordId = randomUUID();

    await request(h.app).post(`/api/v1/history/chat/${conversationId}/consents/${recordId}/withdraw`).set("Authorization", `Bearer ${token}`).expect(404);

    expect(h.consents.withdraw).toHaveBeenCalledWith(expect.objectContaining({ workspaceId, conversationId, recordId }));
    expect(apiPrincipalRoutePolicy["GET /api/v1/history/chat/:conversationId/consents"]).toEqual({
      permission: "workspace.history.read",
      allowedPrincipalKinds: ["session_user", "personal_api_credential", "service_account_credential"],
      sessionOnly: false,
    });
    expect(apiPrincipalRoutePolicy["POST /api/v1/history/chat/:conversationId/consents/:recordId/withdraw"]).toEqual({
      permission: "workspace.history.delete",
      allowedPrincipalKinds: ["session_user", "personal_api_credential", "service_account_credential"],
      sessionOnly: false,
    });
  });

  it("documents both operations, the 409 reasons and the record's shape", () => {
    const document = createOpenApiDocument();
    const list = document.paths?.["/api/v1/history/chat/{conversationId}/consents"]?.get;
    const withdraw = document.paths?.["/api/v1/history/chat/{conversationId}/consents/{recordId}/withdraw"]?.post;

    expect(list?.operationId).toBe("listHistoryConversationConsents");
    expect(withdraw?.operationId).toBe("withdrawHistoryConversationConsent");
    expect(Object.keys(withdraw?.responses ?? {}).sort()).toEqual(["200", "400", "401", "403", "404", "409"]);
    const consent = document.components?.schemas?.ConversationConsent as { required?: string[] };
    expect([...(consent.required ?? [])].sort()).toEqual([
      "channel",
      "consentKey",
      "decidedAt",
      "decision",
      "defaulted",
      "id",
      "locale",
      "method",
      "routineId",
      "slotKeys",
      "withdrawnAt",
      "wording",
      "wordingVersionId",
    ]);
    const refusal = document.components?.schemas?.ConsentNotWithdrawableError as {
      properties?: { error?: { properties?: { details?: { properties?: { reason?: { enum?: string[] } } } } } };
    };
    expect(refusal.properties?.error?.properties?.details?.properties?.reason?.enum).toEqual(["declined", "already_withdrawn"]);
  });
});
