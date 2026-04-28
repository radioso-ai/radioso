import { describe, expect, it } from "vitest";

import { chunkMarkdown } from "../../src/modules/retrieval/domain/chunkingService.js";
import {
  defaultIngestionSettings,
  validateIngestionSettings,
} from "../../src/modules/settings/domain/ingestionSettings.js";
import {
  type RetrievalSettingsInput,
  defaultRetrievalSettings,
  createDefaultMetadataRule,
  validateRetrievalSettings,
} from "../../src/modules/settings/domain/retrievalSettings.js";

describe("settings and chunking", () => {
  it("rejects invalid retrieval settings", () => {
    expect(() =>
      validateRetrievalSettings({
        queryRewriteEnabled: false,
        semanticRewriteInstructions: "",
        lexicalRewriteInstructions: "",
        conversationMode: "guided",
        suggestedQuestionsEnabled: true,
        suggestedQuestionsCount: 3,
        rerankEnabled: false,
        vectorTopK: 0,
        similarityThreshold: 0.2,
        rerankTopK: 5,
        citationDisplayEnabled: true,
        metadataRules: [],
        customInstruction: "",
      }),
    ).toThrow("vectorTopK must be between 1 and 300");
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
    const metadataRule = {
      ...createDefaultMetadataRule(),
      field: "",
    };

    expect(() =>
      validateRetrievalSettings({
        queryRewriteEnabled: false,
        semanticRewriteInstructions: "",
        lexicalRewriteInstructions: "",
        conversationMode: "guided",
        suggestedQuestionsEnabled: true,
        suggestedQuestionsCount: 3,
        rerankEnabled: false,
        vectorTopK: 15,
        similarityThreshold: 0.2,
        rerankTopK: 5,
        citationDisplayEnabled: true,
        metadataRules: [metadataRule],
        customInstruction: "",
      }),
    ).toThrow("metadataRules field must be a non-empty string");
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
    expect(defaults.citationDisplayEnabled).toBe(true);
    expect(defaults.metadataRules).toEqual([]);
    expect(defaults.customInstruction).toBe("");
    expect(defaults.semanticRewriteInstructions).not.toBe("");
    expect(defaults.lexicalRewriteInstructions).not.toBe("");
    expect(defaults.conversationMode).toBe("guided");
    expect(defaults.suggestedQuestionsEnabled).toBe(true);
    expect(defaults.suggestedQuestionsCount).toBe(3);
  });

  it("rejects customInstruction exceeding 2000 characters", () => {
    const metadataRule = {
      ...createDefaultMetadataRule(),
      field: "language",
      value: "en",
    };

    expect(() =>
      validateRetrievalSettings({
        queryRewriteEnabled: false,
        semanticRewriteInstructions: "",
        lexicalRewriteInstructions: "",
        conversationMode: "guided",
        suggestedQuestionsEnabled: true,
        suggestedQuestionsCount: 3,
        rerankEnabled: false,
        vectorTopK: 15,
        similarityThreshold: 0.2,
        rerankTopK: 5,
        citationDisplayEnabled: true,
        metadataRules: [metadataRule],
        customInstruction: "a".repeat(2001),
      }),
    ).toThrow("customInstruction must not exceed 2000 characters");
  });

  it("accepts valid customInstruction values", () => {
    const metadataRule = {
      ...createDefaultMetadataRule(),
      field: "language",
      value: "en",
    };
    const baseInput: Omit<RetrievalSettingsInput, "customInstruction"> = {
      queryRewriteEnabled: false,
      semanticRewriteInstructions: "",
      lexicalRewriteInstructions: "",
      conversationMode: "guided",
      suggestedQuestionsEnabled: true,
      suggestedQuestionsCount: 3,
      rerankEnabled: false,
      vectorTopK: 15,
      similarityThreshold: 0.2,
      rerankTopK: 5,
      citationDisplayEnabled: true,
      metadataRules: [metadataRule],
    };

    expect(validateRetrievalSettings({ ...baseInput, customInstruction: "" })).toBeDefined();
    expect(validateRetrievalSettings({ ...baseInput, customInstruction: "Cite paragraph numbers" })).toBeDefined();
    expect(validateRetrievalSettings({ ...baseInput, customInstruction: "a".repeat(2000) })).toBeDefined();
  });

  it("falls back to safe rewrite instructions when blank values are provided", () => {
    const normalized = validateRetrievalSettings({
      queryRewriteEnabled: true,
      semanticRewriteInstructions: "   ",
      lexicalRewriteInstructions: "",
      conversationMode: "guided",
      suggestedQuestionsEnabled: true,
      suggestedQuestionsCount: 3,
      rerankEnabled: false,
      vectorTopK: 15,
      similarityThreshold: 0.2,
      rerankTopK: 5,
      citationDisplayEnabled: true,
      metadataRules: [],
      customInstruction: "",
    });

    expect(normalized.semanticRewriteInstructions).not.toBe("");
    expect(normalized.lexicalRewriteInstructions).not.toBe("");
  });

  it("rejects unsupported settings values", () => {
    expect(() =>
      validateRetrievalSettings({
        queryRewriteEnabled: false,
        semanticRewriteInstructions: "",
        lexicalRewriteInstructions: "",
        conversationMode: "guided",
        suggestedQuestionsEnabled: true,
        suggestedQuestionsCount: 3,
        rerankEnabled: false,
        vectorTopK: 15,
        similarityThreshold: 0.2,
        rerankTopK: 5,
        citationDisplayEnabled: true,
        metadataRules: [],
        customInstruction: "",
      }),
    ).toThrow();
  });

  it("rejects unsupported conversationMode values", () => {
    expect(() =>
      validateRetrievalSettings({
        queryRewriteEnabled: false,
        semanticRewriteInstructions: "",
        lexicalRewriteInstructions: "",
        conversationMode: "invalid" as never,
        suggestedQuestionsEnabled: true,
        suggestedQuestionsCount: 3,
        rerankEnabled: false,
        vectorTopK: 15,
        similarityThreshold: 0.2,
        rerankTopK: 5,
        citationDisplayEnabled: true,
        metadataRules: [],
        customInstruction: "",
      }),
    ).toThrow("conversationMode must be a supported value");
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

  it("adds discovered metadata signals as disabled policies by default", () => {
    const defaults = defaultRetrievalSettings("workspace-1");
    expect(defaults.metadataRules).toEqual([]);
  });

  it("rejects suggested question counts outside the supported range", () => {
    expect(() =>
      validateRetrievalSettings({
        queryRewriteEnabled: false,
        semanticRewriteInstructions: "",
        lexicalRewriteInstructions: "",
        conversationMode: "guided",
        suggestedQuestionsEnabled: true,
        suggestedQuestionsCount: 5,
        rerankEnabled: false,
        vectorTopK: 15,
        similarityThreshold: 0.2,
        rerankTopK: 5,
        citationDisplayEnabled: true,
        metadataRules: [],
        customInstruction: "",
      }),
    ).toThrow("suggestedQuestionsCount must be between 1 and 4");
  });

  it("accepts trigger-aware date rules that use today()", () => {
    const normalized = validateRetrievalSettings({
      queryRewriteEnabled: false,
      semanticRewriteInstructions: "",
      lexicalRewriteInstructions: "",
      conversationMode: "guided",
      suggestedQuestionsEnabled: true,
      suggestedQuestionsCount: 3,
      rerankEnabled: false,
      vectorTopK: 15,
      similarityThreshold: 0.2,
      rerankTopK: 5,
      citationDisplayEnabled: true,
      metadataRules: [
        {
          ...createDefaultMetadataRule(),
          field: "dateFrom",
          valueType: "date",
          operator: "gte",
          value: "today()",
          effect: "filter",
          triggerMode: "match_turn",
          triggerInstruction: "Enact when the user is clearly asking about upcoming events.",
        },
      ],
      customInstruction: "",
    });

    expect(normalized.metadataRules[0]).toMatchObject({
      field: "dateFrom",
      valueType: "date",
      operator: "gte",
      value: "today()",
      combinator: "and",
      effect: "filter",
      triggerMode: "match_turn",
      triggerInstruction: "Enact when the user is clearly asking about upcoming events.",
    });
  });

  it("accepts grouped metadata rule conditions", () => {
    const normalized = validateRetrievalSettings({
      queryRewriteEnabled: false,
      semanticRewriteInstructions: "",
      lexicalRewriteInstructions: "",
      conversationMode: "guided",
      suggestedQuestionsEnabled: true,
      suggestedQuestionsCount: 3,
      rerankEnabled: false,
      vectorTopK: 15,
      similarityThreshold: 0.2,
      rerankTopK: 5,
      citationDisplayEnabled: true,
      metadataRules: [
        {
          ...createDefaultMetadataRule(),
          field: "category",
          valueType: "string",
          operator: "equals",
          value: "event",
          combinator: "or",
          conditions: [
            {
              id: "condition-one",
              field: "category",
              valueType: "string",
              operator: "equals",
              value: "event",
            },
            {
              id: "condition-two",
              field: "language",
              valueType: "string",
              operator: "equals",
              value: "en",
            },
          ],
        },
      ],
      customInstruction: "",
    });

    expect(normalized.metadataRules[0]?.conditions).toHaveLength(2);
    expect(normalized.metadataRules[0]?.combinator).toBe("or");
    expect(normalized.metadataRules[0]).toMatchObject({
      field: "category",
      valueType: "string",
      operator: "equals",
      value: "event",
    });
  });

  it("rejects today() outside supported date comparisons", () => {
    expect(() =>
      validateRetrievalSettings({
        queryRewriteEnabled: false,
        semanticRewriteInstructions: "",
        lexicalRewriteInstructions: "",
        conversationMode: "guided",
        suggestedQuestionsEnabled: true,
        suggestedQuestionsCount: 3,
        rerankEnabled: false,
        vectorTopK: 15,
        similarityThreshold: 0.2,
        rerankTopK: 5,
        citationDisplayEnabled: true,
        metadataRules: [
          {
            ...createDefaultMetadataRule(),
            field: "title",
            valueType: "string",
            operator: "equals",
            value: "today()",
          },
        ],
        customInstruction: "",
      }),
    ).toThrow("metadataRules dynamic date tokens are supported only for date values");
  });
});
