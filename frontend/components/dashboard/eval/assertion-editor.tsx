'use client'

import { useCallback, useState } from 'react'
import { ChevronDown, ChevronUp, Plus, Trash2 } from 'lucide-react'

import { Button } from '@/components/ui/button'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Textarea } from '@/components/ui/textarea'
import { evalsApi } from '@/lib/api'
import type { EvalAssertion, EvalAssertionKind, EvalCase } from '@/lib/api-eval'
import { getApiErrorMessage } from '@/lib/api-error'
import { DocumentPicker } from './document-picker'

const ASSERTION_KIND_LABELS: Record<EvalAssertionKind, string> = {
  retrieval_includes_document: 'Retrieval should include a document',
  retrieval_excludes_document: 'Retrieval should NOT include a document',
  retrieval_top_k_includes_document: 'Document should appear in top-K results',
  retrieval_document_order: 'Documents should appear in order',
  retrieval_chunk_metadata: 'Retrieved chunk should have metadata',
  answer_cites_document: 'Answer should cite a document',
  answer_contains: 'Answer should contain text',
  answer_does_not_contain: 'Answer should NOT contain text',
  llm_judge: 'LLM judge against a reference answer',
}

const ASSERTION_KIND_HINTS: Record<EvalAssertionKind, string> = {
  retrieval_includes_document: 'Pass when at least one chunk from the picked document is retrieved.',
  retrieval_excludes_document: 'Pass when no chunk from the picked document is retrieved.',
  retrieval_top_k_includes_document: 'Pass when a chunk from the picked document is among the first K retrieved chunks.',
  retrieval_document_order: 'Pass when the retrieved evidence contains the selected documents in the expected order.',
  retrieval_chunk_metadata: 'Pass when a retrieved chunk from the selected document has the expected metadata values.',
  answer_cites_document: 'Pass when the generated answer carries a citation to the picked document. Requires full-assistant run mode.',
  answer_contains: 'Pass when the generated answer contains a substring or matches a regex. Requires full-assistant run mode.',
  answer_does_not_contain: 'Pass when the generated answer does NOT contain a substring/regex. Requires full-assistant run mode.',
  llm_judge: 'An LLM compares the generated answer against your reference and returns pass/fail. Requires full-assistant run mode and incurs an extra LLM call.',
}

const createDefaultAssertion = (kind: EvalAssertionKind): EvalAssertion => {
  switch (kind) {
    case 'retrieval_includes_document':
      return { type: 'retrieval_includes_document', documentId: '' }
    case 'retrieval_excludes_document':
      return { type: 'retrieval_excludes_document', documentId: '' }
    case 'retrieval_top_k_includes_document':
      return { type: 'retrieval_top_k_includes_document', documentId: '', k: 3 }
    case 'retrieval_document_order':
      return { type: 'retrieval_document_order', documentIds: [] }
    case 'retrieval_chunk_metadata':
      return { type: 'retrieval_chunk_metadata', documentId: '', metadata: {} }
    case 'answer_cites_document':
      return { type: 'answer_cites_document', documentId: '' }
    case 'answer_contains':
      return { type: 'answer_contains', pattern: '', matchMode: 'substring' }
    case 'answer_does_not_contain':
      return { type: 'answer_does_not_contain', pattern: '', matchMode: 'substring' }
    case 'llm_judge':
      return { type: 'llm_judge', expectedAnswer: '' }
  }
}

const isComplete = (a: EvalAssertion): boolean => {
  switch (a.type) {
    case 'retrieval_includes_document':
    case 'retrieval_excludes_document':
    case 'answer_cites_document':
      return Boolean(a.documentId)
    case 'retrieval_top_k_includes_document':
      return Boolean(a.documentId) && Number.isInteger(a.k) && a.k > 0
    case 'retrieval_document_order':
      return a.documentIds.length > 0 && a.documentIds.every(Boolean)
    case 'retrieval_chunk_metadata':
      return (
        Boolean(a.documentId) &&
        Object.keys(a.metadata).length > 0 &&
        Object.keys(a.metadata).every((key) => key.trim().length > 0)
      )
    case 'answer_contains':
    case 'answer_does_not_contain':
      return Boolean(a.pattern.trim())
    case 'llm_judge':
      return Boolean(a.expectedAnswer.trim())
  }
}

// Every assertion that targets a document (retrieval checks + answer_cites_document)
// renders the same document picker; only top-K adds the extra K field.
type PickerDocumentAssertion = Extract<
  EvalAssertion,
  | { type: 'retrieval_includes_document' }
  | { type: 'retrieval_excludes_document' }
  | { type: 'retrieval_top_k_includes_document' }
  | { type: 'answer_cites_document' }
>

const isDocumentAssertion = (
  a: EvalAssertion,
): a is PickerDocumentAssertion =>
  a.type === 'retrieval_includes_document' ||
  a.type === 'retrieval_excludes_document' ||
  a.type === 'retrieval_top_k_includes_document' ||
  a.type === 'answer_cites_document'

const isAnswerAssertion = (
  a: EvalAssertion,
): a is Extract<EvalAssertion, { pattern: string }> =>
  a.type === 'answer_contains' || a.type === 'answer_does_not_contain'

const isJudgeAssertion = (
  a: EvalAssertion,
): a is Extract<EvalAssertion, { type: 'llm_judge' }> => a.type === 'llm_judge'

interface AssertionEditorProps {
  caseId: string
  initial: EvalAssertion[]
  // Resolves a document UUID into a human-readable title (best-effort).
  resolveDocumentTitle?: (docId: string) => string | undefined
  onSaved: (updated: EvalCase) => void
}

export function AssertionEditor({ caseId, initial, resolveDocumentTitle, onSaved }: AssertionEditorProps) {
  const [assertions, setAssertions] = useState<EvalAssertion[]>(initial)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [dirty, setDirty] = useState(false)

  const updateAt = (index: number, next: EvalAssertion) => {
    setAssertions((prev) => prev.map((a, i) => (i === index ? next : a)))
    setDirty(true)
  }

  const removeAt = (index: number) => {
    setAssertions((prev) => prev.filter((_, i) => i !== index))
    setDirty(true)
  }

  const addAssertion = (kind: EvalAssertionKind) => {
    setAssertions((prev) => [...prev, createDefaultAssertion(kind)])
    setDirty(true)
  }

  const save = useCallback(async () => {
    setError(null)
    setSaving(true)
    try {
      const incomplete = assertions.findIndex((a) => !isComplete(a))
      if (incomplete !== -1) {
        throw new Error(`Expectation #${incomplete + 1} is missing required fields.`)
      }
      const updated = await evalsApi.replaceAssertions(caseId, assertions)
      onSaved(updated)
      setDirty(false)
    } catch (err) {
      setError(getApiErrorMessage(err, 'Failed to save expectations'))
    } finally {
      setSaving(false)
    }
  }, [assertions, caseId, onSaved])

  const reset = () => {
    setAssertions(initial)
    setDirty(false)
    setError(null)
  }

  return (
    <div className="space-y-4">
      {assertions.length === 0 ? (
        <p className="text-sm text-muted-foreground">
          No expectations yet. Add one to grade what each run should produce.
        </p>
      ) : (
        <div className="-mx-6 divide-y divide-border border-y border-border">
          {assertions.map((assertion, index) => (
            <div key={index} className="px-6 py-4">
              <div className="mb-3 flex items-start justify-between gap-3">
                <div className="min-w-0">
                  <div className="text-sm font-medium text-foreground">
                    {ASSERTION_KIND_LABELS[assertion.type]}
                  </div>
                  <div className="mt-0.5 text-xs text-muted-foreground">
                    {ASSERTION_KIND_HINTS[assertion.type]}
                  </div>
                </div>
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => removeAt(index)}
                  disabled={saving}
                  aria-label="Remove expectation"
                >
                  <Trash2 className="size-4" />
                </Button>
              </div>
              <AssertionFields
                assertion={assertion}
                disabled={saving}
                resolveDocumentTitle={resolveDocumentTitle}
                onChange={(next) => updateAt(index, next)}
              />
            </div>
          ))}
        </div>
      )}

      <div className="flex flex-wrap items-center gap-2">
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button variant="outline" size="sm" disabled={saving}>
              <Plus className="mr-1 size-4" /> Add expectation <ChevronDown className="ml-1 size-3" />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="start" className="w-72">
            {(Object.keys(ASSERTION_KIND_LABELS) as EvalAssertionKind[]).map((kind) => (
              <DropdownMenuItem key={kind} onSelect={() => addAssertion(kind)}>
                <div className="space-y-0.5">
                  <div className="text-sm font-medium">{ASSERTION_KIND_LABELS[kind]}</div>
                  <div className="text-xs text-muted-foreground">{ASSERTION_KIND_HINTS[kind]}</div>
                </div>
              </DropdownMenuItem>
            ))}
          </DropdownMenuContent>
        </DropdownMenu>

        <div className="flex-1" />

        {dirty ? (
          <>
            <Button variant="ghost" size="sm" onClick={reset} disabled={saving}>
              Discard
            </Button>
            <Button size="sm" onClick={save} disabled={saving}>
              {saving ? 'Saving…' : 'Save expectations'}
            </Button>
          </>
        ) : null}
      </div>

      {error ? (
        <p className="rounded-md border border-rose-200 bg-rose-50 px-3 py-2 text-sm text-rose-700 dark:border-rose-900/50 dark:bg-rose-950/30 dark:text-rose-300">
          {error}
        </p>
      ) : null}
    </div>
  )
}

interface AssertionFieldsProps {
  assertion: EvalAssertion
  disabled?: boolean
  resolveDocumentTitle?: (docId: string) => string | undefined
  onChange: (next: EvalAssertion) => void
}

function AssertionFields({ assertion, disabled, resolveDocumentTitle, onChange }: AssertionFieldsProps) {
  if (isDocumentAssertion(assertion)) {
    return (
      <RetrievalAssertionFields
        assertion={assertion}
        disabled={disabled}
        resolveDocumentTitle={resolveDocumentTitle}
        onChange={onChange}
      />
    )
  }
  if (isAnswerAssertion(assertion)) {
    return <AnswerAssertionFields assertion={assertion} disabled={disabled} onChange={onChange} />
  }
  if (isJudgeAssertion(assertion)) {
    return <JudgeAssertionFields assertion={assertion} disabled={disabled} onChange={onChange} />
  }
  if (assertion.type === 'retrieval_document_order') {
    return (
      <DocumentOrderAssertionFields
        assertion={assertion}
        disabled={disabled}
        resolveDocumentTitle={resolveDocumentTitle}
        onChange={onChange}
      />
    )
  }
  if (assertion.type === 'retrieval_chunk_metadata') {
    return (
      <ChunkMetadataAssertionFields
        assertion={assertion}
        disabled={disabled}
        resolveDocumentTitle={resolveDocumentTitle}
        onChange={onChange}
      />
    )
  }
  return null
}

function DocumentOrderAssertionFields({
  assertion,
  disabled,
  resolveDocumentTitle,
  onChange,
}: {
  assertion: Extract<EvalAssertion, { type: 'retrieval_document_order' }>
  disabled?: boolean
  resolveDocumentTitle?: (docId: string) => string | undefined
  onChange: (next: EvalAssertion) => void
}) {
  const move = (index: number, delta: -1 | 1) => {
    const target = index + delta
    if (target < 0 || target >= assertion.documentIds.length) {
      return
    }
    const next = [...assertion.documentIds]
    ;[next[index], next[target]] = [next[target]!, next[index]!]
    onChange({ ...assertion, documentIds: next })
  }

  return (
    <div className="space-y-3">
      <Label className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
        Documents in expected order
      </Label>
      {assertion.documentIds.length > 0 ? (
        <ol className="space-y-1.5">
          {assertion.documentIds.map((id, index) => (
            <li
              key={`${id}-${index}`}
              className="flex items-center justify-between gap-2 rounded-md border border-border bg-muted/30 px-3 py-1.5 text-sm"
            >
              <span className="min-w-0 truncate text-foreground">
                {index + 1}. {resolveDocumentTitle?.(id) || <code className="text-xs">{id}</code>}
              </span>
              <span className="flex shrink-0 items-center">
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => move(index, -1)}
                  disabled={disabled || index === 0}
                  aria-label="Move document earlier"
                >
                  <ChevronUp className="size-4" />
                </Button>
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => move(index, 1)}
                  disabled={disabled || index === assertion.documentIds.length - 1}
                  aria-label="Move document later"
                >
                  <ChevronDown className="size-4" />
                </Button>
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() =>
                    onChange({ ...assertion, documentIds: assertion.documentIds.filter((_, i) => i !== index) })
                  }
                  disabled={disabled}
                  aria-label="Remove document from order"
                >
                  <Trash2 className="size-4" />
                </Button>
              </span>
            </li>
          ))}
        </ol>
      ) : (
        <p className="text-xs text-muted-foreground">Pick documents in the order the retrieved evidence should list them.</p>
      )}
      <DocumentPicker
        selectedId={null}
        disabled={disabled}
        onChange={(id) => onChange({ ...assertion, documentIds: [...assertion.documentIds, id] })}
      />
    </div>
  )
}

function ChunkMetadataAssertionFields({
  assertion,
  disabled,
  resolveDocumentTitle,
  onChange,
}: {
  assertion: Extract<EvalAssertion, { type: 'retrieval_chunk_metadata' }>
  disabled?: boolean
  resolveDocumentTitle?: (docId: string) => string | undefined
  onChange: (next: EvalAssertion) => void
}) {
  const entries = Object.entries(assertion.metadata)
  const selectedTitle = assertion.documentId ? resolveDocumentTitle?.(assertion.documentId) : undefined

  const updateEntry = (index: number, key: string, value: string) => {
    const next = entries.map((entry, i) => (i === index ? [key, value] : entry))
    onChange({ ...assertion, metadata: Object.fromEntries(next) })
  }

  return (
    <div className="space-y-3">
      <div className="space-y-1.5">
        <Label className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
          Document
        </Label>
        {assertion.documentId ? (
          <div className="flex items-center justify-between gap-2 rounded-md border border-border bg-muted/30 px-3 py-2 text-sm">
            <span className="min-w-0 truncate text-foreground">
              {selectedTitle || <code className="text-xs">{assertion.documentId}</code>}
            </span>
            <Button
              variant="ghost"
              size="sm"
              onClick={() => onChange({ ...assertion, documentId: '' })}
              disabled={disabled}
            >
              Change
            </Button>
          </div>
        ) : (
          <DocumentPicker
            selectedId={null}
            disabled={disabled}
            onChange={(id) => onChange({ ...assertion, documentId: id })}
          />
        )}
      </div>
      <div className="space-y-1.5">
        <Label className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
          Expected metadata values
        </Label>
        {entries.map(([key, value], index) => (
          <div key={index} className="flex items-center gap-2">
            <Input
              value={key}
              onChange={(e) => updateEntry(index, e.target.value, String(value ?? ''))}
              placeholder="e.g. dateFrom"
              disabled={disabled}
              aria-label="Metadata key"
              className="h-8"
            />
            <Input
              value={String(value ?? '')}
              onChange={(e) => updateEntry(index, key, e.target.value)}
              placeholder="e.g. 2026-08-10"
              disabled={disabled}
              aria-label="Metadata value"
              className="h-8"
            />
            <Button
              variant="ghost"
              size="sm"
              onClick={() =>
                onChange({ ...assertion, metadata: Object.fromEntries(entries.filter((_, i) => i !== index)) })
              }
              disabled={disabled}
              aria-label="Remove metadata expectation"
            >
              <Trash2 className="size-4" />
            </Button>
          </div>
        ))}
        <Button
          variant="outline"
          size="sm"
          onClick={() => onChange({ ...assertion, metadata: { ...assertion.metadata, '': '' } })}
          disabled={disabled || Object.prototype.hasOwnProperty.call(assertion.metadata, '')}
        >
          <Plus className="mr-1 size-4" /> Add value
        </Button>
        <p className="text-xs text-muted-foreground">
          Passes when any retrieved chunk from the document carries every expected value (e.g. dateFrom / dateTo).
        </p>
      </div>
    </div>
  )
}

function JudgeAssertionFields({
  assertion,
  disabled,
  onChange,
}: {
  assertion: Extract<EvalAssertion, { type: 'llm_judge' }>
  disabled?: boolean
  onChange: (next: EvalAssertion) => void
}) {
  return (
    <div className="space-y-3">
      <div className="space-y-1.5">
        <Label htmlFor="judge-expected" className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
          Reference answer (what is considered correct)
        </Label>
        <Textarea
          id="judge-expected"
          value={assertion.expectedAnswer}
          onChange={(e) => onChange({ ...assertion, expectedAnswer: e.target.value })}
          placeholder="Write the answer you would consider correct. The judge LLM will compare the assistant's actual answer against this."
          disabled={disabled}
          rows={4}
          className="min-h-24"
        />
      </div>
      <div className="space-y-1.5">
        <Label htmlFor="judge-criteria" className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
          Additional criteria (optional)
        </Label>
        <Textarea
          id="judge-criteria"
          value={assertion.criteria ?? ''}
          onChange={(e) => onChange({ ...assertion, criteria: e.target.value })}
          placeholder="E.g. 'must mention the 30-day window'; 'ignore phrasing differences'."
          disabled={disabled}
          rows={2}
        />
      </div>
      <p className="text-xs text-muted-foreground">
        Each run with this expectation makes one extra LLM call to compare the new answer against your reference.
      </p>
    </div>
  )
}

function RetrievalAssertionFields({
  assertion,
  disabled,
  resolveDocumentTitle,
  onChange,
}: {
  assertion: PickerDocumentAssertion
  disabled?: boolean
  resolveDocumentTitle?: (docId: string) => string | undefined
  onChange: (next: EvalAssertion) => void
}) {
  const selectedTitle = assertion.documentId ? resolveDocumentTitle?.(assertion.documentId) : undefined

  return (
    <div className="space-y-3">
      <div className="space-y-1.5">
        <Label className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
          Document
        </Label>
        {assertion.documentId ? (
          <div className="flex items-center justify-between gap-2 rounded-md border border-border bg-muted/30 px-3 py-2 text-sm">
            <span className="min-w-0 truncate text-foreground">
              {selectedTitle || <code className="text-xs">{assertion.documentId}</code>}
            </span>
            <Button
              variant="ghost"
              size="sm"
              onClick={() => onChange({ ...assertion, documentId: '' } as EvalAssertion)}
              disabled={disabled}
            >
              Change
            </Button>
          </div>
        ) : (
          <DocumentPicker
            selectedId={null}
            disabled={disabled}
            onChange={(id) => onChange({ ...assertion, documentId: id } as EvalAssertion)}
          />
        )}
      </div>

      {assertion.type === 'retrieval_top_k_includes_document' ? (
        <div className="flex items-center gap-2">
          <Label htmlFor={`topk-${assertion.documentId}`} className="text-xs text-muted-foreground">
            K =
          </Label>
          <Input
            id={`topk-${assertion.documentId}`}
            type="number"
            min={1}
            max={50}
            value={assertion.k}
            onChange={(e) => {
              const next = Number.parseInt(e.target.value, 10)
              if (Number.isFinite(next) && next > 0) {
                onChange({ ...assertion, k: next })
              }
            }}
            disabled={disabled}
            className="h-7 w-20"
          />
          <span className="text-xs text-muted-foreground">(check the first {assertion.k} retrieved chunks)</span>
        </div>
      ) : null}
    </div>
  )
}

function AnswerAssertionFields({
  assertion,
  disabled,
  onChange,
}: {
  assertion: Extract<EvalAssertion, { pattern: string }>
  disabled?: boolean
  onChange: (next: EvalAssertion) => void
}) {
  return (
    <div className="space-y-3">
      <div className="space-y-1.5">
        <Label htmlFor={`pattern-${assertion.type}`} className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
          {assertion.matchMode === 'regex' ? 'Regex pattern' : 'Text to find'}
        </Label>
        <Input
          id={`pattern-${assertion.type}`}
          value={assertion.pattern}
          onChange={(e) => onChange({ ...assertion, pattern: e.target.value })}
          placeholder={
            assertion.matchMode === 'regex'
              ? 'e.g. \\b30\\s*days?\\b'
              : 'e.g. 30 days'
          }
          disabled={disabled}
        />
      </div>
      <div className="flex flex-wrap items-center gap-3">
        <div className="flex items-center gap-2 text-xs">
          <span className="text-muted-foreground">Match mode:</span>
          {(['substring', 'regex'] as const).map((mode) => (
            <button
              key={mode}
              type="button"
              disabled={disabled}
              onClick={() => onChange({ ...assertion, matchMode: mode })}
              className={`rounded-md border px-2 py-0.5 transition-colors ${
                assertion.matchMode === mode
                  ? 'border-primary bg-accent text-foreground'
                  : 'border-border bg-background text-muted-foreground hover:bg-accent/50'
              }`}
            >
              {mode}
            </button>
          ))}
        </div>
        <label className="flex items-center gap-2 text-xs text-muted-foreground">
          <input
            type="checkbox"
            checked={Boolean(assertion.caseSensitive)}
            onChange={(e) => onChange({ ...assertion, caseSensitive: e.target.checked })}
            disabled={disabled}
          />
          Case sensitive
        </label>
      </div>
      <p className="text-xs text-muted-foreground">
        Grades the generated answer when the case runs. The run automatically uses full-assistant mode so the assistant actually answers.
      </p>
    </div>
  )
}
