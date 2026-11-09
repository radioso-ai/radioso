import request from "supertest";
import { describe, expect, it, vi } from "vitest";

import type { InMemoryAuditService } from "../support/fakes.js";
import { createTestApp, issueTestSession } from "../support/testApp.js";

const SIGN_OUT_PATH = "/api/v1/auth/logout";
const SESSION_PATH = "/api/v1/auth/session";

/** The cookie as a browser would store it: its name and its attributes, ignoring how long it lives. */
const cookieShape = (setCookie: string): { name: string; value: string; attributes: string[] } => {
  const [pair = "", ...attributes] = setCookie.split(";").map((part) => part.trim());
  const separator = pair.indexOf("=");
  return {
    name: pair.slice(0, separator),
    value: pair.slice(separator + 1),
    attributes: attributes
      .filter((attribute) => !/^(max-age|expires)=/i.test(attribute))
      .map((attribute) => attribute.toLowerCase())
      .sort(),
  };
};

const setCookies = (response: request.Response): string[] => {
  const header = response.headers["set-cookie"] as string[] | string | undefined;
  return Array.isArray(header) ? header : header ? [header] : [];
};

const sessionCookieClearing = (response: request.Response): string => {
  const cleared = setCookies(response).find((entry) => entry.startsWith("radioso_session="));
  expect(cleared, "the response must clear the session cookie").toBeDefined();
  return cleared ?? "";
};

describe("POST /auth/logout", () => {
  it("ends the session on the server, so the replayed cookie is refused afterwards", async () => {
    const { app } = createTestApp();
    const session = await issueTestSession(app, "sign-out-replay@example.com");
    expect((await request(app).get(SESSION_PATH).set("Cookie", session.cookie)).status).toBe(200);

    const signedOut = await request(app).post(SIGN_OUT_PATH).set("Cookie", session.cookie);

    expect(signedOut.status).toBe(204);
    expect(signedOut.headers["cache-control"]).toContain("no-store");
    const replayed = await request(app).get(SESSION_PATH).set("Cookie", session.cookie);
    expect(replayed.status).toBe(401);
  });

  it("clears the cookie with the attributes it was set with", async () => {
    const { app } = createTestApp();
    const session = await issueTestSession(app, "sign-out-attributes@example.com");

    const signedOut = await request(app).post(SIGN_OUT_PATH).set("Cookie", session.cookie);

    const cleared = sessionCookieClearing(signedOut);
    expect(cleared).toMatch(/max-age=0/i);
    const issued = cookieShape(session.cookie);
    const clearing = cookieShape(cleared);
    expect(clearing.name).toBe(issued.name);
    expect(clearing.value).toBe("");
    expect(clearing.attributes).toEqual(issued.attributes);
  });

  it("ends only the session it was called with", async () => {
    const { app } = createTestApp();
    const first = await issueTestSession(app, "sign-out-other-device@example.com");
    const login = await request(app).post("/api/v1/auth/login").send({
      email: "sign-out-other-device@example.com",
      password: "verysecurepassword",
    });
    const otherDevice = setCookies(login).find((entry) => entry.startsWith("radioso_session=")) ?? "";
    expect(otherDevice).not.toBe("");

    await request(app).post(SIGN_OUT_PATH).set("Cookie", first.cookie);

    expect((await request(app).get(SESSION_PATH).set("Cookie", first.cookie)).status).toBe(401);
    expect((await request(app).get(SESSION_PATH).set("Cookie", otherDevice)).status).toBe(200);
  });

  it.each([
    ["no cookie", undefined],
    ["a cookie that names no session", "radioso_session=not-a-real-session-token"],
  ])("succeeds and clears the cookie with %s", async (_label, cookie) => {
    const { app } = createTestApp();

    const call = request(app).post(SIGN_OUT_PATH);
    const signedOut = await (cookie ? call.set("Cookie", cookie) : call);

    expect(signedOut.status).toBe(204);
    expect(sessionCookieClearing(signedOut)).toMatch(/max-age=0/i);
  });

  it("succeeds again with a session that has already ended", async () => {
    const { app } = createTestApp();
    const session = await issueTestSession(app, "sign-out-twice@example.com");
    await request(app).post(SIGN_OUT_PATH).set("Cookie", session.cookie);

    const again = await request(app).post(SIGN_OUT_PATH).set("Cookie", session.cookie);

    expect(again.status).toBe(204);
    expect(sessionCookieClearing(again)).toMatch(/max-age=0/i);
  });

  // The dashboard signs the browser out whether or not this call succeeds, so a cookie left
  // behind by a failed call would sign the next person in on reload.
  it("clears the cookie on the 500 it answers when the session cannot be revoked", async () => {
    const { app, dependencies } = createTestApp();
    const session = await issueTestSession(app, "sign-out-revoke-fails@example.com");
    vi.spyOn(dependencies.sessionSignOutService, "signOut").mockRejectedValueOnce(new Error("revoke failed"));

    const signedOut = await request(app).post(SIGN_OUT_PATH).set("Cookie", session.cookie);

    expect(signedOut.status).toBe(500);
    expect(sessionCookieClearing(signedOut)).toMatch(/max-age=0/i);
    expect(signedOut.headers["cache-control"]).toContain("no-store");
  });

  it("clears the cookie on the 503 it answers while the database is unavailable", async () => {
    const { app, dependencies } = createTestApp();
    const session = await issueTestSession(app, "sign-out-database-down@example.com");
    vi.spyOn(dependencies.sessionSignOutService, "signOut")
      .mockRejectedValueOnce(new Error("Connection terminated unexpectedly"));

    const signedOut = await request(app).post(SIGN_OUT_PATH).set("Cookie", session.cookie);

    expect(signedOut.status).toBe(503);
    expect(sessionCookieClearing(signedOut)).toMatch(/max-age=0/i);
  });

  it("answers 500 but still ends the session and clears the cookie when only the audit write fails", async () => {
    const { app, dependencies } = createTestApp();
    const session = await issueTestSession(app, "sign-out-audit-fails@example.com");
    vi.spyOn(dependencies.auditService, "record").mockRejectedValueOnce(new Error("audit sink down"));

    const signedOut = await request(app).post(SIGN_OUT_PATH).set("Cookie", session.cookie);

    expect(signedOut.status).toBe(500);
    expect(sessionCookieClearing(signedOut)).toMatch(/max-age=0/i);
    expect((await request(app).get(SESSION_PATH).set("Cookie", session.cookie)).status).toBe(401);
  });

  it("audits the sign-out once, against the account the session was on, without the credential", async () => {
    const { app, dependencies } = createTestApp();
    const session = await issueTestSession(app, "sign-out-audit@example.com");
    const sessionToken = cookieShape(session.cookie).value;

    await request(app).post(SIGN_OUT_PATH).set("Cookie", session.cookie);
    await request(app).post(SIGN_OUT_PATH).set("Cookie", session.cookie);
    await request(app).post(SIGN_OUT_PATH);

    const events = (dependencies.auditService as InMemoryAuditService).events
      .filter((event) => event.eventType === "auth.logout");
    expect(events).toEqual([
      expect.objectContaining({
        accountId: session.accountId,
        eventStatus: "success",
        metadata: expect.objectContaining({ userId: session.userId }),
      }),
    ]);
    expect(JSON.stringify(events)).not.toContain(sessionToken);
  });
});
