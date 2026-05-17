'use client'

import { useCallback, useEffect, useState } from 'react'
import { ArrowLeft, ChevronRight } from 'lucide-react'

import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from '@/components/ui/sheet'
import { Spinner } from '@/components/ui/spinner'
import { documentsApi } from '@/lib/api'
import type {
  DocumentChunkDetail,
  DocumentChunkSummary,
} from '@/lib/api'

type ChunkInspectorRequest = {
  documentId: string
  documentTitle?: string | null
  initialChunkId?: string | null
} | null

export function ChunkInspectorSheet({
  request,
  onOpenChange,
}: {
  request: ChunkInspectorRequest
  onOpenChange: (open: boolean) => void
}) {
  const open = request !== null

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent side="right" className="w-full max-w-none sm:max-w-2xl">
        {request ? (
          <ChunkInspectorBody
            key={`${request.documentId}:${request.initialChunkId ?? ''}`}
            documentId={request.documentId}
            documentTitle={request.documentTitle ?? null}
            initialChunkId={request.initialChunkId ?? null}
          />
        ) : null}
      </SheetContent>
    </Sheet>
  )
}

function ChunkInspectorBody({
  documentId,
  documentTitle,
  initialChunkId,
}: {
  documentId: string
  documentTitle: string | null
  initialChunkId: string | null
}) {
  const [chunks, setChunks] = useState<DocumentChunkSummary[]>([])
  const [listLoading, setListLoading] = useState(false)
  const [listError, setListError] = useState<string | null>(null)
  const [selectedChunkId, setSelectedChunkId] = useState<string | null>(initialChunkId)
  const [chunkDetail, setChunkDetail] = useState<DocumentChunkDetail | null>(null)
  const [detailLoading, setDetailLoading] = useState(false)
  const [detailError, setDetailError] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false
    const load = async () => {
      setListLoading(true)
      setListError(null)
      try {
        const response = await documentsApi.listDocumentChunks(documentId)
        if (!cancelled) setChunks(response.chunks)
      } catch (error: unknown) {
        if (!cancelled) {
          setListError(error instanceof Error ? error.message : 'Failed to load chunks')
        }
      } finally {
        if (!cancelled) setListLoading(false)
      }
    }
    void load()
    return () => {
      cancelled = true
    }
  }, [documentId])

  useEffect(() => {
    if (!selectedChunkId) return
    let cancelled = false
    const load = async () => {
      setDetailLoading(true)
      setDetailError(null)
      setChunkDetail(null)
      try {
        const detail = await documentsApi.getDocumentChunk(documentId, selectedChunkId)
        if (!cancelled) setChunkDetail(detail)
      } catch (error: unknown) {
        if (!cancelled) {
          setDetailError(error instanceof Error ? error.message : 'Failed to load chunk')
        }
      } finally {
        if (!cancelled) setDetailLoading(false)
      }
    }
    void load()
    return () => {
      cancelled = true
    }
  }, [documentId, selectedChunkId])

  const handleSelectChunk = useCallback((chunkId: string) => {
    setSelectedChunkId(chunkId)
  }, [])

  const handleBackToList = useCallback(() => {
    setSelectedChunkId(null)
    setChunkDetail(null)
    setDetailError(null)
  }, [])

  return (
    <>
      <SheetHeader>
        <SheetTitle>
          {selectedChunkId
            ? `Chunk #${chunkDetail?.chunkIndex ?? '…'}`
            : 'Document chunks'}
        </SheetTitle>
        <SheetDescription>
          {documentTitle ? (
            <span className="truncate">{documentTitle}</span>
          ) : (
            'Inspect how the document was split for retrieval.'
          )}
        </SheetDescription>
      </SheetHeader>

      <div className="flex-1 overflow-y-auto px-4 pb-6">
        {selectedChunkId ? (
          <ChunkDetailView
            detail={chunkDetail}
            loading={detailLoading}
            error={detailError}
            onBack={handleBackToList}
          />
        ) : (
          <ChunkListView
            chunks={chunks}
            loading={listLoading}
            error={listError}
            onSelect={handleSelectChunk}
          />
        )}
      </div>
    </>
  )
}

function ChunkListView({
  chunks,
  loading,
  error,
  onSelect,
}: {
  chunks: DocumentChunkSummary[]
  loading: boolean
  error: string | null
  onSelect: (chunkId: string) => void
}) {
  if (loading) {
    return (
      <div className="flex h-32 items-center justify-center">
        <Spinner className="h-5 w-5" />
      </div>
    )
  }

  if (error) {
    return (
      <p className="rounded-md border border-destructive/40 bg-destructive/10 p-3 text-sm text-destructive">
        {error}
      </p>
    )
  }

  if (chunks.length === 0) {
    return (
      <p className="rounded-md border border-dashed border-border p-3 text-sm text-muted-foreground">
        This document has no chunks yet. It may still be processing.
      </p>
    )
  }

  return (
    <div className="space-y-2">
      <p className="text-xs text-muted-foreground">{chunks.length} chunk{chunks.length === 1 ? '' : 's'}</p>
      <ul className="space-y-2">
        {chunks.map((chunk) => (
          <li key={chunk.id}>
            <button
              type="button"
              onClick={() => onSelect(chunk.id)}
              className="group flex w-full items-start justify-between gap-3 rounded-md border border-border/70 bg-background/70 p-3 text-left transition hover:border-border hover:bg-accent/40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            >
              <div className="min-w-0 flex-1 space-y-1">
                <div className="flex items-center gap-2 text-xs text-muted-foreground">
                  <span className="font-mono">#{chunk.chunkIndex}</span>
                  <span>·</span>
                  <span>{chunk.contentLength.toLocaleString()} chars</span>
                  <span>·</span>
                  <span>offsets {chunk.startOffset}–{chunk.endOffset}</span>
                </div>
                <p className="line-clamp-3 text-sm text-foreground whitespace-pre-wrap break-words">
                  {chunk.contentPreview}
                </p>
              </div>
              <ChevronRight className="mt-1 h-4 w-4 shrink-0 text-muted-foreground transition group-hover:text-foreground" />
            </button>
          </li>
        ))}
      </ul>
    </div>
  )
}

function ChunkDetailView({
  detail,
  loading,
  error,
  onBack,
}: {
  detail: DocumentChunkDetail | null
  loading: boolean
  error: string | null
  onBack: () => void
}) {
  return (
    <div className="space-y-3">
      <button
        type="button"
        onClick={onBack}
        className="inline-flex items-center gap-1.5 text-xs text-muted-foreground hover:text-foreground"
      >
        <ArrowLeft className="h-3.5 w-3.5" />
        Back to chunk list
      </button>

      {loading ? (
        <div className="flex h-32 items-center justify-center">
          <Spinner className="h-5 w-5" />
        </div>
      ) : error ? (
        <p className="rounded-md border border-destructive/40 bg-destructive/10 p-3 text-sm text-destructive">
          {error}
        </p>
      ) : detail ? (
        <ChunkDetailBody detail={detail} />
      ) : null}
    </div>
  )
}

function ChunkDetailBody({ detail }: { detail: DocumentChunkDetail }) {
  const hasMetadata = Object.keys(detail.metadata ?? {}).length > 0
  const hasDistinctSearchText =
    typeof detail.searchText === 'string' && detail.searchText.trim() !== detail.content.trim()

  return (
    <div className="space-y-3">
      <dl className="grid grid-cols-2 gap-2 rounded-md border border-border/70 bg-background/70 p-3 text-xs">
        <Field label="Chunk index" value={`#${detail.chunkIndex}`} />
        <Field label="Length" value={`${detail.content.length.toLocaleString()} chars`} />
        <Field label="Offsets" value={`${detail.startOffset}–${detail.endOffset}`} />
        <Field
          label="Embedding"
          value={detail.embeddingDimensions !== null ? `${detail.embeddingDimensions} dims` : '—'}
        />
        <Field label="Chunk id" value={<code className="break-all font-mono text-[11px]">{detail.id}</code>} />
        <Field label="Created" value={new Date(detail.createdAt).toLocaleString()} />
      </dl>

      <section className="space-y-1">
        <p className="text-xs font-medium text-foreground">Content</p>
        <pre className="max-h-[40vh] overflow-y-auto whitespace-pre-wrap break-words rounded-md border border-border/70 bg-background/70 p-3 text-sm text-foreground">
          {detail.content}
        </pre>
      </section>

      {hasDistinctSearchText ? (
        <section className="space-y-1">
          <p className="text-xs font-medium text-foreground">Search text</p>
          <pre className="max-h-[24vh] overflow-y-auto whitespace-pre-wrap break-words rounded-md border border-border/70 bg-background/70 p-3 text-xs text-muted-foreground">
            {detail.searchText}
          </pre>
        </section>
      ) : null}

      {hasMetadata ? (
        <section className="space-y-1">
          <p className="text-xs font-medium text-foreground">Metadata</p>
          <pre className="max-h-[20vh] overflow-x-auto rounded-md border border-border/70 bg-background/70 p-3 text-[11px] text-muted-foreground">
            {JSON.stringify(detail.metadata, null, 2)}
          </pre>
        </section>
      ) : null}
    </div>
  )
}

function Field({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div className="min-w-0 space-y-0.5">
      <dt className="text-[10px] uppercase tracking-wide text-muted-foreground">{label}</dt>
      <dd className="truncate text-xs text-foreground">{value}</dd>
    </div>
  )
}

export type { ChunkInspectorRequest }
