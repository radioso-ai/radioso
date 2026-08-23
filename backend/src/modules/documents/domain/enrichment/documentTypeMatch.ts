import {
  DEFAULT_DOCUMENT_TYPE_CATALOG_REVISION,
  GENERIC_DOCUMENT_TYPE_KEY,
  toDocumentTypeDefinitions,
  type DocumentTypeDefinition,
  type EnabledDocumentTypesSnapshot,
} from "../../../documentTypes/public.js";
import { MIN_DOCUMENT_TYPE_CONFIDENCE } from "./documentEnrichmentContract.js";

/** The catalog a workspace classifies against before an operator touches it. */
export const defaultEnabledDocumentTypes = (): EnabledDocumentTypesSnapshot => ({
  revision: DEFAULT_DOCUMENT_TYPE_CATALOG_REVISION,
  types: toDocumentTypeDefinitions({ types: [], disabledBuiltInTypeKeys: [] }),
});

export interface MatchedDocumentType {
  /** The catalog entry that matched, or `null` when the run fell back to `generic`. */
  readonly type: DocumentTypeDefinition | null;
  readonly key: string;
  /** Content-free note explaining a fallback; `null` when the match was clean. */
  readonly note: string | null;
}

/**
 * Stage 1 of output validation: resolve the classification envelope against the
 * enabled catalog. Low confidence and unknown keys both degrade to `generic`
 * with no fields rather than failing the document.
 */
export const resolveMatchedDocumentType = (input: {
  types: readonly DocumentTypeDefinition[];
  typeKey: string;
  confidence: number;
}): MatchedDocumentType => {
  const fallback = input.types.find((type) => type.key === GENERIC_DOCUMENT_TYPE_KEY) ?? null;

  if (input.confidence < MIN_DOCUMENT_TYPE_CONFIDENCE || input.typeKey.length === 0) {
    return { type: fallback, key: GENERIC_DOCUMENT_TYPE_KEY, note: null };
  }

  const matched = input.types.find((type) => type.key === input.typeKey);
  if (!matched) {
    return { type: fallback, key: GENERIC_DOCUMENT_TYPE_KEY, note: "unknown_type" };
  }
  return { type: matched, key: matched.key, note: null };
};
