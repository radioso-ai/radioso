import { createEdgeFactsProof, EDGE_FACTS_HEADERS } from "@radioso/edge-proof";
import { digestSourceAddress } from "@radioso/mcp-source-proof";
import request from "supertest";
import { describe, expect, it, vi } from "vitest";

import { createTestApp } from "../support/testApp.js";

const SECRET = "f".repeat(32);
const CLIENT_A = "203.0.113.10";
const CLIENT_B = "203.0.113.11";
const FORGED = "198.51.100.99";
const FRONTEND_EGRESS = "34.96.0.5";
const SESSION_EXCHANGE_PATH = "/api/v1/public/chat/launch-token-1/sessions";

// The hosted topology. Cloud Run's front end appends exactly the connecting
// peer, on run.app and on mapped domains alike, so the backend trusts one hop.
// A caller reaching the backend directly arrives as `<whatever it sent>, <client>`.
const direct = (client: string) => `${FORGED}, ${client}`;

// The frontend is a Cloud Run service too: the chain it receives ends with the
// visitor, and it signs that chain. The backend's own chain has the frontend's
// egress appended after it.
const relayedThroughFrontend = (client: string, method: string, path: string): Record<string, string> => ({
  [EDGE_FACTS_HEADERS.marker]: "frontend",
  ...createEdgeFactsProof({
    facts: { forwardedFor: direct(client), geoHeaders: {}, userAgent: null, acceptLanguage: null },
    method,
    path,
    secret: SECRET,
  }).headers,
  "x-forwarded-for": `${direct(client)}, ${FRONTEND_EGRESS}`,
});

const createHostedApp = () => {
  const { app, dependencies } = createTestApp({
    envOverrides: {
      RADIOSO_TRUSTED_PROXY_HOPS: 1,
      RADIOSO_EDGE_PROOF_SECRET: SECRET,
      PUBLIC_CHAT_SESSION_RATE_LIMIT_MAX_ATTEMPTS: 2,
      AUTH_RATE_LIMIT_MAX_ATTEMPTS: 2,
    },
  });
  const enforce = vi.spyOn(dependencies.abuseControlService, "enforce");
  return { app, enforce };
};

const subjectKeysFor = (enforce: ReturnType<typeof createHostedApp>["enforce"], scope: string): string[] =>
  enforce.mock.calls
    .map(([input]) => input)
    .filter((input) => input.scope === scope)
    .map((input) => input.subjectKey);

describe("request-source keyed rate limits on hosted Cloud Run", () => {
  it("gives each visitor of one embed its own public chat session-exchange budget", async () => {
    const { app, enforce } = createHostedApp();
    const exchange = (client: string) => request(app)
      .post(SESSION_EXCHANGE_PATH)
      .set("X-Forwarded-For", direct(client))
      .send({ channel: "website_embed" });

    expect((await exchange(CLIENT_A)).status).not.toBe(429);
    expect((await exchange(CLIENT_A)).status).not.toBe(429);
    expect((await exchange(CLIENT_A)).status).toBe(429);
    expect((await exchange(CLIENT_B)).status).not.toBe(429);

    const subjectKeys = subjectKeysFor(enforce, "public.chat.session.exchange");
    expect(new Set(subjectKeys).size).toBe(2);
    expect(subjectKeys.every((key) => key.endsWith(`:website_embed:source:${digestSourceAddress(CLIENT_A)}`)
      || key.endsWith(`:website_embed:source:${digestSourceAddress(CLIENT_B)}`))).toBe(true);
    expect(subjectKeys.join(" ")).not.toContain(CLIENT_A);
    expect(subjectKeys.join(" ")).not.toContain(CLIENT_B);
  });

  it("keys a request the frontend relays on the visitor, not on the frontend's egress", async () => {
    const { app, enforce } = createHostedApp();
    const exchange = (client: string) => request(app)
      .post(SESSION_EXCHANGE_PATH)
      .set(relayedThroughFrontend(client, "POST", SESSION_EXCHANGE_PATH))
      .send({ channel: "website_embed" });

    expect((await exchange(CLIENT_A)).status).not.toBe(429);
    expect((await exchange(CLIENT_A)).status).not.toBe(429);
    expect((await exchange(CLIENT_A)).status).toBe(429);
    expect((await exchange(CLIENT_B)).status).not.toBe(429);

    const subjectKeys = subjectKeysFor(enforce, "public.chat.session.exchange");
    expect(new Set(subjectKeys).size).toBe(2);
    expect(subjectKeys.some((key) => key.endsWith(`:source:${digestSourceAddress(FRONTEND_EGRESS)}`))).toBe(false);
  });

  it("gives each caller its own source-keyed auth budget", async () => {
    const { app, enforce } = createHostedApp();
    const confirmReset = (client: string) => request(app)
      .post("/api/v1/auth/password-reset/confirm")
      .set("X-Forwarded-For", direct(client))
      .send({ token: "unknown-reset-token", password: "long-enough-password" });

    expect((await confirmReset(CLIENT_A)).status).not.toBe(429);
    expect((await confirmReset(CLIENT_A)).status).not.toBe(429);
    expect((await confirmReset(CLIENT_A)).status).toBe(429);
    expect((await confirmReset(CLIENT_B)).status).not.toBe(429);

    expect(new Set(subjectKeysFor(enforce, "auth.password_reset.confirm"))).toEqual(
      new Set([digestSourceAddress(CLIENT_A), digestSourceAddress(CLIENT_B)]),
    );
  });

  it("keeps a caller that forges X-Forwarded-For in its own bucket", async () => {
    const { app, enforce } = createHostedApp();
    // Cloud Run appends the connecting peer after whatever the caller sent.
    const confirmReset = (forwardedFor: string) => request(app)
      .post("/api/v1/auth/password-reset/confirm")
      .set("X-Forwarded-For", forwardedFor)
      .send({ token: "unknown-reset-token", password: "long-enough-password" });

    expect((await confirmReset(CLIENT_A)).status).not.toBe(429);
    expect((await confirmReset(CLIENT_A)).status).not.toBe(429);
    expect((await confirmReset(`${CLIENT_B}, ${CLIENT_A}`)).status).toBe(429);
    expect((await confirmReset(CLIENT_B)).status).not.toBe(429);

    expect(subjectKeysFor(enforce, "auth.password_reset.confirm")).toEqual([
      digestSourceAddress(CLIENT_A),
      digestSourceAddress(CLIENT_A),
      digestSourceAddress(CLIENT_A),
      digestSourceAddress(CLIENT_B),
    ]);
  });

  it("keeps email-first auth keys keyed on the email", async () => {
    const { app, enforce } = createHostedApp();

    await request(app)
      .post("/api/v1/auth/password-reset/request")
      .set("X-Forwarded-For", direct(CLIENT_A))
      .send({ email: "Visitor@Example.com" });

    expect(subjectKeysFor(enforce, "auth.password_reset.request")).toEqual(["visitor@example.com"]);
  });
});
