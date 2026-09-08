import { describe, expect, it } from "vitest";

import {
  createDefaultSkillCapabilityRegistry,
  skillCapabilityIds,
} from "../../src/modules/skills/capabilityRegistry.js";

describe("SkillCapabilityRegistry.portableSettingsFieldKeys", () => {
  it("returns the fields marked portable for retrieve", () => {
    const registry = createDefaultSkillCapabilityRegistry();

    expect(registry.portableSettingsFieldKeys("retrieve")).toEqual(
      new Set([
        "instruction",
        "semanticRewriteInstructions",
        "lexicalRewriteInstructions",
        "retrievalStrategy",
        "vectorTopK",
        "rerankEnabled",
        "rerankTopK",
        "queryRewriteEnabled",
        "temporalStructuredLookupEnabled",
        "temporalBoostUpcomingEnabled",
        "temporalDeterministicSortEnabled",
        "suggestedQuestionsEnabled",
        "suggestedQuestionsCount",
      ]),
    );
  });

  it("leaves workspace-bound retrieve fields out of the portable set", () => {
    const registry = createDefaultSkillCapabilityRegistry();
    const keys = registry.portableSettingsFieldKeys("retrieve");

    // These two name rows that exist only in one workspace - document source ids and this
    // workspace's own document metadata schema - so their values are meaningless, or wrong,
    // anywhere else. Operator-authored free text (instruction, the rewrite instructions) is a
    // different case and does travel: it is behavior, the same class as the agent's own
    // customInstruction, and the bundle reports every value it leaves behind rather than
    // dropping it silently.
    expect(keys.has("sourceScope")).toBe(false);
    expect(keys.has("metadataRules")).toBe(false);
  });

  it("returns an empty set for an unknown capability id", () => {
    const registry = createDefaultSkillCapabilityRegistry();

    expect(registry.portableSettingsFieldKeys("not_a_real_capability" as never)).toEqual(new Set());
  });

  it("REGRESSION GUARD: never carries notify's recipient emails or webhook url into an export", () => {
    const registry = createDefaultSkillCapabilityRegistry();
    const keys = registry.portableSettingsFieldKeys("notify");

    // If either assertion below fails, someone marked `portable: true` on a notify settings
    // field. Do not "fix" this test to make it pass - a webhook URL routinely carries a signed
    // token in its query string and recipient emails are personal data; neither may ever leave
    // the workspace in an agent-export bundle. Revert the change in capabilities/notify.ts.
    expect(keys.has("delivery.recipientEmails")).toBe(false);
    expect(keys.has("delivery.webhook.url")).toBe(false);
    expect(keys.size).toBe(0);
  });

  // The segment list below matches developer-chosen field *identifiers* in capability
  // descriptors — not visitor content, and not any routing or classification
  // decision. It is a structural guard over our own naming, so it is not the
  // English-keyword-list pattern the repo forbids for product behaviour.
  it("never marks a field portable when it is also hidden from the copilot and looks credential-ish", () => {
    const registry = createDefaultSkillCapabilityRegistry();
    const credentialishSegments = ["token", "secret", "password", "credential", "webhook", "url", "email"];

    for (const id of skillCapabilityIds) {
      const descriptor = registry.get(id);
      if (!descriptor) {
        continue;
      }
      for (const field of descriptor.settingsFields) {
        const lowerKey = field.key.toLowerCase();
        const looksCredentialish = credentialishSegments.some((segment) => lowerKey.includes(segment));
        const hiddenFromCopilot = field.showValueToCopilot !== true;
        if (looksCredentialish && hiddenFromCopilot) {
          expect(
            field.portable,
            `${id}.${field.key} looks credential-ish and is hidden from the copilot, so it must not be portable`,
          ).not.toBe(true);
        }
      }
    }
  });
});
