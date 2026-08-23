import { describe, expect, it } from "vitest";

import type { DocumentTypeDefinition } from "../../../src/modules/documentTypes/contracts/documentTypeCatalog.js";
import { builtInDocumentTypes } from "../../../src/modules/documentTypes/domain/builtInDocumentTypes.js";
import {
  DOCUMENT_TYPE_CATALOG_PROMPT_BUDGET,
  renderDocumentTypeCatalogSection,
} from "../../../src/modules/documentTypes/domain/documentTypeCatalogPrompt.js";

// The shipped classification sentence. Rendering the default catalog must
// reproduce it exactly, so an empty operator catalog leaves the enrichment
// prompt byte-identical to the one in backend/prompts/ingestion.
const SHIPPED_CLASSIFICATION_SENTENCE =
  "Use `event` for event announcements, `article` for dated articles, `profile` for people or organizations, `reference` for stable reference material, and `generic` when uncertain.";

const enabledBuiltIns = (): DocumentTypeDefinition[] => builtInDocumentTypes.map((type) => ({ ...type }));

const productType: DocumentTypeDefinition = {
  key: "product",
  label: "Product",
  description: "A product detail page listing a purchasable item.",
  enabled: true,
  origin: "operator",
  payload: "fields",
  disableable: true,
  fields: [
    { key: "productName", label: "Product name", valueType: "string", instruction: "The product's display name." },
    { key: "price", label: "Price", valueType: "number", instruction: "The listed price as a number." },
  ],
};

describe("document type catalog prompt section", () => {
  it("renders the shipped classification sentence for the default catalog", () => {
    expect(renderDocumentTypeCatalogSection(enabledBuiltIns())).toBe(SHIPPED_CLASSIFICATION_SENTENCE);
  });

  it("omits a disabled built-in type from the classification sentence", () => {
    const withoutProfile = enabledBuiltIns().filter((type) => type.key !== "profile");

    const rendered = renderDocumentTypeCatalogSection(withoutProfile);

    expect(rendered).not.toContain("profile");
    expect(rendered).toContain("`event` for event announcements");
    expect(rendered).toContain("`generic` when uncertain");
  });

  it("renders operator types with their description, fields, value types, and instructions", () => {
    const rendered = renderDocumentTypeCatalogSection([...enabledBuiltIns(), productType]);

    expect(rendered).toContain(SHIPPED_CLASSIFICATION_SENTENCE);
    expect(rendered).toContain("product");
    expect(rendered).toContain("A product detail page listing a purchasable item.");
    expect(rendered).toContain("productName");
    expect(rendered).toContain("(string)");
    expect(rendered).toContain("The product's display name.");
    expect(rendered).toContain("price");
    expect(rendered).toContain("(number)");
  });

  it("explains the fields payload only when operator types exist", () => {
    expect(renderDocumentTypeCatalogSection(enabledBuiltIns())).not.toContain("\"fields\"");
    expect(renderDocumentTypeCatalogSection([...enabledBuiltIns(), productType])).toContain("\"fields\"");
  });

  it("renders a single-clause sentence without a list separator", () => {
    const genericOnly = enabledBuiltIns().filter((type) => type.key === "generic");

    expect(renderDocumentTypeCatalogSection(genericOnly)).toBe("Use `generic` when uncertain.");
  });

  it("exposes the rendered prompt budget", () => {
    expect(DOCUMENT_TYPE_CATALOG_PROMPT_BUDGET).toBe(12_000);
  });
});
