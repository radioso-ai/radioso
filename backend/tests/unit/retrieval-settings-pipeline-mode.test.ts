import { describe, expect, it } from "vitest";

import {
  DEFAULT_PIPELINE_MODE,
  defaultRetrievalSettings,
  pipelineModes,
  resolvePipelineMode,
  validateRetrievalSettings,
  type RetrievalSettingsInput,
} from "../../src/modules/settings/contracts/retrieval.js";
import { freezeRetrievalSettings } from "../../src/modules/settings/contracts/retrieval.js";

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

describe("retrieval settings — pipelineMode", () => {
  it("defaults to deterministic in defaultRetrievalSettings", () => {
    const record = defaultRetrievalSettings("ws-1");
    expect(record.pipelineMode).toBe("deterministic");
    expect(DEFAULT_PIPELINE_MODE).toBe("deterministic");
  });

  it("exposes both modes as the allowed enum", () => {
    expect([...pipelineModes]).toEqual(["deterministic", "agentic"]);
  });

  it("resolvePipelineMode falls back to deterministic for undefined or unknown values", () => {
    expect(resolvePipelineMode(undefined)).toBe("deterministic");
    expect(resolvePipelineMode(null)).toBe("deterministic");
    expect(resolvePipelineMode("agentic")).toBe("agentic");
    expect(resolvePipelineMode("deterministic")).toBe("deterministic");
  });

  it("is NOT a writable input field — RetrievalSettingsInput does not expose pipelineMode", () => {
    // Intentional: until Layer 1 persists pipelineMode and composition reads it
    // per-workspace, accepting it as input would be a contract that silently
    // does nothing. The validator simply ignores any stray pipelineMode key.
    const input = baseInput() as RetrievalSettingsInput & { pipelineMode?: string };
    input.pipelineMode = "agentic";
    const validated = validateRetrievalSettings(input) as typeof input;
    // The validator returns the input unchanged; it neither rejects nor acts on
    // pipelineMode. The key is not part of the typed writable contract.
    expect(() => validateRetrievalSettings(baseInput())).not.toThrow();
    expect(validated.pipelineMode).toBe("agentic"); // passed through untyped, but never persisted
  });

  it("freezeRetrievalSettings carries pipelineMode into the snapshot (internal record substrate)", () => {
    const record = { ...defaultRetrievalSettings("ws-1"), pipelineMode: "agentic" as const };
    const snapshot = freezeRetrievalSettings(record);
    expect(snapshot.pipelineMode).toBe("agentic");
  });
});
