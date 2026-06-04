import { describe, expect, it } from "vitest";

import { createDefaultAgentSkillSettingsRegistry } from "../../src/app/composition/skillSettingsResolver.js";
import { AgentSkillSettingsRegistry, validateAgentInput } from "../../src/modules/agents/public.js";

describe("agent branding normalization", () => {
  it("defaults branding to false / null when input omits it", () => {
    const normalized = validateAgentInput({ name: "Agent" });
    expect(normalized.branding).toEqual({ hidePoweredBy: false, privacyPolicyUrl: null });
  });

  it("defaults citation display to enabled and round-trips an explicit value", () => {
    expect(validateAgentInput({ name: "Agent" }).citationDisplayEnabled).toBe(true);
    expect(validateAgentInput({ name: "Agent", citationDisplayEnabled: false }).citationDisplayEnabled).toBe(false);
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

describe("agent skill settings normalization", () => {
  it("passes unknown skill keys through opaquely", () => {
    const normalized = validateAgentInput({
      name: "Agent",
      skillSettings: {
        "custom.skill": { enabled: true, nested: { value: 1 } },
      },
    });

    expect(normalized.skillSettings).toEqual({
      "custom.skill": { enabled: true, nested: { value: 1 } },
    });
  });

  it("normalizes known skill settings through the owning schema", () => {
    const registry = new AgentSkillSettingsRegistry();
    registry.register({
      skillName: "retrieval.answer",
      normalize(input) {
        const record = input as Record<string, unknown>;
        if (typeof record.vectorTopK !== "number") {
          throw new Error("vectorTopK must be a number");
        }
        return { vectorTopK: Math.trunc(record.vectorTopK) };
      },
    });

    const normalized = validateAgentInput({
      name: "Agent",
      skillSettings: {
        "retrieval.answer": { vectorTopK: 4.8 },
      },
    }, { skillSettings: registry });

    expect(normalized.skillSettings).toEqual({
      "retrieval.answer": { vectorTopK: 4 },
    });
  });

  it("rejects invalid known skill settings", () => {
    const registry = new AgentSkillSettingsRegistry();
    registry.register({
      skillName: "retrieval.answer",
      normalize() {
        throw new Error("retrieval.answer settings are invalid");
      },
    });

    expect(() =>
      validateAgentInput({
        name: "Agent",
        skillSettings: {
          "retrieval.answer": { vectorTopK: "large" },
        },
      }, { skillSettings: registry }),
    ).toThrow(/retrieval\.answer settings are invalid/);
  });

  it("rejects invalid retrieval skill settings at the write boundary", () => {
    expect(() =>
      validateAgentInput({
        name: "Agent",
        skillSettings: {
          "retrieval.answer": { vectorTopK: 0 },
        },
      }, { skillSettings: createDefaultAgentSkillSettingsRegistry() }),
    ).toThrow(/vectorTopK/);
  });
});
