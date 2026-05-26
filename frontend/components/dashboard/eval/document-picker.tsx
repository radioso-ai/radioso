'use client'

import { useCallback, useEffect, useMemo, useState } from 'react'
import { Check, FileText, Search } from 'lucide-react'

import { Input } from '@/components/ui/input'
import { documentsApi } from '@/lib/api'
import type { DocumentSummary } from '@/lib/api-types'
import { getApiErrorMessage } from '@/lib/api-error'

const DOCUMENT_FETCH_LIMIT = 100
const MAX_DOCUMENT_PAGES = 10

interface DocumentPickerProps {
  selectedId: string | null
  onChange: (id: string, title: string) => void
  disabled?: boolean
  height?: string
}

interface DocumentLoadResult {
  documents: DocumentSummary[]
  hasMore: boolean
}

const loadAllDocuments = async (): Promise<DocumentLoadResult> => {
  const collected: DocumentSummary[] = []
  let cursor: string | undefined
  let hasMore = false
  for (let page = 0; page < MAX_DOCUMENT_PAGES; page++) {
    const response = await documentsApi.listDocuments({
      limit: DOCUMENT_FETCH_LIMIT,
      ...(cursor ? { cursor } : {}),
    })
    collected.push(...(response.documents ?? []))
    hasMore = Boolean(response.hasMore)
    if (!hasMore || !response.nextCursor) break
    cursor = response.nextCursor
  }
  return { documents: collected, hasMore }
}

export function DocumentPicker({
  selectedId,
  onChange,
  disabled,
  height = 'max-h-56',
}: DocumentPickerProps) {
  const [documents, setDocuments] = useState<DocumentSummary[] | null>(null)
  const [moreAvailable, setMoreAvailable] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [filter, setFilter] = useState('')

  const load = useCallback(async () => {
    try {
      const result = await loadAllDocuments()
      setDocuments(result.documents)
      setMoreAvailable(result.hasMore)
      setError(null)
    } catch (err) {
      setError(getApiErrorMessage(err, 'Failed to load documents'))
      setDocuments([])
    }
  }, [])

  useEffect(() => {
    void load()
  }, [load])

  const filtered = useMemo(() => {
    if (!documents) return []
    const q = filter.trim().toLowerCase()
    if (!q) return documents.slice(0, 50)
    return documents.filter((d) => d.title?.toLowerCase().includes(q)).slice(0, 50)
  }, [documents, filter])

  return (
    <div className="space-y-2">
      <div className="relative">
        <Search className="pointer-events-none absolute left-2.5 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
        <Input
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
          placeholder="Search documents by title"
          className="pl-8"
          disabled={disabled}
        />
      </div>
      <div className={`${height} overflow-y-auto rounded-md border border-border bg-background`}>
        {documents === null ? (
          <p className="px-3 py-6 text-center text-sm text-muted-foreground">Loading documents…</p>
        ) : error ? (
          <p className="px-3 py-6 text-center text-sm text-rose-600">{error}</p>
        ) : filtered.length === 0 ? (
          <p className="px-3 py-6 text-center text-sm text-muted-foreground">
            {filter ? 'No documents match that query.' : 'No documents in this workspace yet.'}
          </p>
        ) : (
          <ul className="divide-y divide-border">
            {filtered.map((doc) => {
              const isSelected = doc.id === selectedId
              return (
                <li key={doc.id}>
                  <button
                    type="button"
                    disabled={disabled}
                    onClick={() => onChange(doc.id, doc.title || 'Untitled')}
                    className={`flex w-full items-center gap-3 px-3 py-2 text-left text-sm transition-colors ${
                      isSelected ? 'bg-accent text-foreground' : 'text-foreground hover:bg-accent/60'
                    }`}
                  >
                    <FileText
                      className={`size-4 shrink-0 ${isSelected ? 'text-primary' : 'text-muted-foreground'}`}
                      aria-hidden
                    />
                    <span className="min-w-0 flex-1 truncate">{doc.title || 'Untitled'}</span>
                    {isSelected ? <Check className="size-4 shrink-0 text-primary" aria-hidden /> : null}
                  </button>
                </li>
              )
            })}
          </ul>
        )}
      </div>
      {moreAvailable ? (
        <p className="text-xs text-muted-foreground">
          Showing the first {documents?.length ?? 0} documents. Refine your search if the one you want isn't listed.
        </p>
      ) : null}
    </div>
  )
}
