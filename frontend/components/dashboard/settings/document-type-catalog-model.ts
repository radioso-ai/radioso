import type {
  DocumentTypeCatalog,
  DocumentTypeDefinition,
  DocumentTypeFieldValueType,
  RetiredDocumentTypeField,
  UpdateDocumentTypeCatalogRequest,
} from '@/lib/api'

/**
 * Editor state for the workspace document type catalog, and the transforms
 * between it and the whole-catalog PUT.
 *
 * Two invariants shape the state: a field's key and value type are fixed once
 * saved (renaming means delete + create, so a saved retrieval rule is never
 * re-pointed), and the server is the authority on every bound below. These
 * checks exist to answer before the round trip, not to replace it.
 */

export const DOCUMENT_TYPE_CATALOG_LIMITS = {
  maxOperatorTypes: 20,
  maxFieldsPerType: 10,
  maxDescriptionChars: 500,
  maxInstructionChars: 240,
  maxLabelChars: 80,
  maxKeyChars: 64,
} as const

/** Dots are excluded on purpose: rule scoring reads `.` as a path separator while extracted tags are flat. */
export const DOCUMENT_TYPE_KEY_PATTERN = /^[A-Za-z][A-Za-z0-9_]{0,63}$/

export const documentTypeFieldValueTypes: DocumentTypeFieldValueType[] = [
  'string',
  'number',
  'date',
  'boolean',
]

export const documentTypeFieldValueTypeLabels: Record<DocumentTypeFieldValueType, string> = {
  string: 'Text',
  number: 'Number',
  date: 'Date',
  boolean: 'Boolean',
}

export interface DocumentTypeFieldDraft {
  /** Client-side row identity; survives key edits so React keys stay stable. */
  rowId: string
  key: string
  label: string
  valueType: DocumentTypeFieldValueType
  instruction: string
  /** Saved fields keep their key and value type for good. */
  persisted: boolean
}

export interface DocumentTypeDraft {
  rowId: string
  key: string
  label: string
  description: string
  enabled: boolean
  fields: DocumentTypeFieldDraft[]
  /** A saved type keeps its key; the key is how provenance and tags refer to it. */
  persisted: boolean
}

export interface DocumentTypeCatalogDraft {
  revision: string
  builtInTypes: DocumentTypeDefinition[]
  disabledBuiltInTypeKeys: string[]
  operatorTypes: DocumentTypeDraft[]
  retiredFields: RetiredDocumentTypeField[]
  referencedFieldKeys: string[]
  /** Field keys the loaded catalog declared, used to spot deletions before saving. */
  savedFieldKeys: string[]
  /** Declared value types at load time, so a recreated key is checked the way the server checks it. */
  savedFieldValueTypes: Record<string, DocumentTypeFieldValueType>
}

export type CatalogValidationScope = 'catalog' | 'type' | 'field'

export interface CatalogValidationIssue {
  scope: CatalogValidationScope
  typeRowId?: string
  fieldRowId?: string
  message: string
}

let rowIdCounter = 0
const nextRowId = (prefix: string): string => {
  rowIdCounter += 1
  return `${prefix}-${rowIdCounter}`
}

export const createFieldDraft = (
  overrides: Partial<Omit<DocumentTypeFieldDraft, 'rowId'>> = {},
): DocumentTypeFieldDraft => ({
  rowId: nextRowId('field'),
  key: '',
  label: '',
  valueType: 'string',
  instruction: '',
  persisted: false,
  ...overrides,
})

export const createTypeDraft = (
  overrides: Partial<Omit<DocumentTypeDraft, 'rowId'>> = {},
): DocumentTypeDraft => ({
  rowId: nextRowId('type'),
  key: '',
  label: '',
  description: '',
  enabled: true,
  fields: [],
  persisted: false,
  ...overrides,
})

export const toCatalogDraft = (catalog: DocumentTypeCatalog): DocumentTypeCatalogDraft => {
  const builtInTypes = catalog.types.filter((type) => type.origin === 'built_in')
  const operatorTypes = catalog.types
    .filter((type) => type.origin === 'operator')
    .map((type) =>
      createTypeDraft({
        key: type.key,
        label: type.label,
        description: type.description,
        enabled: type.enabled,
        persisted: true,
        fields: type.fields.map((field) =>
          createFieldDraft({
            key: field.key,
            label: field.label,
            valueType: field.valueType,
            instruction: field.instruction,
            persisted: true,
          }),
        ),
      }),
    )

  // Only operator declarations seed the typed namespace; built-in keys are
  // rejected as reserved before a value-type comparison could apply.
  const savedFieldValueTypes: Record<string, DocumentTypeFieldValueType> = {}
  for (const type of operatorTypes) {
    for (const field of type.fields) {
      savedFieldValueTypes[field.key] ??= field.valueType
    }
  }

  return {
    revision: catalog.revision,
    builtInTypes,
    disabledBuiltInTypeKeys: builtInTypes.filter((type) => !type.enabled).map((type) => type.key),
    operatorTypes,
    retiredFields: [...catalog.retiredFields],
    referencedFieldKeys: [...(catalog.referencedFieldKeys ?? [])],
    savedFieldKeys: operatorTypes.flatMap((type) => type.fields.map((field) => field.key)),
    savedFieldValueTypes,
  }
}

/**
 * The whole catalog, as the server expects it. Deleting a field means omitting
 * it — the server derives the tombstone from the diff.
 */
export const toCatalogUpdateRequest = (
  draft: DocumentTypeCatalogDraft,
): Required<UpdateDocumentTypeCatalogRequest> => ({
  expectedRevision: draft.revision,
  types: draft.operatorTypes.map((type) => ({
    key: type.key.trim(),
    label: type.label.trim(),
    description: type.description.trim(),
    enabled: type.enabled,
    fields: type.fields.map((field) => ({
      key: field.key.trim(),
      label: field.label.trim(),
      valueType: field.valueType,
      instruction: field.instruction.trim(),
    })),
  })),
  disabledBuiltInTypeKeys: [...draft.disabledBuiltInTypeKeys],
})

const reservedFieldKeys = (draft: DocumentTypeCatalogDraft): string[] =>
  draft.builtInTypes.flatMap((type) => type.fields.map((field) => field.key))

const validateKey = (
  key: string,
  subject: 'Document type' | 'Field',
): string | null => {
  if (key.trim().length === 0) {
    return `${subject} key must not be empty.`
  }
  if (!DOCUMENT_TYPE_KEY_PATTERN.test(key)) {
    return `${subject} key "${key}" must be at most ${DOCUMENT_TYPE_CATALOG_LIMITS.maxKeyChars} characters, start with a letter, and contain only letters, digits, and underscores.`
  }
  return null
}

/**
 * Mirrors the server's rules and its messages, so an operator sees the same
 * sentence whether the client caught it or the server did. The rendered prompt
 * budget stays server-side: reproducing the renderer here would be a second
 * source of truth for the same string.
 */
export const validateCatalogDraft = (draft: DocumentTypeCatalogDraft): CatalogValidationIssue[] => {
  const issues: CatalogValidationIssue[] = []
  const reserved = reservedFieldKeys(draft)
  const builtInTypeKeys = draft.builtInTypes.map((type) => type.key)

  if (draft.operatorTypes.length > DOCUMENT_TYPE_CATALOG_LIMITS.maxOperatorTypes) {
    issues.push({
      scope: 'catalog',
      message: `A workspace can define at most ${DOCUMENT_TYPE_CATALOG_LIMITS.maxOperatorTypes} document types.`,
    })
  }

  const retiredValueTypes = new Map(draft.retiredFields.map((identity) => [identity.key, identity.valueType]))
  const declaredValueTypes = new Map<string, DocumentTypeFieldValueType>(
    Object.entries(draft.savedFieldValueTypes) as [string, DocumentTypeFieldValueType][],
  )
  const seenTypeKeys = new Set<string>()

  for (const type of draft.operatorTypes) {
    const typeKey = type.key.trim()
    const keyIssue = validateKey(typeKey, 'Document type')
    if (keyIssue) {
      issues.push({ scope: 'type', typeRowId: type.rowId, message: keyIssue })
    } else if (builtInTypeKeys.includes(typeKey)) {
      issues.push({
        scope: 'type',
        typeRowId: type.rowId,
        message: `Document type key "${typeKey}" is reserved by a built-in document type.`,
      })
    } else if (seenTypeKeys.has(typeKey)) {
      issues.push({
        scope: 'type',
        typeRowId: type.rowId,
        message: `Document type key "${typeKey}" is declared twice.`,
      })
    }
    if (typeKey.length > 0) {
      seenTypeKeys.add(typeKey)
    }

    if (type.label.trim().length === 0) {
      issues.push({
        scope: 'type',
        typeRowId: type.rowId,
        message: `Label for document type "${typeKey}" must not be empty.`,
      })
    } else if (type.label.length > DOCUMENT_TYPE_CATALOG_LIMITS.maxLabelChars) {
      issues.push({
        scope: 'type',
        typeRowId: type.rowId,
        message: `Label for document type "${typeKey}" must be at most ${DOCUMENT_TYPE_CATALOG_LIMITS.maxLabelChars} characters.`,
      })
    }

    if (type.description.length > DOCUMENT_TYPE_CATALOG_LIMITS.maxDescriptionChars) {
      issues.push({
        scope: 'type',
        typeRowId: type.rowId,
        message: `Description for document type "${typeKey}" must be at most ${DOCUMENT_TYPE_CATALOG_LIMITS.maxDescriptionChars} characters.`,
      })
    }

    if (type.fields.length > DOCUMENT_TYPE_CATALOG_LIMITS.maxFieldsPerType) {
      issues.push({
        scope: 'type',
        typeRowId: type.rowId,
        message: `Document type "${typeKey}" can define at most ${DOCUMENT_TYPE_CATALOG_LIMITS.maxFieldsPerType} fields.`,
      })
    }

    const seenFieldKeys = new Set<string>()
    for (const field of type.fields) {
      const fieldKey = field.key.trim()
      const fieldKeyIssue = validateKey(fieldKey, 'Field')
      if (fieldKeyIssue) {
        issues.push({ scope: 'field', typeRowId: type.rowId, fieldRowId: field.rowId, message: fieldKeyIssue })
      } else if (reserved.includes(fieldKey)) {
        issues.push({
          scope: 'field',
          typeRowId: type.rowId,
          fieldRowId: field.rowId,
          message: `Field key "${fieldKey}" is reserved by a built-in document type.`,
        })
      } else if (seenFieldKeys.has(fieldKey)) {
        issues.push({
          scope: 'field',
          typeRowId: type.rowId,
          fieldRowId: field.rowId,
          message: `Field key "${fieldKey}" is declared twice on document type "${typeKey}".`,
        })
      }
      if (fieldKey.length > 0) {
        seenFieldKeys.add(fieldKey)
      }

      if (field.label.trim().length === 0) {
        issues.push({
          scope: 'field',
          typeRowId: type.rowId,
          fieldRowId: field.rowId,
          message: `Label for field "${fieldKey}" must not be empty.`,
        })
      } else if (field.label.length > DOCUMENT_TYPE_CATALOG_LIMITS.maxLabelChars) {
        issues.push({
          scope: 'field',
          typeRowId: type.rowId,
          fieldRowId: field.rowId,
          message: `Label for field "${fieldKey}" must be at most ${DOCUMENT_TYPE_CATALOG_LIMITS.maxLabelChars} characters.`,
        })
      }

      if (field.instruction.length > DOCUMENT_TYPE_CATALOG_LIMITS.maxInstructionChars) {
        issues.push({
          scope: 'field',
          typeRowId: type.rowId,
          fieldRowId: field.rowId,
          message: `Extraction instruction for field "${fieldKey}" on document type "${typeKey}" must be at most ${DOCUMENT_TYPE_CATALOG_LIMITS.maxInstructionChars} characters.`,
        })
      }

      if (fieldKey.length === 0) {
        continue
      }

      const declared = declaredValueTypes.get(fieldKey)
      const retired = retiredValueTypes.get(fieldKey)
      if (declared && declared !== field.valueType) {
        issues.push({
          scope: 'field',
          typeRowId: type.rowId,
          fieldRowId: field.rowId,
          message: `Field "${fieldKey}" is already declared with value type "${declared}". A field key keeps its value type for good — delete it and create a new key instead.`,
        })
      } else if (!declared && retired && retired !== field.valueType) {
        issues.push({
          scope: 'field',
          typeRowId: type.rowId,
          fieldRowId: field.rowId,
          message: `Field "${fieldKey}" was deleted with value type "${retired}" and can only be recreated with that value type.`,
        })
      }
      declaredValueTypes.set(fieldKey, field.valueType)
    }
  }

  return issues
}

export const issuesForType = (
  issues: CatalogValidationIssue[],
  typeRowId: string,
): CatalogValidationIssue[] => issues.filter((issue) => issue.scope === 'type' && issue.typeRowId === typeRowId)

export const issuesForField = (
  issues: CatalogValidationIssue[],
  fieldRowId: string,
): CatalogValidationIssue[] => issues.filter((issue) => issue.scope === 'field' && issue.fieldRowId === fieldRowId)

/**
 * FR-018 advisory: keys the save would stop generating that some agent's
 * metadata rules still point at. Rules on a key that stops being generated keep
 * working — they just stop matching — so this warns and never blocks.
 */
export const referencedKeysLosingExtraction = (draft: DocumentTypeCatalogDraft): string[] => {
  const stillGenerated = new Set(
    draft.operatorTypes
      .filter((type) => type.enabled)
      .flatMap((type) => type.fields.map((field) => field.key.trim())),
  )
  const disabledBuiltIns = new Set(draft.disabledBuiltInTypeKeys)
  for (const type of draft.builtInTypes) {
    if (disabledBuiltIns.has(type.key)) {
      continue
    }
    for (const field of type.fields) {
      stillGenerated.add(field.key)
    }
  }

  const atRisk = new Set<string>()
  for (const key of draft.savedFieldKeys) {
    if (!stillGenerated.has(key)) {
      atRisk.add(key)
    }
  }
  for (const type of draft.builtInTypes) {
    if (!disabledBuiltIns.has(type.key)) {
      continue
    }
    for (const field of type.fields) {
      if (!stillGenerated.has(field.key)) {
        atRisk.add(field.key)
      }
    }
  }

  return draft.referencedFieldKeys.filter((key) => atRisk.has(key))
}

/** A stale-revision rejection: reload, then reapply the edit onto the current catalog. */
export const CATALOG_CONFLICT_MESSAGE =
  'Someone else saved this catalog while you were editing. The latest version is loaded below — reapply your change and save again.'

export const isCatalogConflict = (status: number | undefined): boolean => status === 409
