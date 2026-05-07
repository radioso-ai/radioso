import { describe, expect, it } from "vitest";

import { SkillRunResolver, type SkillDefinition } from "../../src/modules/skills/public.js";

const createSkill = (): SkillDefinition => ({
  name: "example.skill",
  displayName: "Example skill",
  description: "Example skill used by resolver tests.",
  owner: "platform",
  executionClass: "interactive",
  supportedCallers: ["sdk"],
  requiredCapabilities: [],
  contractReferences: [],
  diagnostics: {
    defined: true,
    shapeAware: true,
  },
  steps: [
    {
      name: "first",
      kind: "first",
      clauses: {
        ranking: {
          rerankMode: "settings_default",
          lexicalBias: "normal",
        },
        limit: 8,
      },
    },
    {
      name: "second",
      kind: "second",
      clauses: {
        enabled: true,
      },
    },
  ],
  shapes: [
    {
      name: "default",
      stepOverrides: {},
    },
    {
      name: "lexical",
      stepOverrides: {
        first: {
          ranking: {
            rerankMode: "disabled",
          },
        },
      },
    },
  ],
});

describe("SkillRunResolver", () => {
  it("returns default clauses when no shape override applies", () => {
    const resolved = new SkillRunResolver().resolve({
      skill: createSkill(),
      shapeName: "default",
      fallbackShapeName: "default",
    });

    expect(resolved).toMatchObject({
      skillName: "example.skill",
      shapeName: "default",
      shapeFound: true,
      resolvedSteps: [
        {
          name: "first",
          overrideApplied: false,
          clauses: {
            ranking: {
              rerankMode: "settings_default",
              lexicalBias: "normal",
            },
            limit: 8,
          },
        },
        {
          name: "second",
          overrideApplied: false,
          clauses: {
            enabled: true,
          },
        },
      ],
    });
  });

  it("deep-merges partial shape overrides into default clauses", () => {
    const resolved = new SkillRunResolver().resolve({
      skill: createSkill(),
      shapeName: "lexical",
      fallbackShapeName: "default",
    });

    expect(resolved.resolvedSteps[0]).toMatchObject({
      name: "first",
      overrideApplied: true,
      clauses: {
        ranking: {
          rerankMode: "disabled",
          lexicalBias: "normal",
        },
        limit: 8,
      },
      appliedOverride: {
        ranking: {
          rerankMode: "disabled",
        },
      },
    });
    expect(resolved.resolvedSteps[1]).toMatchObject({
      name: "second",
      overrideApplied: false,
      clauses: {
        enabled: true,
      },
    });
  });

  it("falls back when the requested shape is unknown", () => {
    const resolved = new SkillRunResolver().resolve({
      skill: createSkill(),
      shapeName: "missing",
      fallbackShapeName: "default",
    });

    expect(resolved).toMatchObject({
      shapeName: "default",
      requestedShapeName: "missing",
      shapeFound: false,
    });
  });

  it("does not mutate the input definition", () => {
    const skill = createSkill();
    const snapshot = JSON.stringify(skill);

    const resolved = new SkillRunResolver().resolve({
      skill,
      shapeName: "lexical",
      fallbackShapeName: "default",
    });
    resolved.resolvedSteps[0]!.clauses.ranking = { rerankMode: "mutated" };
    resolved.resolvedSteps[0]!.appliedOverride = { ranking: { rerankMode: "mutated" } };

    expect(JSON.stringify(skill)).toBe(snapshot);
  });
});
