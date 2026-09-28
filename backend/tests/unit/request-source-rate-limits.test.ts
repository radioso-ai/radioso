import { digestSourceAddress } from "@radioso/mcp-source-proof";
import request from "supertest";
import { describe, expect, it, vi } from "vitest";

import { createTestApp } from "../support/testApp.js";

const LOAD_BALANCER = "35.191.0.1";
const CLIENT_A = "203.0.113.10";
const CLIENT_B = "203.0.113.11";

// The hosted topology: the load balancer appends `<client>, <lb>` and the backend trusts two hops.
const behindLoadBalancer = (client: string) => `198.51.100.99, ${client}, ${LOAD_BALANCER}`;

const createHostedApp = () => {
  const { app, dependencies } = createTestApp({
    envOverrides: {
      RADIOSO_TRUSTED_PROXY_HOPS: 2,
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

describe("request-source keyed rate limits behind the hosted load balancer", () => {
  it("gives each forwarded visitor of one embed its own public chat session-exchange budget", async () => {
    const { app, enforce } = createHostedApp();
    const exchange = (client: string) => request(app)
      .post("/api/v1/public/chat/launch-token-1/sessions")
      .set("X-Forwarded-For", behindLoadBalancer(client))
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

  it("gives each forwarded caller its own source-keyed auth budget", async () => {
    const { app, enforce } = createHostedApp();
    const confirmReset = (client: string) => request(app)
      .post("/api/v1/auth/password-reset/confirm")
      .set("X-Forwarded-For", behindLoadBalancer(client))
      .send({ token: "unknown-reset-token", password: "long-enough-password" });

    expect((await confirmReset(CLIENT_A)).status).not.toBe(429);
    expect((await confirmReset(CLIENT_A)).status).not.toBe(429);
    expect((await confirmReset(CLIENT_A)).status).toBe(429);
    expect((await confirmReset(CLIENT_B)).status).not.toBe(429);

    expect(new Set(subjectKeysFor(enforce, "auth.password_reset.confirm"))).toEqual(
      new Set([digestSourceAddress(CLIENT_A), digestSourceAddress(CLIENT_B)]),
    );
  });

  it("keeps email-first auth keys keyed on the email", async () => {
    const { app, enforce } = createHostedApp();

    await request(app)
      .post("/api/v1/auth/password-reset/request")
      .set("X-Forwarded-For", behindLoadBalancer(CLIENT_A))
      .send({ email: "Visitor@Example.com" });

    expect(subjectKeysFor(enforce, "auth.password_reset.request")).toEqual(["visitor@example.com"]);
  });
});
