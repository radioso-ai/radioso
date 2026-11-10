import { describe, expect, it } from "vitest";

import { decodeContextClaims, encodeContextClaims } from "../../../src/modules/a2a/domain/contextClaims.js";
import { createA2aContextSealer } from "../../../src/modules/a2a/infra/contextSealer.js";
import type { AgentConverseOpening } from "../../../src/modules/settings/contracts/agentConverseSession.js";
import { encryptField } from "../../../src/shared/infra/crypto/fieldEncryption.js";

const KEY = Buffer.from("0123456789abcdef0123456789abcdef").toString("base64");
const OTHER_KEY = Buffer.from("fedcba9876543210fedcba9876543210").toString("base64");

const walkIn: AgentConverseOpening = {
  workspaceId: "22222222-2222-4222-8222-222222222222",
  agentId: "33333333-3333-4333-8333-333333333333",
  publicSessionId: "44444444-4444-4444-8444-444444444444",
  origin: { kind: "walk_in", publicId: "ag_0123456789abcdefghijkl" },
  expiresAt: "2026-11-09T22:00:00.000Z",
};

const grant: AgentConverseOpening = {
  ...walkIn,
  origin: { kind: "grant", grantId: "11111111-1111-4111-8111-111111111111", grantVersion: "v-abc" },
  expiresAt: null,
};

describe("context claims codec", () => {
  it("round-trips a walk-in and a grant opening", () => {
    expect(decodeContextClaims(encodeContextClaims(walkIn))).toEqual(walkIn);
    expect(decodeContextClaims(encodeContextClaims(grant))).toEqual(grant);
  });

  it("reads nothing it did not write", () => {
    expect(decodeContextClaims("not json")).toBeNull();
    expect(decodeContextClaims(JSON.stringify({ apiKey: "sk-123" }))).toBeNull();
    expect(decodeContextClaims(encodeContextClaims(walkIn).replace("a2a_context", "other"))).toBeNull();
  });
});

describe("A2A context sealer", () => {
  const sealer = createA2aContextSealer({ current: KEY, previous: [] });

  it("seals an opening into an opaque, URL-safe token that names no workspace, agent or session", () => {
    const token = sealer.seal(walkIn);

    expect(token).toMatch(/^[A-Za-z0-9_.-]+$/u);
    for (const value of [walkIn.workspaceId, walkIn.agentId, walkIn.publicSessionId, "ag_0123456789abcdefghijkl"]) {
      expect(token).not.toContain(value);
    }
    expect(sealer.open(token)).toEqual(walkIn);
  });

  it("opens nothing it cannot authenticate: tampered, foreign, or another field's ciphertext", () => {
    const token = sealer.seal(grant);
    const tampered = `${token.slice(0, -4)}${token.slice(-4) === "AAAA" ? "BBBB" : "AAAA"}`;

    expect(sealer.open(tampered)).toBeNull();
    expect(createA2aContextSealer({ current: OTHER_KEY, previous: [] }).open(token)).toBeNull();
    expect(sealer.open(encryptField("sk-secret-api-key", KEY))).toBeNull();
    expect(sealer.open("")).toBeNull();
  });

  it("keeps opening tokens sealed under a key that has since been rotated out of current", () => {
    const token = sealer.seal(walkIn);
    expect(createA2aContextSealer({ current: OTHER_KEY, previous: [KEY] }).open(token)).toEqual(walkIn);
  });

  it("refuses to seal without a configured key, and opens nothing", () => {
    const unconfigured = createA2aContextSealer(undefined);
    expect(() => unconfigured.seal(walkIn)).toThrowError(expect.objectContaining({ statusCode: 503, code: "service_unavailable" }));
    expect(unconfigured.open(sealer.seal(walkIn))).toBeNull();
  });
});
