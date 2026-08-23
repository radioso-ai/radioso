import { badRequest } from "../../../shared/domain/errors.js";
import {
  isDocumentTypeFieldValueType,
  type DocumentTypeCatalogRecord,
  type DocumentTypeCatalogWriteInput,
  type DocumentTypeFieldDefinition,
  type DocumentTypeFieldValueType,
  type OperatorDocumentTypeDefinition,
  type RetiredDocumentTypeFieldIdentity,
} from "../contracts/documentTypeCatalog.js";
import {
  GENERIC_DOCUMENT_TYPE_KEY,
  builtInDocumentTypeKeys,
  isBuiltInDocumentTypeKey,
  isReservedDocumentTypeFieldKey,
} from "./builtInDocumentTypes.js";
import {
  DOCUMENT_TYPE_CATALOG_PROMPT_BUDGET,
  renderDocumentTypeCatalogSection,
} from "./documentTypeCatalogPrompt.js";
import { toDocumentTypeDefinitions } from "./documentTypeCatalogReadModel.js";

export const DOCUMENT_TYPE_CATALOG_LIMITS = {
  maxOperatorTypes: 20,
  maxFieldsPerType: 10,
  maxDescriptionChars: 500,
  maxInstructionChars: 240,
  maxLabelChars: 80,
  maxKeyChars: 64,
  maxRenderedPromptChars: DOCUMENT_TYPE_CATALOG_PROMPT_BUDGET,
} as const;

/**
 * Dots are prohibited on purpose: metadata-rule scoring reads `.` as a nested
 * path separator while extracted tags are written flat, so a dotted key would
 * declare a field no rule could ever match.
 */
export const DOCUMENT_TYPE_KEY_PATTERN = /^[A-Za-z][A-Za-z0-9_]{0,63}$/;

export interface ValidatedDocumentTypeCatalogWrite {
  readonly types: readonly OperatorDocumentTypeDefinition[];
  readonly disabledBuiltInTypeKeys: readonly string[];
  readonly retiredFields: readonly RetiredDocumentTypeFieldIdentity[];
}

const assertKey = (key: unknown, subject: string): string => {
  if (typeof key !== "string" || key.trim().length === 0) {
    throw badRequest(`${subject} key must not be empty.`);
  }
  if (!DOCUMENT_TYPE_KEY_PATTERN.test(key)) {
    throw badRequest(
      `${subject} key "${key}" must be at most ${DOCUMENT_TYPE_CATALOG_LIMITS.maxKeyChars} characters, start with a letter, and contain only letters, digits, and underscores.`,
    );
  }
  return key;
};

const assertText = (value: unknown, subject: string, maxChars: number, required: boolean): string => {
  if (typeof value !== "string" || value.trim().length === 0) {
    if (required) {
      throw badRequest(`${subject} must not be empty.`);
    }
    return "";
  }
  if (value.length > maxChars) {
    throw badRequest(`${subject} must be at most ${maxChars} characters.`);
  }
  return value;
};

const validateField = (
  field: DocumentTypeFieldDefinition,
  typeKey: string,
): DocumentTypeFieldDefinition => {
  const key = assertKey(field?.key, "Field");
  if (isReservedDocumentTypeFieldKey(key)) {
    throw badRequest(`Field key "${key}" is reserved by a built-in document type.`);
  }
  if (!isDocumentTypeFieldValueType(field?.valueType)) {
    throw badRequest(`Field "${key}" must declare a value type of string, number, date, or boolean.`);
  }
  return {
    key,
    label: assertText(field.label, `Label for field "${key}"`, DOCUMENT_TYPE_CATALOG_LIMITS.maxLabelChars, true),
    valueType: field.valueType,
    instruction: assertText(
      field.instruction,
      `Extraction instruction for field "${key}" on document type "${typeKey}"`,
      DOCUMENT_TYPE_CATALOG_LIMITS.maxInstructionChars,
      false,
    ),
  };
};

const validateType = (type: OperatorDocumentTypeDefinition): OperatorDocumentTypeDefinition => {
  const key = assertKey(type?.key, "Document type");
  if (isBuiltInDocumentTypeKey(key)) {
    throw badRequest(`Document type key "${key}" is reserved by a built-in document type.`);
  }

  const fields = Array.isArray(type.fields) ? type.fields : [];
  if (fields.length > DOCUMENT_TYPE_CATALOG_LIMITS.maxFieldsPerType) {
    throw badRequest(
      `Document type "${key}" can define at most ${DOCUMENT_TYPE_CATALOG_LIMITS.maxFieldsPerType} fields.`,
    );
  }

  const seenFieldKeys = new Set<string>();
  const validatedFields = fields.map((field) => {
    const validated = validateField(field, key);
    if (seenFieldKeys.has(validated.key)) {
      throw badRequest(`Field key "${validated.key}" is declared twice on document type "${key}".`);
    }
    seenFieldKeys.add(validated.key);
    return validated;
  });

  return {
    key,
    label: assertText(type.label, `Label for document type "${key}"`, DOCUMENT_TYPE_CATALOG_LIMITS.maxLabelChars, true),
    description: assertText(
      type.description,
      `Description for document type "${key}"`,
      DOCUMENT_TYPE_CATALOG_LIMITS.maxDescriptionChars,
      false,
    ),
    enabled: type.enabled !== false,
    fields: validatedFields,
  };
};

const validateDisabledBuiltInTypeKeys = (keys: readonly string[]): string[] => {
  const disabled: string[] = [];
  for (const key of keys) {
    if (!isBuiltInDocumentTypeKey(key)) {
      throw badRequest(
        `"${key}" is not a built-in document type; only ${builtInDocumentTypeKeys.join(", ")} can be disabled.`,
      );
    }
    if (key === GENERIC_DOCUMENT_TYPE_KEY) {
      throw badRequest(`Document type "${GENERIC_DOCUMENT_TYPE_KEY}" is the reserved fallback and cannot be disabled.`);
    }
    if (!disabled.includes(key)) {
      disabled.push(key);
    }
  }
  return disabled;
};

/**
 * Field keys share one workspace-wide typed namespace. A key may be declared by
 * several types, but every declaration — live or tombstoned — must agree on the
 * value type, so a saved retrieval rule can never be re-pointed at a
 * differently typed field.
 */
const assertValueTypeConsistency = (
  types: readonly OperatorDocumentTypeDefinition[],
  previous: DocumentTypeCatalogRecord,
): void => {
  const retiredValueTypes = new Map<string, DocumentTypeFieldValueType>(
    previous.retiredFields.map((identity) => [identity.key, identity.valueType]),
  );
  const declaredValueTypes = new Map<string, DocumentTypeFieldValueType>();
  for (const type of previous.types) {
    for (const field of type.fields) {
      declaredValueTypes.set(field.key, field.valueType);
    }
  }

  for (const type of types) {
    for (const field of type.fields) {
      const declared = declaredValueTypes.get(field.key);
      if (declared && declared !== field.valueType) {
        throw badRequest(
          `Field "${field.key}" is already declared with value type "${declared}". A field key keeps its value type for good — delete it and create a new key instead.`,
        );
      }
      const retired = retiredValueTypes.get(field.key);
      if (!declared && retired && retired !== field.valueType) {
        throw badRequest(
          `Field "${field.key}" was deleted with value type "${retired}" and can only be recreated with that value type.`,
        );
      }
      declaredValueTypes.set(field.key, field.valueType);
    }
  }
};

/** Deleted identities are kept for good: the tombstone list is the workspace's field-identity ledger. */
const collectRetiredFields = (
  types: readonly OperatorDocumentTypeDefinition[],
  previous: DocumentTypeCatalogRecord,
): RetiredDocumentTypeFieldIdentity[] => {
  const liveKeys = new Set(types.flatMap((type) => type.fields.map((field) => field.key)));
  const retired: RetiredDocumentTypeFieldIdentity[] = [...previous.retiredFields];
  for (const type of previous.types) {
    for (const field of type.fields) {
      if (liveKeys.has(field.key) || retired.some((identity) => identity.key === field.key)) {
        continue;
      }
      retired.push({ key: field.key, valueType: field.valueType });
    }
  }
  return retired;
};

const assertRenderedPromptBudget = (
  types: readonly OperatorDocumentTypeDefinition[],
  disabledBuiltInTypeKeys: readonly string[],
): void => {
  const rendered = renderDocumentTypeCatalogSection(
    toDocumentTypeDefinitions({ types, disabledBuiltInTypeKeys }).filter((type) => type.enabled),
  );
  if (rendered.length > DOCUMENT_TYPE_CATALOG_LIMITS.maxRenderedPromptChars) {
    throw badRequest(
      `The document type catalog renders ${rendered.length} prompt characters and must be at most ${DOCUMENT_TYPE_CATALOG_LIMITS.maxRenderedPromptChars}. Shorten type descriptions or field instructions.`,
    );
  }
};

/**
 * Validates a whole-catalog write against the catalog it was based on and
 * derives the tombstones the write implies. Throws a limit-naming
 * `badRequest` on the first violation.
 */
export const validateDocumentTypeCatalogWrite = (input: {
  previous: DocumentTypeCatalogRecord;
  next: DocumentTypeCatalogWriteInput;
}): ValidatedDocumentTypeCatalogWrite => {
  const incoming = Array.isArray(input.next.types) ? input.next.types : [];
  if (incoming.length > DOCUMENT_TYPE_CATALOG_LIMITS.maxOperatorTypes) {
    throw badRequest(
      `A workspace can define at most ${DOCUMENT_TYPE_CATALOG_LIMITS.maxOperatorTypes} document types.`,
    );
  }

  const seenTypeKeys = new Set<string>();
  const types = incoming.map((type) => {
    const validated = validateType(type);
    if (seenTypeKeys.has(validated.key)) {
      throw badRequest(`Document type key "${validated.key}" is declared twice.`);
    }
    seenTypeKeys.add(validated.key);
    return validated;
  });

  const disabledBuiltInTypeKeys = validateDisabledBuiltInTypeKeys(
    Array.isArray(input.next.disabledBuiltInTypeKeys) ? input.next.disabledBuiltInTypeKeys : [],
  );

  assertValueTypeConsistency(types, input.previous);
  assertRenderedPromptBudget(types, disabledBuiltInTypeKeys);

  return {
    types,
    disabledBuiltInTypeKeys,
    retiredFields: collectRetiredFields(types, input.previous),
  };
};
