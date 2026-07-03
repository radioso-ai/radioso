import { describe, expect, it } from "vitest";

import { FixedWindowChunkingStrategy } from "../../src/modules/retrieval/domain/chunking/fixedWindowChunkingStrategy.js";
import { ChonkieChunkingProvider } from "../../src/modules/retrieval/infra/chonkieChunkingProvider.js";
import {
  defaultIngestionSettings,
  validateIngestionSettings,
} from "../../src/modules/settings/domain/ingestionSettings.js";
import {
  DEFAULT_LEXICAL_REWRITE_INSTRUCTIONS,
  DEFAULT_SEMANTIC_REWRITE_INSTRUCTIONS,
  type RetrievalSettingsInput,
  defaultRetrievalSettings,
  createDefaultMetadataRule,
  validateRetrievalSettings,
} from "../../src/modules/settings/domain/retrievalSettings.js";
import { loadPromptTemplate } from "../../src/shared/infra/prompts/promptLoader.js";

describe("settings and chunking", () => {
  it("rejects invalid retrieval settings", () => {
    expect(() =>
      validateRetrievalSettings({
        queryRewriteEnabled: false,
        semanticRewriteInstructions: "",
        lexicalRewriteInstructions: "",
        suggestedQuestionsEnabled: true,
        suggestedQuestionsCount: 3,
        rerankEnabled: false,
        vectorTopK: 0,
        similarityThreshold: 0.2,
        rerankTopK: 5,
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

  it("accepts recursive text as an ingestion chunking strategy", () => {
    expect(
      validateIngestionSettings({
        chunkingStrategy: "recursive_text",
        fixedWindowChunkSize: 800,
        fixedWindowChunkOverlap: 120,
        structuredMinChunkSize: 24,
        structuredMaxChunkSize: 220,
      }),
    ).toMatchObject({
      chunkingStrategy: "recursive_text",
    });
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
        suggestedQuestionsEnabled: true,
        suggestedQuestionsCount: 3,
        rerankEnabled: false,
        vectorTopK: 15,
        similarityThreshold: 0.2,
        rerankTopK: 5,
        metadataRules: [metadataRule],
        customInstruction: "",
      }),
    ).toThrow("metadataRules field must be a non-empty string");
  });

  it("creates overlapping fixed-window chunks through the provider", async () => {
    const longText = "word ".repeat(400);
    const strategy = new FixedWindowChunkingStrategy(new ChonkieChunkingProvider());
    const chunks = await strategy.chunk({
      title: "Long content",
      content: longText,
      config: {
        fixedWindowChunkSize: 800,
        fixedWindowChunkOverlap: 120,
        structuredMinChunkSize: 24,
        structuredMaxChunkSize: 220,
      },
    });

    expect(chunks.length).toBeGreaterThan(1);
    expect(chunks[1].startOffset).toBeLessThan(chunks[0].endOffset);
  });

  it("uses a modestly broader default candidate pool", () => {
    const defaults = defaultRetrievalSettings("workspace-1");

    expect(defaults.vectorTopK).toBe(15);
    expect(defaults.similarityThreshold).toBe(0.2);
    expect(defaults.metadataRules).toEqual([]);
    expect(defaults.customInstruction).toBe("");
    expect(defaults.semanticRewriteInstructions).not.toBe("");
    expect(defaults.lexicalRewriteInstructions).not.toBe("");
    expect(defaults.queryRewriteEnabled).toBe(true);
    expect(defaults.rerankEnabled).toBe(false);
    expect(defaults.suggestedQuestionsEnabled).toBe(true);
    expect(defaults.suggestedQuestionsCount).toBe(3);
  });

  it("loads default rewrite instructions from prompt markdown files", () => {
    const semanticPrompt = loadPromptTemplate("retrieval/semantic-rewrite-instructions.md");
    const lexicalPrompt = loadPromptTemplate("retrieval/lexical-rewrite-instructions.md");
    const defaults = defaultRetrievalSettings("workspace-1");

    expect(DEFAULT_SEMANTIC_REWRITE_INSTRUCTIONS).toBe(semanticPrompt);
    expect(DEFAULT_LEXICAL_REWRITE_INSTRUCTIONS).toBe(lexicalPrompt);
    expect(defaults.semanticRewriteInstructions).toBe(semanticPrompt);
    expect(defaults.lexicalRewriteInstructions).toBe(lexicalPrompt);
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
        suggestedQuestionsEnabled: true,
        suggestedQuestionsCount: 3,
        rerankEnabled: false,
        vectorTopK: 15,
        similarityThreshold: 0.2,
        rerankTopK: 5,
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
      suggestedQuestionsEnabled: true,
      suggestedQuestionsCount: 3,
      rerankEnabled: false,
      vectorTopK: 15,
      similarityThreshold: 0.2,
      rerankTopK: 5,
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
      suggestedQuestionsEnabled: true,
      suggestedQuestionsCount: 3,
      rerankEnabled: false,
      vectorTopK: 15,
      similarityThreshold: 0.2,
      rerankTopK: 5,
      metadataRules: [],
      customInstruction: "",
    });

    expect(normalized.semanticRewriteInstructions).toBe(
      loadPromptTemplate("retrieval/semantic-rewrite-instructions.md"),
    );
    expect(normalized.lexicalRewriteInstructions).toBe(
      loadPromptTemplate("retrieval/lexical-rewrite-instructions.md"),
    );
  });

  it("rejects invalid boolean settings values", () => {
    expect(() =>
      validateRetrievalSettings({
        queryRewriteEnabled: false,
        semanticRewriteInstructions: "",
        lexicalRewriteInstructions: "",
        suggestedQuestionsEnabled: "yes" as never,
        suggestedQuestionsCount: 3,
        rerankEnabled: false,
        vectorTopK: 15,
        similarityThreshold: 0.2,
        rerankTopK: 5,
        metadataRules: [],
        customInstruction: "",
      }),
    ).toThrow("suggestedQuestionsEnabled must be a boolean");
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

  it("uses configurable provider-backed fixed-window chunk sizes", async () => {
    const longText = "word ".repeat(300);
    const strategy = new FixedWindowChunkingStrategy(new ChonkieChunkingProvider());
    const chunks = await strategy.chunk({
      title: "Long content",
      content: longText,
      config: {
        fixedWindowChunkSize: 200,
        fixedWindowChunkOverlap: 20,
        structuredMinChunkSize: 24,
        structuredMaxChunkSize: 220,
      },
    });

    expect(chunks.length).toBeGreaterThan(1);
    expect(chunks[1].startOffset).toBeLessThan(chunks[0].endOffset);
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
        suggestedQuestionsEnabled: true,
        suggestedQuestionsCount: 5,
        rerankEnabled: false,
        vectorTopK: 15,
        similarityThreshold: 0.2,
        rerankTopK: 5,
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
      suggestedQuestionsEnabled: true,
      suggestedQuestionsCount: 3,
      rerankEnabled: false,
      vectorTopK: 15,
      similarityThreshold: 0.2,
      rerankTopK: 5,
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
      suggestedQuestionsEnabled: true,
      suggestedQuestionsCount: 3,
      rerankEnabled: false,
      vectorTopK: 15,
      similarityThreshold: 0.2,
      rerankTopK: 5,
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
        suggestedQuestionsEnabled: true,
        suggestedQuestionsCount: 3,
        rerankEnabled: false,
        vectorTopK: 15,
        similarityThreshold: 0.2,
        rerankTopK: 5,
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
