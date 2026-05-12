import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import {
  buildRetrievalAnswerGeneratedContract,
  serializeGeneratedSkillContract,
} from "../../scripts/skillContractArtifacts.js";
import {
  retrievalAnswerSkillDefinition,
  skillDefinitionSchema,
} from "../../src/modules/skills/public.js";

describe("skill manifests", () => {
  it("loads retrieval.answer from a valid manifest", () => {
    expect(retrievalAnswerSkillDefinition).toMatchObject({
      name: "retrieval.answer",
      generatedContract: {
        path: "generated.contract.json",
      },
      schemaReferences: {
        inputSchemaRef: "RetrievalAnswerRequest",
        settingsSchemaRef: "RetrievalSettingsOverride",
      },
    });
    // Runtime skill docs are not consumed yet; keep dormant instruction fields out of the manifest.
    expect(retrievalAnswerSkillDefinition).not.toHaveProperty("instructions");
  });

  it("keeps the generated retrieval.answer contract current with OpenAPI schemas", () => {
    const generatedPath = new URL(
      "../../src/modules/skills/definitions/retrieval.answer/generated.contract.json",
      import.meta.url,
    );

    expect(readFileSync(generatedPath, "utf8")).toBe(
      serializeGeneratedSkillContract(buildRetrievalAnswerGeneratedContract()),
    );
  });

  it("validates the hand-authored retrieval.answer skill manifest", () => {
    const manifestPath = new URL(
      "../../src/modules/skills/definitions/retrieval.answer/skill.json",
      import.meta.url,
    );

    expect(skillDefinitionSchema.safeParse(JSON.parse(readFileSync(manifestPath, "utf8"))).success).toBe(true);
  });
});
