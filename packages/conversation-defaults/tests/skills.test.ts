import { describe, expect, it } from "vitest";

import {
  SkillCatalogRegistry,
  SkillExecutorRegistry,
  SkillRunResolver,
  type ResolvableSkillDefinition,
  type SkillDispatchResult,
  type SkillExecutorPort,
} from "../src/index.js";

const noopExecutor = (label: string): SkillExecutorPort => ({
  async dispatch(): Promise<SkillDispatchResult> {
    return { disposition: "settled", outcome: { status: "completed", answer: label } };
  },
});

const createSkill = (): ResolvableSkillDefinition => ({
  name: "example.skill",
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
  ],
  shapes: [
    { name: "default", stepOverrides: {} },
    { name: "lexical", stepOverrides: { first: { ranking: { rerankMode: "disabled" } } } },
  ],
});

describe("skill defaults", () => {
  it("registers, lists, and gets catalog entries; rejects duplicates", () => {
    const registry = new SkillCatalogRegistry([{ name: "demo" }]);
    expect(registry.get("demo")).toEqual({ name: "demo" });
    expect(registry.list()).toEqual([{ name: "demo" }]);
    expect(() => registry.register({ name: "demo" })).toThrow(/already registered/);
  });

  it("resolves executors by execution descriptor", () => {
    const registry = new SkillExecutorRegistry();
    const executor = noopExecutor("ok");
    registry.register({ kind: "internal", adapter: "echo", executor });

    expect(registry.resolve({ kind: "internal", adapter: "echo" })).toBe(executor);
    expect(registry.resolve({ kind: "internal", adapter: "missing" })).toBeNull();
  });

  it("deep-merges partial shape overrides without mutating input", () => {
    const skill = createSkill();
    const snapshot = JSON.stringify(skill);
    const resolved = new SkillRunResolver().resolve({ skill, shapeName: "lexical" });

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
    });
    expect(JSON.stringify(skill)).toBe(snapshot);
  });
});
