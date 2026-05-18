import { describe, expect, it } from "vitest";

import { validateAgentInput } from "../../src/modules/agents/public.js";

describe("agent branding normalization", () => {
  it("defaults branding to false / null when input omits it", () => {
    const normalized = validateAgentInput({ name: "Agent" });
    expect(normalized.branding).toEqual({ hidePoweredBy: false, privacyPolicyUrl: null });
  });

  it("preserves a valid https privacy policy URL", () => {
    const normalized = validateAgentInput({
      name: "Agent",
      branding: { hidePoweredBy: true, privacyPolicyUrl: "https://example.com/privacy" },
    });
    expect(normalized.branding.hidePoweredBy).toBe(true);
    expect(normalized.branding.privacyPolicyUrl).toBe("https://example.com/privacy");
  });

  it("treats an empty privacy URL as null", () => {
    const normalized = validateAgentInput({
      name: "Agent",
      branding: { hidePoweredBy: false, privacyPolicyUrl: "   " },
    });
    expect(normalized.branding.privacyPolicyUrl).toBeNull();
  });

  it("rejects a non-http(s) privacy URL", () => {
    expect(() =>
      validateAgentInput({
        name: "Agent",
        branding: { hidePoweredBy: false, privacyPolicyUrl: "javascript:alert(1)" },
      }),
    ).toThrow(/http or https/);
  });

  it("rejects an unparseable privacy URL", () => {
    expect(() =>
      validateAgentInput({
        name: "Agent",
        branding: { hidePoweredBy: false, privacyPolicyUrl: "not a url" },
      }),
    ).toThrow(/valid URL/);
  });
});
