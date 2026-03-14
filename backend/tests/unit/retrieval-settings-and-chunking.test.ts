import { describe, expect, it } from "vitest";

import { chunkMarkdown } from "../../src/modules/retrieval/domain/chunkingService.js";
import {
  defaultRetrievalSettings,
  defaultAttributeControls,
  validateRetrievalSettings,
} from "../../src/modules/settings/domain/retrievalSettings.js";

describe("retrieval settings and chunking", () => {
  it("rejects invalid retrieval settings", () => {
    expect(() =>
      validateRetrievalSettings({
        queryRewriteEnabled: false,
        rerankEnabled: false,
        vectorTopK: 0,
        similarityThreshold: 0.2,
        rerankTopK: 5,
        warmthLevel: 0,
        citationDisplayEnabled: true,
        chunkingStrategy: "fixed_window",
        attributeControls: defaultAttributeControls(),
      }),
    ).toThrow("vectorTopK must be between 1 and 300");
  });

  it("rejects warmth values outside the supported range", () => {
    expect(() =>
      validateRetrievalSettings({
        queryRewriteEnabled: false,
        rerankEnabled: false,
        vectorTopK: 15,
        similarityThreshold: 0.2,
        rerankTopK: 5,
        warmthLevel: 11,
        citationDisplayEnabled: true,
        chunkingStrategy: "fixed_window",
        attributeControls: defaultAttributeControls(),
      }),
    ).toThrow("warmthLevel must be between 1 and 10");
  });

  it("rejects unsupported chunking strategies", () => {
    expect(() =>
      validateRetrievalSettings({
        queryRewriteEnabled: false,
        rerankEnabled: false,
        vectorTopK: 15,
        similarityThreshold: 0.2,
        rerankTopK: 5,
        warmthLevel: 5,
        citationDisplayEnabled: true,
        chunkingStrategy: "unsupported" as never,
        attributeControls: defaultAttributeControls(),
      }),
    ).toThrow("chunkingStrategy must be a supported strategy");
  });

  it("rejects retrieval settings with missing attribute-family controls", () => {
    expect(() =>
      validateRetrievalSettings({
        queryRewriteEnabled: false,
        rerankEnabled: false,
        vectorTopK: 15,
        similarityThreshold: 0.2,
        rerankTopK: 5,
        warmthLevel: 5,
        citationDisplayEnabled: true,
        chunkingStrategy: "fixed_window",
        attributeControls: defaultAttributeControls().slice(0, 2),
      }),
    ).toThrow("attributeControls must include every supported family");
  });

  it("creates overlapping chunks for long content", () => {
    const longText = "word ".repeat(400);
    const chunks = chunkMarkdown(longText);

    expect(chunks.length).toBeGreaterThan(1);
    expect(chunks[1].startOffset).toBeLessThan(chunks[0].endOffset);
  });

  it("uses a modestly broader default candidate pool", () => {
    const defaults = defaultRetrievalSettings("account-1");

    expect(defaults.vectorTopK).toBe(15);
    expect(defaults.similarityThreshold).toBe(0.2);
    expect(defaults.warmthLevel).toBe(5);
    expect(defaults.citationDisplayEnabled).toBe(true);
    expect(defaults.chunkingStrategy).toBe("fixed_window");
    expect(defaults.attributeControls).toEqual([
      { family: "date_point", enabled: true, mode: "boost_only" },
      { family: "date_range", enabled: true, mode: "boost_only" },
      { family: "money_value", enabled: true, mode: "boost_only" },
      { family: "location", enabled: true, mode: "boost_only" },
    ]);
  });
});
