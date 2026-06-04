import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import {
  retrievalMetadataConditionOverrideSchema,
  retrievalMetadataRuleOverrideSchema,
  retrievalSkillSettingsOverrideSchema,
} from "../../src/modules/retrieval/domain/retrievalSkillSettings.js";

const PER_AGENT_RETRIEVAL_MANIFEST_FIELD_DELTA = ["similarityThreshold"] as const;

const sorted = (values: Iterable<string>) => [...values].sort((a, b) => a.localeCompare(b));

const minimalRule = {
  id: "rule-1",
  effect: "boost",
  enabled: true,
};

const minimalCondition = {
  id: "condition-1",
  field: "region",
  valueType: "string",
  operator: "equals",
  value: "eu",
};

describe("retrieval skill settings override schema", () => {
  it("tracks the retrieval.answer manifest shape except for documented per-agent policy deltas", () => {
    const manifestPath = new URL(
      "../../src/modules/skills/definitions/retrieval.answer/generated.contract.json",
      import.meta.url,
    );
    const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as {
      schemas: {
        RetrievalSettingsOverride: {
          properties: {
            metadataRules: {
              items: {
                properties: Record<string, unknown>;
                required: string[];
              };
            };
          } & Record<string, unknown>;
        };
      };
    };

    const manifestFields = Object.keys(manifest.schemas.RetrievalSettingsOverride.properties);
    const perAgentFields = retrievalSkillSettingsOverrideSchema.keyof().options;
    const delta = new Set<string>(PER_AGENT_RETRIEVAL_MANIFEST_FIELD_DELTA);

    expect(sorted(delta)).toEqual(["similarityThreshold"]);
    expect(manifestFields).toEqual(expect.arrayContaining([...PER_AGENT_RETRIEVAL_MANIFEST_FIELD_DELTA]));
    expect(sorted(perAgentFields)).toEqual(sorted(manifestFields.filter((field) => !delta.has(field))));

    const manifestRule = manifest.schemas.RetrievalSettingsOverride.properties.metadataRules.items;
    const manifestCondition = (manifestRule.properties.conditions as {
      items: {
        properties: Record<string, unknown>;
        required: string[];
      };
    }).items;

    expect(sorted(retrievalMetadataRuleOverrideSchema.keyof().options)).toEqual(sorted(Object.keys(manifestRule.properties)));
    expect(sorted(retrievalMetadataConditionOverrideSchema.keyof().options)).toEqual(
      sorted(Object.keys(manifestCondition.properties)),
    );

    expect(manifestRule.required).toEqual(["id", "effect", "enabled"]);
    expect(manifestCondition.required).toEqual(["id", "field", "valueType", "operator", "value"]);

    expect(retrievalMetadataRuleOverrideSchema.parse(minimalRule)).toEqual(minimalRule);
    for (const requiredField of manifestRule.required) {
      const candidate = { ...minimalRule } as Record<string, unknown>;
      delete candidate[requiredField];
      expect(retrievalMetadataRuleOverrideSchema.safeParse(candidate).success).toBe(false);
    }

    expect(retrievalMetadataConditionOverrideSchema.parse(minimalCondition)).toEqual(minimalCondition);
    for (const requiredField of manifestCondition.required) {
      const candidate = { ...minimalCondition } as Record<string, unknown>;
      delete candidate[requiredField];
      expect(retrievalMetadataConditionOverrideSchema.safeParse(candidate).success).toBe(false);
    }
  });
});
