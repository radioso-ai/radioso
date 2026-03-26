import { describe, expect, it } from "vitest";

import { chunkMarkdown } from "../../src/modules/retrieval/domain/chunkingService.js";
import {
  defaultIngestionSettings,
  validateIngestionSettings,
} from "../../src/modules/settings/domain/ingestionSettings.js";
import {
  defaultAttributeControls,
  defaultRetrievalSettings,
  validateRetrievalSettings,
} from "../../src/modules/settings/domain/retrievalSettings.js";

describe("settings and chunking", () => {
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
        signalPolicies: defaultAttributeControls(),
        customInstruction: "",
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
        signalPolicies: defaultAttributeControls(),
        customInstruction: "",
      }),
    ).toThrow("warmthLevel must be between 1 and 10");
  });

  it("rejects ingestion settings with unsupported chunking strategies", () => {
    expect(() =>
      validateIngestionSettings({
        chunkingStrategy: "unsupported" as never,
        fixedWindowChunkSize: 800,
        fixedWindowChunkOverlap: 120,
        structuredMinChunkSize: 24,
        structuredMaxChunkSize: 220,
      }),
    ).toThrow("chunkingStrategy must be a supported strategy");
  });

  it("rejects retrieval settings with missing signal policies", () => {
    expect(() =>
      validateRetrievalSettings({
        queryRewriteEnabled: false,
        rerankEnabled: false,
        vectorTopK: 15,
        similarityThreshold: 0.2,
        rerankTopK: 5,
        warmthLevel: 5,
        citationDisplayEnabled: true,
        signalPolicies: defaultAttributeControls().slice(0, 2),
        customInstruction: "",
      }),
    ).toThrow("signalPolicies must include every supported signal");
  });

  it("creates overlapping chunks for long content", () => {
    const longText = "word ".repeat(400);
    const chunks = chunkMarkdown(longText);

    expect(chunks.length).toBeGreaterThan(1);
    expect(chunks[1].startOffset).toBeLessThan(chunks[0].endOffset);
  });

  it("uses a modestly broader default candidate pool", () => {
    const defaults = defaultRetrievalSettings("workspace-1");

    expect(defaults.vectorTopK).toBe(15);
    expect(defaults.similarityThreshold).toBe(0.2);
    expect(defaults.warmthLevel).toBe(5);
    expect(defaults.citationDisplayEnabled).toBe(true);
    expect(defaults.signalPolicies).toEqual([
      { signalKey: "document_date", enabled: true, mode: "boost_only" },
      { signalKey: "document_period", enabled: true, mode: "boost_only" },
      { signalKey: "document_amount", enabled: true, mode: "boost_only" },
      { signalKey: "document_location", enabled: true, mode: "boost_only" },
    ]);
    expect(defaults.customInstruction).toBe("");
  });

  it("rejects customInstruction exceeding 2000 characters", () => {
    expect(() =>
      validateRetrievalSettings({
        queryRewriteEnabled: false,
        rerankEnabled: false,
        vectorTopK: 15,
        similarityThreshold: 0.2,
        rerankTopK: 5,
        warmthLevel: 5,
        citationDisplayEnabled: true,
        signalPolicies: defaultAttributeControls(),
        customInstruction: "a".repeat(2001),
      }),
    ).toThrow("customInstruction must not exceed 2000 characters");
  });

  it("accepts valid customInstruction values", () => {
    const baseInput = {
      queryRewriteEnabled: false,
      rerankEnabled: false,
      vectorTopK: 15,
      similarityThreshold: 0.2,
      rerankTopK: 5,
      warmthLevel: 5,
      citationDisplayEnabled: true,
      signalPolicies: defaultAttributeControls(),
    };

    expect(validateRetrievalSettings({ ...baseInput, customInstruction: "" })).toBeDefined();
    expect(validateRetrievalSettings({ ...baseInput, customInstruction: "Cite paragraph numbers" })).toBeDefined();
    expect(validateRetrievalSettings({ ...baseInput, customInstruction: "a".repeat(2000) })).toBeDefined();
  });

  it("uses the current chunking defaults for ingestion settings", () => {
    const defaults = defaultIngestionSettings("workspace-1");

    expect(defaults.chunkingStrategy).toBe("fixed_window");
    expect(defaults.fixedWindowChunkSize).toBe(800);
    expect(defaults.fixedWindowChunkOverlap).toBe(120);
    expect(defaults.structuredMinChunkSize).toBe(24);
    expect(defaults.structuredMaxChunkSize).toBe(220);
  });

  it("rejects ingestion settings when overlap is not smaller than chunk size", () => {
    expect(() =>
      validateIngestionSettings({
        chunkingStrategy: "fixed_window",
        fixedWindowChunkSize: 400,
        fixedWindowChunkOverlap: 400,
        structuredMinChunkSize: 24,
        structuredMaxChunkSize: 220,
      }),
    ).toThrow("fixedWindowChunkOverlap must be smaller than fixedWindowChunkSize");
  });

  it("rejects ingestion settings when structured minimum exceeds structured maximum", () => {
    expect(() =>
      validateIngestionSettings({
        chunkingStrategy: "structured_semantic",
        fixedWindowChunkSize: 800,
        fixedWindowChunkOverlap: 120,
        structuredMinChunkSize: 300,
        structuredMaxChunkSize: 200,
      }),
    ).toThrow("structuredMinChunkSize must be less than or equal to structuredMaxChunkSize");
  });

  it("uses configurable fixed-window chunk sizes", () => {
    const longText = "word ".repeat(300);
    const chunks = chunkMarkdown(longText, {
      chunkSize: 200,
      chunkOverlap: 20,
    });

    expect(chunks.length).toBeGreaterThan(1);
    expect(chunks[1].startOffset).toBe(chunks[0].endOffset - 20);
  });
});
