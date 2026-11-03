import request from "supertest";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { resetRateLimiterState } from "../../src/app/http/middleware/anonymousRateLimiter.js";
import { adminSessionHeaders, createTestApp, issueTestSession } from "../support/testApp.js";

// 02:00 UTC on Tuesday 3 November 2026 is 18:00 on Monday 2 November in Los Angeles and 21:00 on
// Monday in New York.
const NOW = "2026-11-03T02:00:00.000Z";

const answerDateOf = (systemPrompt: string | undefined): string | undefined =>
  /The current date is (\d{4}-\d{2}-\d{2} \(\w+\))/.exec(systemPrompt ?? "")?.[1];

const createApp = () => {
  const systemPrompts: Array<string | undefined> = [];
  const testApp = createTestApp({
    chatGateway: {
      async answer(input) {
        systemPrompts.push(input.systemPrompt);
        return "An answer.";
      },
      async *streamAnswer() {
        yield "unused";
      },
    },
  });
  return { ...testApp, lastAnswerDate: () => answerDateOf(systemPrompts.at(-1)) };
};

const signIn = async (app: ReturnType<typeof createApp>["app"], email: string) => {
  const session = await issueTestSession(app, email);
  await request(app)
    .post("/api/v1/document/")
    .set(adminSessionHeaders(session))
    .send({ title: "Concerts", content: "An evening concert in the main hall on 2026-11-03." });
  return session;
};

const askAssistant = (app: ReturnType<typeof createApp>["app"], session: { cookie: string; workspaceId: string }, body: Record<string, unknown>) =>
  request(app)
    .post("/api/v1/assistant/chat")
    .set(adminSessionHeaders(session))
    .send({ message: "What concerts are on tomorrow?", stream: false, ...body });

describe("workspace time zone settings contract", () => {
  beforeEach(() => {
    resetRateLimiterState();
  });

  it("reads null (UTC) by default, stores a zone by its canonical name, and clears it", async () => {
    const { app } = createApp();
    const session = await issueTestSession(app, "tz-settings@example.com");

    const initial = await request(app).get("/api/v1/settings/time-zone").set(adminSessionHeaders(session));
    expect(initial.status).toBe(200);
    expect(initial.body).toEqual({ timeZone: null });

    const saved = await request(app)
      .put("/api/v1/settings/time-zone")
      .set(adminSessionHeaders(session))
      .send({ timeZone: "america/los_angeles" });
    expect(saved.status).toBe(200);
    expect(saved.body).toEqual({ timeZone: "America/Los_Angeles" });

    const cleared = await request(app)
      .put("/api/v1/settings/time-zone")
      .set(adminSessionHeaders(session))
      .send({ timeZone: null });
    expect(cleared.body).toEqual({ timeZone: null });
  });

  it("reads back the zone name it was given, even where ICU knows the zone by an older name", async () => {
    const { app } = createApp();
    const session = await issueTestSession(app, "tz-alias@example.com");

    for (const timeZone of ["Asia/Kolkata", "Europe/Kyiv"]) {
      const saved = await request(app)
        .put("/api/v1/settings/time-zone")
        .set(adminSessionHeaders(session))
        .send({ timeZone });
      const read = await request(app).get("/api/v1/settings/time-zone").set(adminSessionHeaders(session));

      expect(saved.body).toEqual({ timeZone });
      expect(read.body).toEqual({ timeZone });
    }
  });

  it("refuses a zone that is not an IANA zone name", async () => {
    const { app } = createApp();
    const session = await issueTestSession(app, "tz-invalid@example.com");

    for (const timeZone of ["Mars/Olympus_Mons", "+05:00", ""]) {
      const response = await request(app)
        .put("/api/v1/settings/time-zone")
        .set(adminSessionHeaders(session))
        .send({ timeZone });
      expect(response.status).toBe(400);
    }
    const stored = await request(app).get("/api/v1/settings/time-zone").set(adminSessionHeaders(session));
    expect(stored.body).toEqual({ timeZone: null });
  });
});

describe("chat reads today in the visitor's zone, else the workspace's, else UTC", () => {
  beforeEach(() => {
    resetRateLimiterState();
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date(NOW));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("answers a visitor 8 hours west of UTC from their own date when the request names their zone", async () => {
    const { app, lastAnswerDate } = createApp();
    const session = await signIn(app, "tz-visitor@example.com");

    const response = await askAssistant(app, session, { userTimeZone: "America/Los_Angeles" });

    expect(response.status).toBe(200);
    expect(lastAnswerDate()).toBe("2026-11-02 (Monday)");
  });

  it("uses the workspace's zone when the request names none, and ignores an unknown one", async () => {
    const { app, lastAnswerDate } = createApp();
    const session = await signIn(app, "tz-workspace@example.com");
    await request(app)
      .put("/api/v1/settings/time-zone")
      .set(adminSessionHeaders(session))
      .send({ timeZone: "America/New_York" });

    await askAssistant(app, session, {});
    expect(lastAnswerDate()).toBe("2026-11-02 (Monday)");

    await askAssistant(app, session, { userTimeZone: "Not/AZone" });
    expect(lastAnswerDate()).toBe("2026-11-02 (Monday)");
  });

  it("reads today in UTC when neither the visitor nor the workspace names a zone", async () => {
    const { app, lastAnswerDate } = createApp();
    const session = await signIn(app, "tz-default@example.com");

    await askAssistant(app, session, {});

    expect(lastAnswerDate()).toBe("2026-11-03 (Tuesday)");
  });

  it("refuses a userTimeZone longer than any zone name", async () => {
    const { app } = createApp();
    const session = await signIn(app, "tz-long@example.com");

    const response = await askAssistant(app, session, { userTimeZone: `Europe/${"x".repeat(80)}` });

    expect(response.status).toBe(400);
  });

  it("reads the website embed's browser zone from its page context", async () => {
    const { app, lastAnswerDate } = createApp();
    const session = await signIn(app, "tz-embed@example.com");
    const origin = "https://example.com";
    const settings = await request(app)
      .put("/api/v1/settings/general")
      .set(adminSessionHeaders(session))
      .send({ websiteEmbedEnabled: true, websiteEmbedAllowedOrigins: [origin] });
    const embedToken = settings.body.websiteEmbedToken as string;
    const publicSession = await request(app)
      .post(`/api/v1/public/chat/${embedToken}/sessions`)
      .set("Origin", origin)
      .send({ channel: "website_embed" });

    const response = await request(app)
      .post(`/api/v1/public/chat/${embedToken}`)
      .set("Origin", origin)
      .set("x-radioso-public-session", publicSession.body.publicSessionToken)
      .send({
        message: "What concerts are on tomorrow?",
        stream: false,
        pageContext: { pageUrl: `${origin}/events`, browserTimeZone: "America/Los_Angeles" },
      });

    expect(response.status).toBe(200);
    expect(lastAnswerDate()).toBe("2026-11-02 (Monday)");
  });
});
