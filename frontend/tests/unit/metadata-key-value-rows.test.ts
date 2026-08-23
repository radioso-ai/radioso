import { describe, expect, it } from 'vitest'

import {
  areRecordsEqual,
  changeRowType,
  createMetadataRow,
  isExtractionManagedKey,
  parseMetadataNumber,
  toRecord,
  toRows,
  validateRows,
  type MetadataRow,
} from '@/components/dashboard/shared/metadata-key-value-rows'

const row = (overrides: Partial<Omit<MetadataRow, 'id'>>): MetadataRow => createMetadataRow(overrides)

describe('metadata rows <-> record transform', () => {
  it('emits native JSON scalars rather than the editor text', () => {
    const record = toRecord([
      row({ key: 'region', valueType: 'string', value: 'emea' }),
      row({ key: 'capacity', valueType: 'number', value: '42' }),
      row({ key: 'archived', valueType: 'boolean', value: 'true' }),
      row({ key: 'cleared', valueType: 'null', value: '' }),
    ])

    expect(record).toEqual({ region: 'emea', capacity: 42, archived: true, cleared: null })
    expect(typeof record.capacity).toBe('number')
    expect(typeof record.archived).toBe('boolean')
  })

  it('reads a boolean row as false for anything other than "true"', () => {
    expect(toRecord([row({ key: 'archived', valueType: 'boolean', value: 'false' })])).toEqual({
      archived: false,
    })
    expect(toRecord([row({ key: 'archived', valueType: 'boolean', value: '' })])).toEqual({
      archived: false,
    })
  })

  it('trims keys and leaves values untouched', () => {
    expect(toRecord([row({ key: '  region  ', value: '  emea  ' })])).toEqual({ region: '  emea  ' })
  })

  it('excludes rows whose key is blank', () => {
    expect(toRecord([
      row({ key: '', value: 'orphaned' }),
      row({ key: '   ', value: 'also orphaned' }),
      row({ key: 'region', value: 'emea' }),
    ])).toEqual({ region: 'emea' })
  })

  it('excludes number rows whose text is not a finite number', () => {
    expect(toRecord([
      row({ key: 'capacity', valueType: 'number', value: 'abc' }),
      row({ key: 'region', value: 'emea' }),
    ])).toEqual({ region: 'emea' })
  })

  it('lets the last row win on a duplicate key', () => {
    expect(toRecord([
      row({ key: 'region', value: 'emea' }),
      row({ key: 'region', value: 'apac' }),
    ])).toEqual({ region: 'apac' })
  })

  it('seeds rows from a stored record, preserving each value type', () => {
    const rows = toRows({ region: 'emea', capacity: 42, archived: false, cleared: null })

    expect(rows.map(({ key, valueType, value }) => ({ key, valueType, value }))).toEqual([
      { key: 'region', valueType: 'string', value: 'emea' },
      { key: 'capacity', valueType: 'number', value: '42' },
      { key: 'archived', valueType: 'boolean', value: 'false' },
      { key: 'cleared', valueType: 'null', value: '' },
    ])
  })

  it('gives every seeded row a distinct id', () => {
    const rows = toRows({ a: '1', b: '2' })
    expect(new Set(rows.map((entry) => entry.id)).size).toBe(2)
  })

  it('drops non-scalar values when seeding rows', () => {
    const rows = toRows({ region: 'emea', cleared: null, nested: { a: 1 }, list: [1, 2] })
    expect(rows.map((entry) => entry.key)).toEqual(['region', 'cleared'])
  })

  it('treats a missing record as no rows', () => {
    expect(toRows(null)).toEqual([])
    expect(toRows(undefined)).toEqual([])
  })

  it('round-trips a record through rows unchanged', () => {
    const original = { region: 'emea', capacity: 42, archived: true, cleared: null }
    expect(toRecord(toRows(original))).toEqual(original)
  })
})

describe('metadata number parsing', () => {
  it('accepts finite numbers, including negatives and decimals', () => {
    expect(parseMetadataNumber('42')).toBe(42)
    expect(parseMetadataNumber(' -3.5 ')).toBe(-3.5)
    expect(parseMetadataNumber('0')).toBe(0)
  })

  it('rejects blank text and anything that is not a finite number', () => {
    expect(parseMetadataNumber('')).toBeNull()
    expect(parseMetadataNumber('   ')).toBeNull()
    expect(parseMetadataNumber('abc')).toBeNull()
    expect(parseMetadataNumber('Infinity')).toBeNull()
  })
})

describe('metadata row validation', () => {
  it('accepts a well-formed set of rows', () => {
    const validation = validateRows([
      row({ key: 'region', value: 'emea' }),
      row({ key: 'capacity', valueType: 'number', value: '42' }),
    ])

    expect(validation.isValid).toBe(true)
    expect(validation.issuesByRowId).toEqual({})
  })

  it('flags a value stranded without a key without blocking the save', () => {
    const orphan = row({ key: '', value: 'orphaned' })
    const validation = validateRows([orphan])

    expect(validation.hasEmptyKey).toBe(true)
    expect(validation.issuesByRowId[orphan.id]).toContain('empty_key')
    // Empty keys are dropped on save rather than blocking it.
    expect(validation.isValid).toBe(true)
  })

  it('treats a wholly blank row as pending rather than a mistake', () => {
    const pending = row({ key: '', value: '' })
    const validation = validateRows([pending])

    expect(validation.hasEmptyKey).toBe(false)
    expect(validation.issuesByRowId).toEqual({})
    expect(validation.isValid).toBe(true)
  })

  it('blocks the save and flags every row sharing a duplicate key', () => {
    const first = row({ key: 'region', value: 'emea' })
    const second = row({ key: ' region ', value: 'apac' })
    const other = row({ key: 'capacity', valueType: 'number', value: '1' })
    const validation = validateRows([first, second, other])

    expect(validation.hasDuplicateKey).toBe(true)
    expect(validation.issuesByRowId[first.id]).toContain('duplicate_key')
    expect(validation.issuesByRowId[second.id]).toContain('duplicate_key')
    expect(validation.issuesByRowId[other.id]).toBeUndefined()
    expect(validation.isValid).toBe(false)
  })

  it('blocks the save on a number row that does not parse', () => {
    const bad = row({ key: 'capacity', valueType: 'number', value: 'abc' })
    const validation = validateRows([bad])

    expect(validation.hasInvalidNumber).toBe(true)
    expect(validation.issuesByRowId[bad.id]).toContain('invalid_number')
    expect(validation.isValid).toBe(false)
  })

  it('blocks the save on an empty number row, which has nothing to store', () => {
    const empty = row({ key: 'capacity', valueType: 'number', value: '' })
    expect(validateRows([empty]).isValid).toBe(false)
  })
})

describe('extraction-managed keys', () => {
  it('recognises the keys metadata extraction owns, ignoring surrounding space', () => {
    expect(isExtractionManagedKey('dateFrom')).toBe(true)
    expect(isExtractionManagedKey('dateTo')).toBe(true)
    expect(isExtractionManagedKey('  dateFrom  ')).toBe(true)
  })

  it('does not treat near-misses as managed', () => {
    expect(isExtractionManagedKey('datefrom')).toBe(false)
    expect(isExtractionManagedKey('dateFromX')).toBe(false)
    expect(isExtractionManagedKey('region')).toBe(false)
    expect(isExtractionManagedKey('')).toBe(false)
  })

  it('warns without producing a row issue or blocking the save', () => {
    const managed = row({ key: 'dateFrom', value: '2026-01-01' })
    const validation = validateRows([managed])

    expect(validation.issuesByRowId[managed.id]).toBeUndefined()
    expect(validation.isValid).toBe(true)
    // The value still reaches the payload; the warning is advisory only.
    expect(toRecord([managed])).toEqual({ dateFrom: '2026-01-01' })
  })
})

describe('row retyping', () => {
  it('coerces text into a usable boolean when switching to true/false', () => {
    expect(changeRowType(row({ key: 'a', value: 'true' }), 'boolean').value).toBe('true')
    expect(changeRowType(row({ key: 'a', value: 'whatever' }), 'boolean').value).toBe('false')
  })

  it('keeps the typed text when switching between text and number', () => {
    expect(changeRowType(row({ key: 'a', value: '42' }), 'number')).toMatchObject({
      valueType: 'number',
      value: '42',
    })
  })

  it('clears the editor text when switching to null', () => {
    expect(changeRowType(row({ key: 'a', value: '42' }), 'null')).toMatchObject({
      valueType: 'null',
      value: '',
    })
  })

  it('returns the same row when the type is unchanged', () => {
    const original = row({ key: 'a', value: '42', valueType: 'number' })
    expect(changeRowType(original, 'number')).toBe(original)
  })
})

describe('record comparison', () => {
  it('ignores key order but not values or value types', () => {
    expect(areRecordsEqual({ a: '1', b: 2 }, { b: 2, a: '1' })).toBe(true)
    expect(areRecordsEqual({ a: '1' }, { a: 1 })).toBe(false)
    expect(areRecordsEqual({ a: null }, { a: null })).toBe(true)
    expect(areRecordsEqual({ a: '1' }, { a: '1', b: '2' })).toBe(false)
    expect(areRecordsEqual({}, {})).toBe(true)
  })
})
