import { describe, expect, it } from "vitest";
import { normalizeCredentialLabel, requireFutureExpiry } from "../../../src/modules/machineAccess/domain.js";
import { hashMachineSecret, issueMachineSecret, verifierMatches } from "../../../src/modules/machineAccess/credentialSecretCodec.js";

describe("machine access credential values", () => {
  it("normalizes NFC labels and rejects controls", () => {
    expect(normalizeCredentialLabel("  cafe\u0301 ")).toBe("café");
    expect(() => normalizeCredentialLabel("bad\nlabel")).toThrow("non-control");
  });

  it("requires an expiry after issue time", () => {
    const now = new Date("2026-08-31T00:00:00Z");
    expect(() => requireFutureExpiry(now, now)).toThrow("future");
  });

  it("issues versioned opaque secrets and never needs reversible storage", () => {
    const issued = issueMachineSecret();
    expect(issued.secret).toMatch(/^radioso_pat_v1_/);
    expect(issued.tokenPrefix).not.toContain(issued.secret.slice(-12));
    expect(verifierMatches(issued.secret, issued.tokenHash)).toBe(true);
    expect(() => hashMachineSecret("not-a-machine-token")).toThrow();
  });
});
