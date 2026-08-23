import {
  DOCUMENT_TYPE_CATALOG_PROMPT_BUDGET,
  renderDocumentTypeCatalogSection,
  renderDocumentTypeKeyUnion,
  type DocumentTypeDefinition,
} from "../../../documentTypes/public.js";

/** Raised when a persisted catalog drifts past the budget; extraction fails rather than truncating. */
export const ENRICHMENT_CATALOG_OVER_BUDGET = "enrichment_catalog_over_budget";

const interpolate = (template: string, variables: Record<string, string>): string =>
  template.replace(/\{\{([a-zA-Z0-9_]+)\}\}/g, (_match, key: string) => {
    if (!(key in variables)) {
      throw new Error(`Missing prompt variable "${key}" for the document enrichment template`);
    }
    return variables[key] ?? "";
  });

/**
 * Splices the enabled catalog into the classification template. Bounds are
 * enforced at save time, so a render over budget here means the persisted
 * catalog drifted — a content-free failure, never a silent truncation.
 */
export const buildDocumentEnrichmentPrompt = (input: {
  template: string;
  types: readonly DocumentTypeDefinition[];
}): string => {
  const section = renderDocumentTypeCatalogSection(input.types);
  if (section.length > DOCUMENT_TYPE_CATALOG_PROMPT_BUDGET) {
    throw new Error(ENRICHMENT_CATALOG_OVER_BUDGET);
  }

  return interpolate(input.template, {
    documentTypeKeys: renderDocumentTypeKeyUnion(input.types),
    documentTypeCatalog: section,
  });
};
