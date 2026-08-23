import {
  isDocumentTypeFieldValueType,
  type DocumentTypeCatalog,
  type DocumentTypeCatalogRecord,
  type DocumentTypeDefinition,
  type DocumentTypeFieldDefinition,
  type EnabledDocumentTypesSnapshot,
  type OperatorDocumentTypeDefinition,
  type RetiredDocumentTypeFieldIdentity,
} from "../contracts/documentTypeCatalog.js";
import { builtInDocumentTypes } from "./builtInDocumentTypes.js";

/**
 * Merges the system-owned built-in entries with the operator-authored types.
 * Built-ins keep their code-owned definition; only their disabled flag comes
 * from the persisted row, and `promptClause` stays out of the read model.
 */
export const toDocumentTypeDefinitions = (input: {
  types: readonly OperatorDocumentTypeDefinition[];
  disabledBuiltInTypeKeys: readonly string[];
}): DocumentTypeDefinition[] => {
  const disabled = new Set(input.disabledBuiltInTypeKeys);
  const builtIns: DocumentTypeDefinition[] = builtInDocumentTypes.map((type) => ({
    key: type.key,
    label: type.label,
    description: type.description,
    enabled: type.disableable ? !disabled.has(type.key) : true,
    origin: "built_in",
    payload: type.payload,
    disableable: type.disableable,
    fields: type.fields.map((field) => ({ ...field })),
  }));

  const operatorTypes: DocumentTypeDefinition[] = input.types.map((type) => ({
    key: type.key,
    label: type.label,
    description: type.description,
    enabled: type.enabled,
    origin: "operator",
    payload: "fields",
    disableable: true,
    fields: type.fields.map((field) => ({ ...field })),
  }));

  return [...builtIns, ...operatorTypes];
};

export const mergeDocumentTypeCatalog = (record: DocumentTypeCatalogRecord): DocumentTypeCatalog => ({
  workspaceId: record.workspaceId,
  revision: record.revision,
  types: toDocumentTypeDefinitions(record),
  retiredFields: record.retiredFields.map((identity) => ({ ...identity })),
});

/**
 * Every field key the catalog declares, deduplicated. Field keys share one
 * workspace-wide typed namespace, so the first declaration of a key settles its
 * value type — the catalog rejects a save where two declarations disagree.
 */
export const toDeclaredMetadataFields = (
  record: DocumentTypeCatalogRecord,
): { key: string; valueType: DocumentTypeFieldDefinition["valueType"] }[] => {
  const declared = new Map<string, DocumentTypeFieldDefinition["valueType"]>();
  for (const type of toDocumentTypeDefinitions(record)) {
    for (const field of type.fields) {
      if (!declared.has(field.key)) {
        declared.set(field.key, field.valueType);
      }
    }
  }
  return [...declared.entries()].map(([key, valueType]) => ({ key, valueType }));
};

/** The narrow view enrichment consumes: enabled types plus the revision they came from. */
export const toEnabledDocumentTypesSnapshot = (
  record: DocumentTypeCatalogRecord,
): EnabledDocumentTypesSnapshot => ({
  revision: record.revision,
  types: toDocumentTypeDefinitions(record).filter((type) => type.enabled),
});

const parseFields = (value: unknown): DocumentTypeFieldDefinition[] => {
  if (!Array.isArray(value)) {
    return [];
  }
  const fields: DocumentTypeFieldDefinition[] = [];
  for (const entry of value) {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
      continue;
    }
    const candidate = entry as Record<string, unknown>;
    if (typeof candidate.key !== "string" || !isDocumentTypeFieldValueType(candidate.valueType)) {
      continue;
    }
    fields.push({
      key: candidate.key,
      label: typeof candidate.label === "string" ? candidate.label : candidate.key,
      valueType: candidate.valueType,
      instruction: typeof candidate.instruction === "string" ? candidate.instruction : "",
    });
  }
  return fields;
};

/** Reads the persisted JSONB defensively: the column is schema-less, so a malformed row degrades instead of failing every read. */
export const parseOperatorDocumentTypes = (value: unknown): OperatorDocumentTypeDefinition[] => {
  if (!Array.isArray(value)) {
    return [];
  }
  const types: OperatorDocumentTypeDefinition[] = [];
  for (const entry of value) {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
      continue;
    }
    const candidate = entry as Record<string, unknown>;
    if (typeof candidate.key !== "string") {
      continue;
    }
    types.push({
      key: candidate.key,
      label: typeof candidate.label === "string" ? candidate.label : candidate.key,
      description: typeof candidate.description === "string" ? candidate.description : "",
      enabled: candidate.enabled !== false,
      fields: parseFields(candidate.fields),
    });
  }
  return types;
};

export const parseRetiredDocumentTypeFields = (value: unknown): RetiredDocumentTypeFieldIdentity[] => {
  if (!Array.isArray(value)) {
    return [];
  }
  const identities: RetiredDocumentTypeFieldIdentity[] = [];
  for (const entry of value) {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
      continue;
    }
    const candidate = entry as Record<string, unknown>;
    if (typeof candidate.key === "string" && isDocumentTypeFieldValueType(candidate.valueType)) {
      identities.push({ key: candidate.key, valueType: candidate.valueType });
    }
  }
  return identities;
};

export const parseDisabledBuiltInTypeKeys = (value: unknown): string[] => {
  if (!Array.isArray(value)) {
    return [];
  }
  return value.filter((entry): entry is string => typeof entry === "string");
};
