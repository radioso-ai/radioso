import { describe, expect, it } from "vitest";

import { DocumentProcessingService } from "../../src/modules/documents/services/documentProcessingService.js";
import { ChunkingStrategyRegistry } from "../../src/modules/retrieval/domain/chunking/chunkingStrategyRegistry.js";
import { FixedWindowChunkingStrategy } from "../../src/modules/retrieval/domain/chunking/fixedWindowChunkingStrategy.js";
import {
  DOCUMENT_ATTRIBUTE_LIMITS,
  extractLeadingDocumentAttributes,
  readDocumentAttributes,
  withDocumentAttributes,
} from "../../src/modules/retrieval/domain/documentAttributes.js";
import type { FinalPromptContext } from "../../src/modules/retrieval/domain/retrievalPipelineTypes.js";
import { PromptBuilder } from "../../src/modules/retrieval/services/promptBuilder.js";
import {
  renderMetadataPromptText,
  renderMetadataSearchText,
  renderSearchText,
} from "../../src/modules/retrieval/services/searchTextRenderer.js";
import { RETRIEVAL_BEHAVIOR } from "../../src/shared/domain/behaviorConfig.js";
import { defaultIngestionSettings } from "../../src/modules/settings/domain/ingestionSettings.js";
import { propertyCorpus } from "../fixtures/document-attributes/propertyCorpus.js";
import { createDocumentEmbeddingPort } from "../support/embeddingPorts.js";
import { createAuditService, InMemoryChunkRepository, InMemoryDocumentRepository } from "../support/fakes.js";

/** OpenAI's embedding models take at most 8,192 tokens per input; a token is at least one character of Latin text. */
const EMBEDDING_INPUT_TOKEN_LIMIT = 8_192;

describe("leading document attributes", () => {
  it("lifts a Markdown list of bold labels that opens the document", () => {
    expect(extractLeadingDocumentAttributes(propertyCorpus[0].markdown)).toEqual([
      { label: "Property id", value: "fixture-p1" },
      { label: "Region", value: "Umbria" },
      { label: "Type", value: "Farmhouse" },
      { label: "Architectural style", value: "Rural stone" },
      { label: "Film crew capacity", value: "up to 30 crew; base camp for 4 vehicles" },
    ]);
  });

  it("lifts plain label lines, including ones separated by blank lines", () => {
    const markdown = "Region: Umbria\n\nType: Farmhouse\n\n**Size**: 420 m²\n\nThe house sits on a ridge.";

    expect(extractLeadingDocumentAttributes(markdown)).toEqual([
      { label: "Region", value: "Umbria" },
      { label: "Type", value: "Farmhouse" },
      { label: "Size", value: "420 m²" },
    ]);
  });

  it("lifts labels written in any script, with a full-width colon too", () => {
    const markdown = "# 古い農家\n\n- 地域：ウンブリア\n- 種類: 農家\n\n丘の上に立っている。";

    expect(extractLeadingDocumentAttributes(markdown)).toEqual([
      { label: "地域", value: "ウンブリア" },
      { label: "種類", value: "農家" },
    ]);
  });

  it("lifts the scalar keys of front matter and then a leading block", () => {
    const markdown = [
      "---",
      "region: Umbria",
      "type: \"Farmhouse\"",
      "tags: [stone, rural]",
      "location:",
      "  lat: 43.1",
      "description: |",
      "  A long text.",
      "---",
      "",
      "Era: 1890s",
      "Rooms: 5",
      "",
      "The house sits on a ridge.",
    ].join("\n");

    expect(extractLeadingDocumentAttributes(markdown)).toEqual([
      { label: "region", value: "Umbria" },
      { label: "type", value: "Farmhouse" },
      { label: "tags", value: "stone, rural" },
      { label: "Era", value: "1890s" },
      { label: "Rooms", value: "5" },
    ]);
  });

  it("finds nothing in a document that opens with prose", () => {
    const markdown = "# Villa\n\nThe villa sits on a cliff. Region: none of your business.\n\n- **Region:** Campania\n- **Type:** Villa";

    expect(extractLeadingDocumentAttributes(markdown)).toEqual([]);
  });

  it("does not take a single labelled line for a block", () => {
    expect(extractLeadingDocumentAttributes("Update: the pool is closed this winter.\n\nEverything else stays open.")).toEqual([]);
  });

  it("does not take addresses or clock times for labels", () => {
    expect(extractLeadingDocumentAttributes("https://example.com/villa\n10:30 arrival\n\nWelcome.")).toEqual([]);
  });

  it("stays within its limits on an oversized block", () => {
    const lines = Array.from({ length: 80 }, (_, index) => `- **Feature ${index + 1}:** ${"terracotta ".repeat(8).trim()}`);
    lines.splice(2, 0, `- **Notes:** ${"long ".repeat(200).trim()}`);
    const attributes = extractLeadingDocumentAttributes(`${lines.join("\n")}\n\nBody text.`);

    expect(attributes.length).toBeGreaterThan(1);
    expect(attributes.length).toBeLessThanOrEqual(DOCUMENT_ATTRIBUTE_LIMITS.maxEntries);
    expect(attributes.some((attribute) => attribute.label === "Notes")).toBe(false);
    expect(renderMetadataPromptText(withDocumentAttributes({}, attributes)).length)
      .toBeLessThanOrEqual(DOCUMENT_ATTRIBUTE_LIMITS.maxRenderedChars);
  });

  it("reads only well-formed attributes back from chunk metadata", () => {
    expect(readDocumentAttributes({ documentAttributes: "Region: Umbria" })).toEqual([]);
    expect(readDocumentAttributes({ documentAttributes: [{ label: "Region", value: "Umbria" }, { label: 3 }, null] }))
      .toEqual([{ label: "Region", value: "Umbria" }]);
    expect(readDocumentAttributes(undefined)).toEqual([]);
  });

  it("leaves chunk metadata untouched when the document has no attributes", () => {
    const metadata = { sourceUrl: "https://example.com/villa" };

    expect(withDocumentAttributes(metadata, [])).toBe(metadata);
  });
});

describe("document attributes in search text and the answer prompt", () => {
  const attributes = [
    { label: "Region", value: "Umbria" },
    { label: "Type", value: "Farmhouse" },
  ];

  it("renders the attributes into a chunk's search text and its prompt attributes", () => {
    const metadata = withDocumentAttributes({ author: "Archive team" }, attributes);

    expect(renderMetadataSearchText(metadata)).toBe("Author: Archive team | Region: Umbria | Type: Farmhouse");
    expect(renderMetadataPromptText(metadata)).toBe("Author: Archive team | Region: Umbria | Type: Farmhouse");
  });

  it("shows the answer a later chunk's region even though its text never names it", () => {
    const laterChunk: FinalPromptContext = {
      chunkId: "chunk-3",
      documentId: "document-1",
      title: "fixture-p1 Podere Selvalunga",
      content: "Behind the barn there is a lavender drying loft with open timber sides.",
      chunkIndex: 3,
      metadata: withDocumentAttributes({}, attributes),
      similarity: 0.8,
      retrievalSources: ["semantic_original"],
      retrievalText: "",
      semanticScore: 0.8,
      lexicalScore: 0,
      relevanceScore: 0.8,
      rerankPosition: 0,
      promptPosition: 0,
      estimatedTokenCost: 20,
    };

    const { prompt } = new PromptBuilder().build({
      query: "Which region is the lavender loft in?",
      history: [],
      contexts: [laterChunk],
      timeZone: "UTC",
      settings: {},
    });

    expect(prompt).toContain(
      "Result 1 (fixture-p1 Podere Selvalunga): Attributes: Region: Umbria | Type: Farmhouse\nBehind the barn",
    );
  });

  it("keeps a full-size chunk with the most attributes inside the embedding input limit", () => {
    const attributesAtLimit = extractLeadingDocumentAttributes(
      Array.from({ length: 80 }, (_, index) => `- **Feature label ${index + 1}:** ${"x".repeat(DOCUMENT_ATTRIBUTE_LIMITS.maxValueChars)}`).join("\n"),
    );
    const searchText = renderSearchText({
      title: "t".repeat(300),
      subjectLabel: "s".repeat(300),
      sectionPath: "p".repeat(300),
      attributeText: renderMetadataSearchText(withDocumentAttributes({}, attributesAtLimit)),
      content: "w".repeat(RETRIEVAL_BEHAVIOR.chunking.fixedWindowChunkSizeMax),
    });

    expect(attributesAtLimit.length).toBeGreaterThan(0);
    expect(searchText.length).toBeLessThan(EMBEDDING_INPUT_TOKEN_LIMIT);
  });
});

describe("document processing carries the document's attributes to every chunk", () => {
  it("stamps the leading attributes on each chunk and embeds them with it", async () => {
    const property = propertyCorpus[0];
    const documentRepository = new InMemoryDocumentRepository();
    const chunkRepository = new InMemoryChunkRepository(documentRepository);
    const embeddedTexts: string[] = [];
    const document = await documentRepository.create({
      workspaceId: "workspace-1",
      title: property.title,
      sourceContent: property.markdown,
      markdownContent: property.markdown,
      status: "queued",
      metadata: { sourceUrl: "https://catalogue.example/fixture-p1" },
    });
    const service = new DocumentProcessingService(
      documentRepository,
      chunkRepository,
      createDocumentEmbeddingPort({
        async embedTexts(texts: string[]): Promise<number[][]> {
          embeddedTexts.push(...texts);
          return texts.map(() => [1, 2, 3]);
        },
      }),
      createAuditService(),
      { getForWorkspace: async (workspaceId: string) => defaultIngestionSettings(workspaceId) },
      new ChunkingStrategyRegistry([new FixedWindowChunkingStrategy()]),
    );

    const outcome = await service.process({
      id: "job-1",
      documentId: document.id,
      workspaceId: "workspace-1",
      documentRevision: document.revision,
      kind: "vectorize",
      status: "processing",
      attemptCount: 1,
      lastError: null,
      availableAt: new Date(),
      claimedAt: new Date(),
      completedAt: null,
      createdAt: new Date(),
      updatedAt: new Date(),
    });

    expect(outcome).toBe("completed");
    const chunks = chunkRepository.items.get(document.id) ?? [];
    expect(chunks.length).toBeGreaterThan(2);
    const lastChunk = chunks.at(-1)!;
    expect(lastChunk.content).toContain(property.deepPhrase);
    expect(lastChunk.content).not.toContain("Umbria");
    for (const chunk of chunks) {
      expect(chunk.metadata).toMatchObject({ sourceUrl: "https://catalogue.example/fixture-p1" });
      expect(readDocumentAttributes(chunk.metadata)).toContainEqual({ label: "Region", value: "Umbria" });
      expect(chunk.searchText).toContain("Region: Umbria");
    }
    expect(embeddedTexts.every((text) => text.includes("Region: Umbria"))).toBe(true);
  });
});
