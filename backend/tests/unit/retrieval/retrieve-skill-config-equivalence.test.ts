import { describe, expect, it } from "vitest";

import { createRetrievalSkillSettingsResolver } from "../../../src/app/composition/skillSettingsResolver.js";
import {
  parseRetrieveSkillConfig,
  retrieveSkillConfigToSettingsOverride,
} from "../../../src/modules/retrieval/public.js";
import { defaultRetrievalSettings } from "../../../src/modules/settings/contracts/retrieval.js";

describe("retrieve skill config behavior preservation", () => {
  it("resolves migrated retrieve config to the same retrieval settings as legacy skill_settings", () => {
    const defaults = defaultRetrievalSettings("workspace-1");
    const legacy = {
      customInstruction: "Use event documents.",
      retrievalStrategy: "fixed",
      vectorTopK: 12,
      rerankEnabled: true,
      rerankTopK: 6,
      queryRewriteEnabled: false,
      suggestedQuestionsEnabled: false,
      suggestedQuestionsCount: 2,
    };
    const migrated = parseRetrieveSkillConfig({
      sourceScope: { sourceIds: ["2e0c6264-f2c4-4549-bcd8-bf2f7d1a0d1e"] },
      instruction: "Use event documents.",
      retrievalStrategy: "fixed",
      vectorTopK: 12,
      rerankEnabled: true,
      rerankTopK: 6,
      queryRewriteEnabled: false,
      suggestedQuestionsEnabled: false,
      suggestedQuestionsCount: 2,
      exposedInputs: { query: true },
    });
    const resolver = createRetrievalSkillSettingsResolver();

    expect(
      resolver.resolve("retrieval.answer", defaults, retrieveSkillConfigToSettingsOverride(migrated)),
    ).toEqual(
      resolver.resolve("retrieval.answer", defaults, legacy),
    );
  });
});
