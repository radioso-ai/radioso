import { describe, expect, it } from "vitest";

import {
  signVisitorIdentity,
  verifySignedIdentity,
  type SignedVisitorIdentityPayload,
} from "../../src/modules/context-variables/public.js";

const workspaceId = "11111111-1111-4111-8111-111111111111";
const agentId = "22222222-2222-4222-8222-222222222222";
const currentSecret = "current-workspace-secret";
const previousSecret = "previous-workspace-secret";
const now = Date.parse("2026-06-25T12:00:00.000Z");

const basePayload = (overrides: Partial<SignedVisitorIdentityPayload> = {}): SignedVisitorIdentityPayload => ({
  customerId: "customer-123",
  sessionId: "session-123",
  origin: "https://example.com",
  issuedAt: now,
  nonce: "nonce-123",
  attributes: { plan: "pro" },
  ...overrides,
});

const nonceStore = () => {
  const used = new Set<string>();
  return {
    isNonceUsed: async (nonce: string) => used.has(nonce),
    markNonceUsed: async (nonce: string) => {
      used.add(nonce);
    },
  };
};

const verify = (
  token: string,
  overrides: Partial<Parameters<typeof verifySignedIdentity>[0]> = {},
) => {
  const nonces = nonceStore();
  return verifySignedIdentity({
    token,
    workspaceId,
    agentId,
    boundSessionId: "session-123",
    boundOrigin: "https://example.com",
    now,
    secrets: [currentSecret],
    isNonceUsed: nonces.isNonceUsed,
    markNonceUsed: nonces.markNonceUsed,
    ...overrides,
  });
};

describe("visitor identity signing", () => {
  it("accepts a valid signed identity", async () => {
    const token = signVisitorIdentity(currentSecret, workspaceId, agentId, basePayload());

    await expect(verify(token)).resolves.toEqual({
      customerId: "customer-123",
      attributes: { plan: "pro" },
    });
  });

  it("fails closed for tampered payloads and signatures", async () => {
    const token = signVisitorIdentity(currentSecret, workspaceId, agentId, basePayload());
    const [payload, signature] = token.split(".");
    const tamperedPayload = Buffer.from(JSON.stringify(basePayload({ customerId: "customer-999" }))).toString("base64url");

    await expect(verify(`${tamperedPayload}.${signature}`)).resolves.toBeNull();
    await expect(verify(`${payload}.${signature}x`)).resolves.toBeNull();
  });

  it("fails closed outside the acceptance window", async () => {
    const token = signVisitorIdentity(currentSecret, workspaceId, agentId, basePayload({ issuedAt: now - 301_000 }));

    await expect(verify(token)).resolves.toBeNull();
  });

  it("fails closed for wrong session or origin binding", async () => {
    const wrongSession = signVisitorIdentity(currentSecret, workspaceId, agentId, basePayload({ sessionId: "other" }));
    const wrongOrigin = signVisitorIdentity(currentSecret, workspaceId, agentId, basePayload({ origin: "https://evil.example" }));

    await expect(verify(wrongSession)).resolves.toBeNull();
    await expect(verify(wrongOrigin)).resolves.toBeNull();
  });

  it("fails closed for replayed nonces", async () => {
    const nonces = nonceStore();
    const token = signVisitorIdentity(currentSecret, workspaceId, agentId, basePayload());
    const input = {
      workspaceId,
      agentId,
      boundSessionId: "session-123",
      boundOrigin: "https://example.com",
      now,
      secrets: [currentSecret],
      isNonceUsed: nonces.isNonceUsed,
      markNonceUsed: nonces.markNonceUsed,
    };

    await expect(verifySignedIdentity({ ...input, token })).resolves.not.toBeNull();
    await expect(verifySignedIdentity({ ...input, token })).resolves.toBeNull();
  });

  it("accepts tokens signed with the previous rotation secret", async () => {
    const token = signVisitorIdentity(previousSecret, workspaceId, agentId, basePayload());

    await expect(verify(token, { secrets: [currentSecret, previousSecret] })).resolves.toEqual({
      customerId: "customer-123",
      attributes: { plan: "pro" },
    });
  });

  it("fails closed for malformed tokens", async () => {
    await expect(verify("not-a-token")).resolves.toBeNull();
    await expect(verify("bad.payload.parts.extra")).resolves.toBeNull();
  });
});
