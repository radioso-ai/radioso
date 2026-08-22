'use client'

import { useEffect, useRef, useState } from 'react'
import { Plus, Trash2 } from 'lucide-react'

import { MetadataBadges } from '@/components/dashboard/shared/metadata-badges'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import {
  areRecordsEqual,
  changeRowType,
  createMetadataRow,
  isExtractionManagedKey,
  toRecord,
  toRows,
  validateRows,
  type MetadataReadRecord,
  type MetadataRecord,
  type MetadataRow,
  type MetadataRowIssue,
  type MetadataValueType,
} from '@/components/dashboard/shared/metadata-key-value-rows'

const issueMessages: Record<MetadataRowIssue, string> = {
  empty_key: 'Add a key, or this tag is left out.',
  duplicate_key: 'This key is already used. Keys must be unique.',
  invalid_number: 'Enter a number.',
}

const valueTypeLabels: Record<MetadataValueType, string> = {
  string: 'Text',
  number: 'Number',
  boolean: 'True/false',
}

const extractionManagedWarning =
  'Metadata extraction manages this key and can overwrite or remove it during processing.'

export function MetadataKeyValueEditor({
  value,
  onChange,
  onValidityChange,
  readOnly = false,
  disabled = false,
  label = 'Metadata',
  description,
  labelPrefix = 'Metadata',
  fieldId,
  addLabel = 'Add tag',
  emptyLabel = 'No tags yet.',
}: {
  value: MetadataReadRecord
  onChange: (next: MetadataRecord) => void
  onValidityChange?: (isValid: boolean) => void
  readOnly?: boolean
  disabled?: boolean
  label?: string | null
  description?: string
  /** Seeds the per-row accessible names, which is how rows are addressed in tests. */
  labelPrefix?: string
  fieldId?: string
  addLabel?: string
  emptyLabel?: string
}) {
  const [rows, setRows] = useState<MetadataRow[]>(() => toRows(value))
  const [seededFrom, setSeededFrom] = useState(value)

  // The parent owns the record, the editor owns row identity and raw text. Reseed
  // only when the incoming record says something the current rows do not, so a
  // half-typed number is not clobbered by the parent echoing our own emission back.
  if (value !== seededFrom) {
    setSeededFrom(value)
    const incoming = toRows(value)
    if (!areRecordsEqual(toRecord(rows), toRecord(incoming))) {
      setRows(incoming)
    }
  }

  const validation = validateRows(rows)
  const validityRef = useRef<boolean | null>(null)
  useEffect(() => {
    if (validityRef.current === validation.isValid) return
    validityRef.current = validation.isValid
    onValidityChange?.(validation.isValid)
  }, [validation.isValid, onValidityChange])

  const commit = (nextRows: MetadataRow[]) => {
    setRows(nextRows)
    onChange(toRecord(nextRows))
  }

  const updateRow = (id: string, patch: (row: MetadataRow) => MetadataRow) => {
    commit(rows.map((row) => (row.id === id ? patch(row) : row)))
  }

  if (readOnly) {
    const entries = toRecord(rows)
    return (
      <div className="space-y-2">
        {label ? <p className="text-sm font-medium text-foreground">{label}</p> : null}
        {description ? <p className="text-xs text-muted-foreground">{description}</p> : null}
        {Object.keys(entries).length === 0 ? (
          <p className="text-sm text-muted-foreground">{emptyLabel}</p>
        ) : (
          <MetadataBadges metadata={entries} className="mt-0" />
        )}
      </div>
    )
  }

  return (
    <div className="space-y-3">
      {label ? (
        <Label htmlFor={fieldId ? `${fieldId}-key-1` : undefined} className="text-sm font-medium">
          {label}
        </Label>
      ) : null}
      {description ? <p className="text-xs text-muted-foreground">{description}</p> : null}

      {rows.length === 0 ? (
        <p className="rounded-lg border border-dashed border-border p-3 text-sm text-muted-foreground">
          {emptyLabel}
        </p>
      ) : (
        <div className="space-y-2">
          {rows.map((row, index) => {
            const position = index + 1
            const issues = validation.issuesByRowId[row.id] ?? []
            const showManagedWarning = isExtractionManagedKey(row.key)
            return (
              <div
                key={row.id}
                className="grid gap-2 rounded-lg border border-border/70 bg-muted/25 p-3 sm:grid-cols-[minmax(0,1fr)_minmax(0,1fr)_9rem_auto] sm:items-start"
              >
                <Input
                  id={fieldId ? `${fieldId}-key-${position}` : undefined}
                  value={row.key}
                  onChange={(event) => updateRow(row.id, (current) => ({ ...current, key: event.target.value }))}
                  placeholder="Key"
                  aria-label={`${labelPrefix} key ${position}`}
                  aria-invalid={issues.includes('empty_key') || issues.includes('duplicate_key')}
                  disabled={disabled}
                />
                {row.valueType === 'boolean' ? (
                  <Select
                    value={row.value === 'true' ? 'true' : 'false'}
                    onValueChange={(next) => updateRow(row.id, (current) => ({ ...current, value: next }))}
                    disabled={disabled}
                  >
                    <SelectTrigger aria-label={`${labelPrefix} value ${position}`}>
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="true">True</SelectItem>
                      <SelectItem value="false">False</SelectItem>
                    </SelectContent>
                  </Select>
                ) : (
                  <Input
                    value={row.value}
                    onChange={(event) => updateRow(row.id, (current) => ({ ...current, value: event.target.value }))}
                    placeholder="Value"
                    inputMode={row.valueType === 'number' ? 'decimal' : undefined}
                    aria-label={`${labelPrefix} value ${position}`}
                    aria-invalid={issues.includes('invalid_number')}
                    disabled={disabled}
                  />
                )}
                <Select
                  value={row.valueType}
                  onValueChange={(next) =>
                    updateRow(row.id, (current) => changeRowType(current, next as MetadataValueType))
                  }
                  disabled={disabled}
                >
                  <SelectTrigger aria-label={`${labelPrefix} value type ${position}`}>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="string">{valueTypeLabels.string}</SelectItem>
                    <SelectItem value="number">{valueTypeLabels.number}</SelectItem>
                    <SelectItem value="boolean">{valueTypeLabels.boolean}</SelectItem>
                  </SelectContent>
                </Select>
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  onClick={() => commit(rows.filter((candidate) => candidate.id !== row.id))}
                  aria-label={`Remove ${labelPrefix.toLowerCase()} ${position}`}
                  disabled={disabled}
                >
                  <Trash2 className="h-4 w-4" />
                </Button>
                {issues.length > 0 || showManagedWarning ? (
                  <div className="space-y-1 sm:col-span-4">
                    {issues.map((issue) => (
                      <p key={issue} className="text-xs text-destructive" role="alert">
                        {issueMessages[issue]}
                      </p>
                    ))}
                    {showManagedWarning ? (
                      <p className="text-xs text-muted-foreground">{extractionManagedWarning}</p>
                    ) : null}
                  </div>
                ) : null}
              </div>
            )
          })}
        </div>
      )}

      <Button
        type="button"
        variant="outline"
        size="sm"
        onClick={() => setRows([...rows, createMetadataRow()])}
        disabled={disabled}
      >
        <Plus className="mr-2 h-4 w-4" />
        {addLabel}
      </Button>
    </div>
  )
}
