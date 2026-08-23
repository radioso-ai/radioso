import { describe, expect, it } from 'vitest'

import {
  CATALOG_CONFLICT_MESSAGE,
  createFieldDraft,
  createTypeDraft,
  isCatalogConflict,
  referencedKeysLosingExtraction,
  toCatalogDraft,
  toCatalogUpdateRequest,
  validateCatalogDraft,
  type DocumentTypeCatalogDraft,
} from '@/components/dashboard/settings/document-type-catalog-model'
import type { DocumentTypeCatalog } from '@/lib/api'

const builtInType = (
  key: string,
  overrides: Partial<DocumentTypeCatalog['types'][number]> = {},
): DocumentTypeCatalog['types'][number] => ({
  key,
  label: key,
  description: `${key} description`,
  enabled: true,
  origin: 'built_in',
  payload: 'none',
  disableable: key !== 'generic',
  fields: [],
  ...overrides,
})

const catalog = (overrides: Partial<DocumentTypeCatalog> = {}): DocumentTypeCatalog => ({
  workspaceId: 'workspace-1',
  revision: '3',
  types: [
    builtInType('event', {
      payload: 'facts',
      fields: [
        { key: 'dateFrom', label: 'Start date', valueType: 'date', instruction: 'First day.' },
        { key: 'dateTo', label: 'End date', valueType: 'date', instruction: 'Last day.' },
      ],
    }),
    builtInType('generic'),
    {
      key: 'product',
      label: 'Product',
      description: 'A product detail page.',
      enabled: true,
      origin: 'operator',
      payload: 'fields',
      disableable: true,
      fields: [
        { key: 'price', label: 'Price', valueType: 'number', instruction: 'The listed price.' },
        { key: 'category', label: 'Category', valueType: 'string', instruction: 'The category.' },
      ],
    },
  ],
  retiredFields: [],
  referencedFieldKeys: [],
  ...overrides,
})

const draftWith = (overrides: Partial<DocumentTypeCatalogDraft> = {}): DocumentTypeCatalogDraft => ({
  ...toCatalogDraft(catalog()),
  ...overrides,
})

describe('catalog draft <-> PUT payload', () => {
  it('splits built-in entries from the editable operator types', () => {
    const draft = toCatalogDraft(catalog())

    expect(draft.revision).toBe('3')
    expect(draft.builtInTypes.map((type) => type.key)).toEqual(['event', 'generic'])
    expect(draft.operatorTypes.map((type) => type.key)).toEqual(['product'])
    expect(draft.operatorTypes[0].persisted).toBe(true)
    expect(draft.operatorTypes[0].fields.every((field) => field.persisted)).toBe(true)
    expect(draft.savedFieldKeys).toEqual(['price', 'category'])
  })

  it('reads the disabled built-ins off their enabled flag', () => {
    const draft = toCatalogDraft(
      catalog({
        types: [
          builtInType('event', { enabled: false }),
          builtInType('generic'),
        ],
      }),
    )

    expect(draft.disabledBuiltInTypeKeys).toEqual(['event'])
  })

  it('sends the whole catalog with the revision it was based on', () => {
    const draft = toCatalogDraft(catalog())

    expect(toCatalogUpdateRequest(draft)).toEqual({
      expectedRevision: '3',
      types: [
        {
          key: 'product',
          label: 'Product',
          description: 'A product detail page.',
          enabled: true,
          fields: [
            { key: 'price', label: 'Price', valueType: 'number', instruction: 'The listed price.' },
            { key: 'category', label: 'Category', valueType: 'string', instruction: 'The category.' },
          ],
        },
      ],
      disabledBuiltInTypeKeys: [],
    })
  })

  it('deletes a field by omitting it, and trims what the operator typed', () => {
    const draft = toCatalogDraft(catalog())
    draft.operatorTypes[0].fields = draft.operatorTypes[0].fields.filter((field) => field.key !== 'category')
    draft.operatorTypes[0].fields.push(
      createFieldDraft({ key: ' sku ', label: ' SKU ', valueType: 'string', instruction: ' The code. ' }),
    )

    const request = toCatalogUpdateRequest(draft)

    expect(request.types[0].fields).toEqual([
      { key: 'price', label: 'Price', valueType: 'number', instruction: 'The listed price.' },
      { key: 'sku', label: 'SKU', valueType: 'string', instruction: 'The code.' },
    ])
  })

  it('carries a disabled built-in through to the payload', () => {
    const draft = toCatalogDraft(catalog())
    draft.disabledBuiltInTypeKeys = ['event']

    expect(toCatalogUpdateRequest(draft).disabledBuiltInTypeKeys).toEqual(['event'])
  })
})

describe('client-side catalog validation', () => {
  const messages = (draft: DocumentTypeCatalogDraft) =>
    validateCatalogDraft(draft).map((issue) => issue.message)

  it('accepts the catalog it loaded', () => {
    expect(validateCatalogDraft(toCatalogDraft(catalog()))).toEqual([])
  })

  it('rejects a dotted field key because a flat tag could never match a rule', () => {
    const draft = draftWith()
    draft.operatorTypes[0].fields.push(createFieldDraft({ key: 'product.price', label: 'Price' }))

    expect(messages(draft)).toContain(
      'Field key "product.price" must be at most 64 characters, start with a letter, and contain only letters, digits, and underscores.',
    )
  })

  it('rejects a key that does not start with a letter and an over-long key', () => {
    const draft = draftWith()
    draft.operatorTypes[0].fields.push(createFieldDraft({ key: '1price', label: 'Price' }))
    draft.operatorTypes[0].fields.push(createFieldDraft({ key: `a${'b'.repeat(64)}`, label: 'Long' }))

    const found = messages(draft)
    expect(found.some((message) => message.includes('"1price"'))).toBe(true)
    expect(found.some((message) => message.includes(`"a${'b'.repeat(64)}"`))).toBe(true)
  })

  it('rejects an empty key and an empty label', () => {
    const draft = draftWith()
    draft.operatorTypes[0].fields.push(createFieldDraft({ key: '  ', label: '' }))

    const found = messages(draft)
    expect(found).toContain('Field key must not be empty.')
    expect(found).toContain('Label for field "" must not be empty.')
  })

  it('rejects a field key the built-in types already own', () => {
    const draft = draftWith()
    draft.operatorTypes[0].fields.push(createFieldDraft({ key: 'dateFrom', label: 'Start', valueType: 'date' }))

    expect(messages(draft)).toContain('Field key "dateFrom" is reserved by a built-in document type.')
  })

  it('rejects a type key a built-in already owns and a duplicated type key', () => {
    const draft = draftWith()
    draft.operatorTypes.push(createTypeDraft({ key: 'event', label: 'Event' }))
    draft.operatorTypes.push(createTypeDraft({ key: 'product', label: 'Product again' }))

    const found = messages(draft)
    expect(found).toContain('Document type key "event" is reserved by a built-in document type.')
    expect(found).toContain('Document type key "product" is declared twice.')
  })

  it('rejects the same field key declared twice on one type', () => {
    const draft = draftWith()
    draft.operatorTypes[0].fields.push(createFieldDraft({ key: 'price', label: 'Price again', valueType: 'number' }))

    expect(messages(draft)).toContain('Field key "price" is declared twice on document type "product".')
  })

  it('rejects a second type declaring an existing key under another value type', () => {
    const draft = draftWith()
    draft.operatorTypes.push(
      createTypeDraft({
        key: 'course',
        label: 'Course',
        fields: [createFieldDraft({ key: 'price', label: 'Price', valueType: 'string' })],
      }),
    )

    expect(messages(draft)).toContain(
      'Field "price" is already declared with value type "number". A field key keeps its value type for good — delete it and create a new key instead.',
    )
  })

  it('accepts the same key on two types when they agree on the value type', () => {
    const draft = draftWith()
    draft.operatorTypes.push(
      createTypeDraft({
        key: 'course',
        label: 'Course',
        fields: [createFieldDraft({ key: 'price', label: 'Price', valueType: 'number' })],
      }),
    )

    expect(validateCatalogDraft(draft)).toEqual([])
  })

  it('rejects recreating a retired key under a different value type', () => {
    const loaded = toCatalogDraft(
      catalog({ retiredFields: [{ key: 'audience', valueType: 'string' }] }),
    )
    loaded.operatorTypes[0].fields.push(
      createFieldDraft({ key: 'audience', label: 'Audience', valueType: 'number' }),
    )

    expect(messages(loaded)).toContain(
      'Field "audience" was deleted with value type "string" and can only be recreated with that value type.',
    )
  })

  it('accepts recreating a retired key under its original value type', () => {
    const loaded = toCatalogDraft(
      catalog({ retiredFields: [{ key: 'audience', valueType: 'string' }] }),
    )
    loaded.operatorTypes[0].fields.push(
      createFieldDraft({ key: 'audience', label: 'Audience', valueType: 'string' }),
    )

    expect(validateCatalogDraft(loaded)).toEqual([])
  })

  it('names the limit when a bound is exceeded', () => {
    const draft = draftWith()
    draft.operatorTypes[0].description = 'x'.repeat(501)
    draft.operatorTypes[0].label = 'y'.repeat(81)
    draft.operatorTypes[0].fields[0].instruction = 'z'.repeat(241)
    for (let index = 0; index < 9; index += 1) {
      draft.operatorTypes[0].fields.push(
        createFieldDraft({ key: `extra${index}`, label: `Extra ${index}` }),
      )
    }
    for (let index = 0; index < 20; index += 1) {
      draft.operatorTypes.push(createTypeDraft({ key: `type${index}`, label: `Type ${index}` }))
    }

    const found = messages(draft)
    expect(found).toContain('A workspace can define at most 20 document types.')
    expect(found).toContain('Document type "product" can define at most 10 fields.')
    expect(found).toContain('Description for document type "product" must be at most 500 characters.')
    expect(found).toContain('Label for document type "product" must be at most 80 characters.')
    expect(found).toContain(
      'Extraction instruction for field "price" on document type "product" must be at most 240 characters.',
    )
  })

  it('points each issue at the row that caused it', () => {
    const draft = draftWith()
    const broken = createFieldDraft({ key: 'bad.key', label: 'Bad' })
    draft.operatorTypes[0].fields.push(broken)

    const issues = validateCatalogDraft(draft)
    expect(issues).toHaveLength(1)
    expect(issues[0]).toMatchObject({
      scope: 'field',
      typeRowId: draft.operatorTypes[0].rowId,
      fieldRowId: broken.rowId,
    })
  })
})

describe('metadata rule reference advisory', () => {
  it('warns when a save deletes a field an agent rule points at', () => {
    const draft = toCatalogDraft(catalog({ referencedFieldKeys: ['category', 'language'] }))
    draft.operatorTypes[0].fields = draft.operatorTypes[0].fields.filter((field) => field.key !== 'category')

    expect(referencedKeysLosingExtraction(draft)).toEqual(['category'])
  })

  it('warns when disabling a type stops its referenced keys being generated', () => {
    const draft = toCatalogDraft(catalog({ referencedFieldKeys: ['price', 'dateFrom'] }))
    draft.operatorTypes[0].enabled = false
    draft.disabledBuiltInTypeKeys = ['event']

    expect(referencedKeysLosingExtraction(draft)).toEqual(['price', 'dateFrom'])
  })

  it('stays quiet when the deleted key is not referenced anywhere', () => {
    const draft = toCatalogDraft(catalog({ referencedFieldKeys: ['language'] }))
    draft.operatorTypes[0].fields = []

    expect(referencedKeysLosingExtraction(draft)).toEqual([])
  })

  it('stays quiet when nothing is deleted', () => {
    const draft = toCatalogDraft(catalog({ referencedFieldKeys: ['price', 'category'] }))

    expect(referencedKeysLosingExtraction(draft)).toEqual([])
  })
})

describe('stale revision handling', () => {
  it('recognises the conflict status and offers a reapply message', () => {
    expect(isCatalogConflict(409)).toBe(true)
    expect(isCatalogConflict(400)).toBe(false)
    expect(isCatalogConflict(undefined)).toBe(false)
    expect(CATALOG_CONFLICT_MESSAGE).toContain('reapply')
  })

  it('rebases onto the refetched catalog so the next save carries the current revision', () => {
    const stale = toCatalogDraft(catalog())
    expect(stale.revision).toBe('3')

    const refetched = toCatalogDraft(
      catalog({
        revision: '4',
        types: [
          ...catalog().types.filter((type) => type.origin === 'built_in'),
          {
            key: 'product',
            label: 'Product',
            description: 'Edited by someone else.',
            enabled: true,
            origin: 'operator',
            payload: 'fields',
            disableable: true,
            fields: [
              { key: 'price', label: 'Price', valueType: 'number', instruction: 'The listed price.' },
              { key: 'category', label: 'Category', valueType: 'string', instruction: 'The category.' },
            ],
          },
        ],
      }),
    )

    expect(toCatalogUpdateRequest(refetched).expectedRevision).toBe('4')
    expect(refetched.operatorTypes[0].description).toBe('Edited by someone else.')
  })
})
