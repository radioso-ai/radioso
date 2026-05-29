import { describe, expect, it } from "vitest";

import {
  DEFAULT_RETRIEVAL_STRATEGY_PREFERENCE,
  defaultRetrievalSettings,
  freezeRetrievalSettings,
  resolveRetrievalStrategyPreference,
  retrievalStrategyPreferences,
  validateRetrievalSettings,
  type RetrievalSettingsInput,
} from "../../src/modules/settings/contracts/retrieval.js";

const baseInput = (overrides: Partial<RetrievalSettingsInput> = {}): RetrievalSettingsInput => ({
  queryRewriteEnabled: false,
  semanticRewriteInstructions: "",
  lexicalRewriteInstructions: "",
  suggestedQuestionsEnabled: true,
  suggestedQuestionsCount: 3,
  rerankEnabled: false,
  vectorTopK: 10,
  similarityThreshold: 0.3,
  rerankTopK: 5,
  citationDisplayEnabled: true,
  metadataRules: [],
  customInstruction: "",
  ...overrides,
});

describe("retrieval settings — retrievalStrategy", () => {
  it("defaults to fixed in defaultRetrievalSettings", () => {
    const record = defaultRetrievalSettings("ws-1");
    expect(record.retrievalStrategy).toBe("fixed");
    expect(DEFAULT_RETRIEVAL_STRATEGY_PREFERENCE).toBe("fixed");
  });

  it("exposes the open strategy axis as the allowed enum", () => {
    expect([...retrievalStrategyPreferences]).toEqual(["fixed", "reasoning", "auto"]);
  });

  it("resolveRetrievalStrategyPreference accepts valid values and rejects others", () => {
    expect(resolveRetrievalStrategyPreference("reasoning")).toBe("reasoning");
    expect(resolveRetrievalStrategyPreference("auto")).toBe("auto");
    expect(resolveRetrievalStrategyPreference(undefined)).toBeUndefined();
    expect(resolveRetrievalStrategyPreference("nope")).toBeUndefined();
  });

  it("is a writable input field — validateRetrievalSettings persists a valid strategy", () => {
    const validated = validateRetrievalSettings(baseInput({ retrievalStrategy: "reasoning" }));
    expect(validated.retrievalStrategy).toBe("reasoning");
  });

  it("normalizes an omitted strategy to the default", () => {
    const validated = validateRetrievalSettings(baseInput());
    expect(validated.retrievalStrategy).toBe("fixed");
  });

  it("rejects an invalid strategy", () => {
    const input = { ...baseInput(), retrievalStrategy: "agentic" } as unknown as RetrievalSettingsInput;
    expect(() => validateRetrievalSettings(input)).toThrow(/retrievalStrategy/);
  });

  it("freezeRetrievalSettings carries retrievalStrategy into the snapshot", () => {
    const record = { ...defaultRetrievalSettings("ws-1"), retrievalStrategy: "reasoning" as const };
    const snapshot = freezeRetrievalSettings(record);
    expect(snapshot.retrievalStrategy).toBe("reasoning");
  });
});
