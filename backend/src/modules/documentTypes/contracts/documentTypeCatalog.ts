/**
 * Vocabulary and ports for the workspace document type catalog.
 *
 * The catalog is workspace settings data: operators declare the document types
 * metadata extraction classifies against and the fields to extract per type.
 * Built-in entries are system-owned and live in code; only their disabled flags
 * and the operator-authored types are persisted.
 */

/** Mirrors the metadata-rule value type enum so a declared field is filterable. */
export const documentTypeFieldValueTypes = ["string", "number", "date", "boolean"] as const;
export type DocumentTypeFieldValueType = (typeof documentTypeFieldValueTypes)[number];

export const isDocumentTypeFieldValueType = (value: unknown): value is DocumentTypeFieldValueType =>
  typeof value === "string" && (documentTypeFieldValueTypes as readonly string[]).includes(value);

export type DocumentTypeOrigin = "built_in" | "operator";

/**
 * Which payload the model returns for a matched type. Built-in temporal types
 * keep the `facts` contract; operator types return an ordered `fields` array;
 * classification-only types carry nothing.
 */
export type DocumentTypePayloadKind = "facts" | "fields" | "none";

export interface DocumentTypeFieldDefinition {
  readonly key: string;
  readonly label: string;
  readonly valueType: DocumentTypeFieldValueType;
  readonly instruction: string;
}

export interface OperatorDocumentTypeDefinition {
  readonly key: string;
  readonly label: string;
  readonly description: string;
  readonly enabled: boolean;
  readonly fields: readonly DocumentTypeFieldDefinition[];
}

/** A catalog entry as read: built-ins and operator types share one shape. */
export interface DocumentTypeDefinition extends OperatorDocumentTypeDefinition {
  readonly origin: DocumentTypeOrigin;
  readonly payload: DocumentTypePayloadKind;
  /** Built-in entries are read-only and `generic` can never be disabled. */
  readonly disableable: boolean;
}

/**
 * A deleted field key, kept forever with the value type it was created under.
 * A key can only ever be recreated with its original value type, so a saved
 * retrieval rule can never end up pointing at a differently typed field.
 */
export interface RetiredDocumentTypeFieldIdentity {
  readonly key: string;
  readonly valueType: DocumentTypeFieldValueType;
}

/** The persisted, operator-owned slice of a workspace catalog. */
export interface DocumentTypeCatalogRecord {
  readonly workspaceId: string;
  readonly revision: string;
  readonly types: readonly OperatorDocumentTypeDefinition[];
  readonly retiredFields: readonly RetiredDocumentTypeFieldIdentity[];
  readonly disabledBuiltInTypeKeys: readonly string[];
}

/** The operator-facing catalog: built-ins merged with operator types. */
export interface DocumentTypeCatalog {
  readonly workspaceId: string;
  readonly revision: string;
  readonly types: readonly DocumentTypeDefinition[];
  readonly retiredFields: readonly RetiredDocumentTypeFieldIdentity[];
}

/** Conditional-write payload: the whole operator-owned catalog, plus the revision it was based on. */
export interface DocumentTypeCatalogWriteInput {
  readonly expectedRevision: string;
  readonly types: readonly OperatorDocumentTypeDefinition[];
  readonly disabledBuiltInTypeKeys: readonly string[];
}

/** Narrow read port consumed by enrichment: enabled types plus the revision they came from. */
export interface EnabledDocumentTypesSnapshot {
  readonly revision: string;
  readonly types: readonly DocumentTypeDefinition[];
}

export interface DocumentTypeCatalogReaderPort {
  listEnabledTypes(workspaceId: string): Promise<EnabledDocumentTypesSnapshot>;
}

export interface DocumentTypeCatalogRepositoryPort {
  findByWorkspaceId(workspaceId: string): Promise<DocumentTypeCatalogRecord | null>;
  /** Conditional write; resolves `null` when `expectedRevision` is stale. */
  save(input: {
    workspaceId: string;
    expectedRevision: string;
    types: readonly OperatorDocumentTypeDefinition[];
    retiredFields: readonly RetiredDocumentTypeFieldIdentity[];
    disabledBuiltInTypeKeys: readonly string[];
  }): Promise<DocumentTypeCatalogRecord | null>;
}

/** A workspace with no persisted row reads as the default catalog at this revision. */
export const DEFAULT_DOCUMENT_TYPE_CATALOG_REVISION = "1";

export const defaultDocumentTypeCatalogRecord = (workspaceId: string): DocumentTypeCatalogRecord => ({
  workspaceId,
  revision: DEFAULT_DOCUMENT_TYPE_CATALOG_REVISION,
  types: [],
  retiredFields: [],
  disabledBuiltInTypeKeys: [],
});
