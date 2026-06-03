import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import { retrievalSkillSettingsOverrideSchema } from "../../src/modules/retrieval/domain/retrievalSkillSettings.js";

const PER_AGENT_RETRIEVAL_MANIFEST_FIELD_DELTA = ["similarityThreshold"] as const;

const sorted = (values: Iterable<string>) => [...values].sort((a, b) => a.localeCompare(b));

describe("retrieval skill settings override schema", () => {
  it("tracks the retrieval.answer manifest shape except for documented per-agent policy deltas", () => {
    const manifestPath = new URL(
      "../../src/modules/skills/definitions/retrieval.answer/generated.contract.json",
      import.meta.url,
    );
    const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as {
      schemas: {
        RetrievalSettingsOverride: {
          properties: Record<string, unknown>;
        };
      };
    };

    const manifestFields = Object.keys(manifest.schemas.RetrievalSettingsOverride.properties);
    const perAgentFields = retrievalSkillSettingsOverrideSchema.keyof().options;
    const delta = new Set<string>(PER_AGENT_RETRIEVAL_MANIFEST_FIELD_DELTA);

    expect(sorted(delta)).toEqual(["similarityThreshold"]);
    expect(manifestFields).toEqual(expect.arrayContaining(PER_AGENT_RETRIEVAL_MANIFEST_FIELD_DELTA));
    expect(sorted(perAgentFields)).toEqual(sorted(manifestFields.filter((field) => !delta.has(field))));
  });
});
