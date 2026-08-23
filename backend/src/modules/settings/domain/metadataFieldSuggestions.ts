import type { MetadataFieldSuggestion, MetadataValueType } from "./retrievalSettings.js";

/** A field key some catalog type declares, carrying the value type it was declared under. */
export interface DeclaredMetadataField {
  key: string;
  valueType: MetadataValueType;
}

/**
 * Field suggestions for the metadata-rule editor: everything the document type
 * catalog declares, plus every key already observed on document metadata.
 *
 * A declared key wins the value type on a collision. An observed value only
 * tells us how one hand-set string parsed; a declaration is what extraction
 * will actually write, and what a rule written against the key should compare.
 */
export const mergeMetadataFieldSuggestions = (
  declared: readonly DeclaredMetadataField[],
  observed: readonly MetadataFieldSuggestion[],
): MetadataFieldSuggestion[] => {
  const byField = new Map<string, MetadataValueType>();

  for (const suggestion of observed) {
    byField.set(suggestion.field, suggestion.inferredType);
  }
  // A key may be declared by several types; the catalog guarantees they agree,
  // so the first declaration settles it.
  const settled = new Set<string>();
  for (const field of declared) {
    if (settled.has(field.key)) {
      continue;
    }
    settled.add(field.key);
    byField.set(field.key, field.valueType);
  }

  return [...byField.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([field, inferredType]) => ({ field, inferredType }));
};
