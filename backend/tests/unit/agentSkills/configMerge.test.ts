import { describe, expect, it } from "vitest";

import { mergeSkillConfig } from "../../../src/modules/agentSkills/configMerge.js";

describe("mergeSkillConfig", () => {
  it("recurses into a nested plain object so an untouched sibling key survives", () => {
    const existing = {
      delivery: {
        recipientEmails: ["ops@example.com"],
        webhook: { url: "https://hooks.example.com/abc" },
      },
    };
    const patch = { delivery: { recipientEmails: ["ops2@example.com"] } };

    expect(mergeSkillConfig(existing, patch)).toEqual({
      delivery: {
        recipientEmails: ["ops2@example.com"],
        webhook: { url: "https://hooks.example.com/abc" },
      },
    });
  });

  it("replaces an array outright rather than concatenating or merging by index", () => {
    const existing = { exposedInputs: { tags: ["a", "b", "c"] } };
    const patch = { exposedInputs: { tags: ["z"] } };

    expect(mergeSkillConfig(existing, patch)).toEqual({ exposedInputs: { tags: ["z"] } });
  });

  it("replaces a scalar outright, including flipping a nested object to null", () => {
    expect(mergeSkillConfig({ delivery: { webhook: { url: "https://x" } } }, { delivery: { webhook: null } }))
      .toEqual({ delivery: { webhook: null } });
  });

  it("adds a key the existing config never had, and drops nothing else", () => {
    expect(mergeSkillConfig({ a: 1 }, { b: 2 })).toEqual({ a: 1, b: 2 });
  });

  it("treats an absent existing or patch as empty rather than throwing", () => {
    expect(mergeSkillConfig(undefined, { a: 1 })).toEqual({ a: 1 });
    expect(mergeSkillConfig({ a: 1 }, undefined)).toEqual({ a: 1 });
    expect(mergeSkillConfig(undefined, undefined)).toEqual({});
  });
});
