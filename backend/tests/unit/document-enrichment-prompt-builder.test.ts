import { describe, expect, it } from "vitest";

import type { DocumentTypeDefinition } from "../../src/modules/documentTypes/contracts/documentTypeCatalog.js";
import { builtInDocumentTypes } from "../../src/modules/documentTypes/domain/builtInDocumentTypes.js";
import { DOCUMENT_TYPE_CATALOG_PROMPT_BUDGET } from "../../src/modules/documentTypes/domain/documentTypeCatalogPrompt.js";
import { buildDocumentEnrichmentPrompt } from "../../src/modules/documents/domain/enrichment/enrichmentPromptBuilder.js";
import { loadPromptTemplate } from "../../src/shared/infra/prompts/promptLoader.js";

const template = () => loadPromptTemplate("ingestion/document-enrichment.md");

const enabledBuiltIns = (): DocumentTypeDefinition[] => builtInDocumentTypes.map((type) => ({ ...type }));

const productType: DocumentTypeDefinition = {
  key: "product",
  label: "Product",
  description: "A product detail page listing a purchasable item.",
  enabled: true,
  origin: "operator",
  payload: "fields",
  disableable: true,
  fields: [{ key: "price", label: "Price", valueType: "number", instruction: "The listed price as a number." }],
};

describe("document enrichment prompt builder", () => {
  it("renders the default catalog into the shipped template", () => {
    const prompt = buildDocumentEnrichmentPrompt({ template: template(), types: enabledBuiltIns() });

    expect(prompt).not.toContain("{{");
    expect(prompt).toContain('"event" | "article" | "profile" | "reference" | "generic"');
    expect(prompt).toContain(
      "Use `event` for event announcements, `article` for dated articles, `profile` for people or organizations, `reference` for stable reference material, and `generic` when uncertain.",
    );
    // The temporal instructions are untouched by the catalog.
    expect(prompt).toContain("For temporal facts");
  });

  it("adds operator types to the key union and the catalog section", () => {
    const prompt = buildDocumentEnrichmentPrompt({
      template: template(),
      types: [...enabledBuiltIns(), productType],
    });

    expect(prompt).toContain('"generic" | "product"');
    expect(prompt).toContain("A product detail page listing a purchasable item.");
    expect(prompt).toContain("`price` (number)");
  });

  it("drops a disabled built-in type from the key union", () => {
    const prompt = buildDocumentEnrichmentPrompt({
      template: template(),
      types: enabledBuiltIns().filter((type) => type.key !== "profile"),
    });

    expect(prompt).not.toContain('"profile"');
  });

  it("refuses to render a catalog beyond the prompt budget instead of truncating", () => {
    const oversized: DocumentTypeDefinition = {
      ...productType,
      description: "d".repeat(DOCUMENT_TYPE_CATALOG_PROMPT_BUDGET + 1),
    };

    expect(() => buildDocumentEnrichmentPrompt({ template: template(), types: [...enabledBuiltIns(), oversized] }))
      .toThrowError("enrichment_catalog_over_budget");
  });
});
