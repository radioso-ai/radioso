import { describe, expect, it, vi } from "vitest";

import {
  signVisitorIdentity,
  verifySignedIdentity,
  verifySignedIdentityOutcome,
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

  it("treats a token over the length limit as unverifiable, even one signed with the workspace secret", async () => {
    const oversized = signVisitorIdentity(
      currentSecret,
      workspaceId,
      agentId,
      basePayload({ attributes: { note: "x".repeat(9_000) } }),
    );
    expect(oversized.length).toBeGreaterThan(8_192);

    await expect(verify(oversized)).resolves.toBeNull();
    await expect(verify("a".repeat(1_000_000))).resolves.toBeNull();
  });

  it("does not consume the nonce of a token it refuses for length", async () => {
    const markNonceUsed = vi.fn(async () => {});
    const oversized = signVisitorIdentity(currentSecret, workspaceId, agentId, basePayload({ attributes: { note: "x".repeat(9_000) } }));

    await verify(oversized, { markNonceUsed });

    expect(markNonceUsed).not.toHaveBeenCalled();
  });
});

describe("visitor identity verification outcome", () => {
  const outcomeOf = async (token: string, overrides: Partial<Parameters<typeof verifySignedIdentity>[0]> = {}) => {
    const nonces = nonceStore();
    const result = await verifySignedIdentityOutcome({
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
    return result.outcome;
  };
  const signed = (overrides: Partial<SignedVisitorIdentityPayload> = {}) =>
    signVisitorIdentity(currentSecret, workspaceId, agentId, basePayload(overrides));

  it("names the identity it verified", async () => {
    const result = await verifySignedIdentityOutcome({
      token: signed(),
      workspaceId,
      agentId,
      boundSessionId: "session-123",
      boundOrigin: "https://example.com",
      now,
      secrets: [currentSecret],
      ...nonceStore(),
    });

    expect(result).toEqual({ outcome: "verified", identity: { customerId: "customer-123", attributes: { plan: "pro" } } });
  });

  it("names why a token did not verify, from a closed set", async () => {
    const replayed = nonceStore();
    const replayInput = { isNonceUsed: replayed.isNonceUsed, markNonceUsed: replayed.markNonceUsed };
    const token = signed({ nonce: "nonce-replay" });
    await outcomeOf(token, replayInput);

    const outcomes = {
      too_long: await outcomeOf(signed({ attributes: { note: "x".repeat(9_000) } })),
      not_configured: await outcomeOf(signed(), { secrets: [] }),
      malformed: await outcomeOf("not-a-token"),
      invalid_signature: await outcomeOf(`${signed().split(".")[0]}.${"A".repeat(43)}`),
      invalid_payload: await outcomeOf(signVisitorIdentity(currentSecret, workspaceId, agentId, { customerId: "" } as SignedVisitorIdentityPayload)),
      expired: await outcomeOf(signed({ issuedAt: now - 301_000 })),
      wrong_session: await outcomeOf(signed({ sessionId: "other" })),
      wrong_origin: await outcomeOf(signed({ origin: "https://evil.example" })),
      replayed: await outcomeOf(token, replayInput),
      error: await outcomeOf(signed({ nonce: "nonce-error" }), {
        isNonceUsed: async () => {
          throw new Error("database unavailable");
        },
      }),
    };

    expect(outcomes).toEqual({
      too_long: "too_long",
      not_configured: "not_configured",
      malformed: "malformed",
      invalid_signature: "invalid_signature",
      invalid_payload: "invalid_payload",
      expired: "expired",
      wrong_session: "wrong_session",
      wrong_origin: "wrong_origin",
      replayed: "replayed",
      error: "error",
    });
  });
});
