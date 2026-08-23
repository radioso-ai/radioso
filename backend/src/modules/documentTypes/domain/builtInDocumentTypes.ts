import type {
  DocumentTypeDefinition,
  DocumentTypeFieldDefinition,
} from "../contracts/documentTypeCatalog.js";

/**
 * The shipped classification set, expressed as system-owned catalog entries.
 * These are read-only: operators can disable them (except `generic`) but never
 * edit their keys, labels, descriptions, or fields.
 */
export const GENERIC_DOCUMENT_TYPE_KEY = "generic";

/** Temporal keys the built-in strategies own; operator fields may never claim them. */
const temporalFields: readonly DocumentTypeFieldDefinition[] = [
  {
    key: "dateFrom",
    label: "Start date",
    valueType: "date",
    instruction: "The first day the document's dated subject covers.",
  },
  {
    key: "dateTo",
    label: "End date",
    valueType: "date",
    instruction: "The last day the document's dated subject covers.",
  },
];

interface BuiltInDocumentTypeDefinition extends DocumentTypeDefinition {
  readonly origin: "built_in";
  /**
   * The clause this entry contributes to the classification sentence. Held
   * separately from `description` so the rendered prompt for the default
   * catalog stays byte-identical to the shipped one.
   */
  readonly promptClause: string;
}

export const builtInDocumentTypes: readonly BuiltInDocumentTypeDefinition[] = [
  {
    key: "event",
    label: "Event",
    description: "Event announcements — anything scheduled on a date or a date range.",
    enabled: true,
    origin: "built_in",
    payload: "facts",
    disableable: true,
    fields: temporalFields,
    promptClause: "`event` for event announcements",
  },
  {
    key: "article",
    label: "Article",
    description: "Dated articles — news, posts, and releases carrying a publication date.",
    enabled: true,
    origin: "built_in",
    payload: "facts",
    disableable: true,
    fields: temporalFields,
    promptClause: "`article` for dated articles",
  },
  {
    key: "profile",
    label: "Profile",
    description: "People or organizations.",
    enabled: true,
    origin: "built_in",
    payload: "none",
    disableable: true,
    fields: [],
    promptClause: "`profile` for people or organizations",
  },
  {
    key: "reference",
    label: "Reference",
    description: "Stable reference material.",
    enabled: true,
    origin: "built_in",
    payload: "none",
    disableable: true,
    fields: [],
    promptClause: "`reference` for stable reference material",
  },
  {
    key: GENERIC_DOCUMENT_TYPE_KEY,
    label: "Generic",
    description: "The reserved fallback for documents that match no other type.",
    enabled: true,
    origin: "built_in",
    payload: "none",
    disableable: false,
    fields: [],
    promptClause: "`generic` when uncertain",
  },
];

export const builtInDocumentTypeKeys: readonly string[] = builtInDocumentTypes.map((type) => type.key);

export const isBuiltInDocumentTypeKey = (key: string): boolean => builtInDocumentTypeKeys.includes(key);

/** Keys the built-in strategies write; reserved against operator field declarations. */
export const reservedDocumentTypeFieldKeys: readonly string[] = [
  ...new Set(builtInDocumentTypes.flatMap((type) => type.fields.map((field) => field.key))),
];

export const isReservedDocumentTypeFieldKey = (key: string): boolean =>
  reservedDocumentTypeFieldKeys.includes(key);

export const builtInPromptClause = (key: string): string | null =>
  builtInDocumentTypes.find((type) => type.key === key)?.promptClause ?? null;
