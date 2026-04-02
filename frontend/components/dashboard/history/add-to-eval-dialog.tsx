'use client'

import { useEffect, useState } from 'react'

import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Spinner } from '@/components/ui/spinner'
import { Textarea } from '@/components/ui/textarea'
import { type EvalDatasetSummary, type EvalImportDraft, evalApi } from '@/lib/api'
import { getApiErrorMessage } from '@/lib/api-error'

export function AddToEvalDialog({
  open,
  conversationId,
  assistantMessageId,
  onOpenChange,
  onSaved,
}: {
  open: boolean
  conversationId: string | null
  assistantMessageId: string | null
  onOpenChange: (open: boolean) => void
  onSaved?: (datasetId: string) => void
}) {
  const [datasets, setDatasets] = useState<EvalDatasetSummary[]>([])
  const [selectedDatasetId, setSelectedDatasetId] = useState<string>('')
  const [importDraft, setImportDraft] = useState<EvalImportDraft | null>(null)
  const [title, setTitle] = useState('')
  const [query, setQuery] = useState('')
  const [context, setContext] = useState<Array<{ role: 'user' | 'assistant' | 'system'; content: string }>>([])
  const [isLoading, setIsLoading] = useState(false)
  const [isSaving, setIsSaving] = useState(false)
  const [isCreatingDataset, setIsCreatingDataset] = useState(false)
  const [newDatasetName, setNewDatasetName] = useState('')
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    if (!open || !conversationId || !assistantMessageId) {
      return
    }

    let active = true

    const load = async () => {
      setIsLoading(true)
      setError(null)
      try {
        const [datasetResponse, importResponse] = await Promise.all([
          evalApi.listDatasets(),
          evalApi.importChatHistory({ conversationId, assistantMessageId }),
        ])
        if (!active) return
        setDatasets(datasetResponse.datasets)
        setSelectedDatasetId((current) => current || datasetResponse.datasets[0]?.id || '')
        setImportDraft(importResponse.importDraft)
        setTitle(importResponse.importDraft.title)
        setQuery(importResponse.importDraft.query)
        setContext(importResponse.importDraft.conversationContext)
      } catch (nextError) {
        if (!active) return
        setError(getApiErrorMessage(nextError, 'Failed to prepare eval import.'))
      } finally {
        if (active) setIsLoading(false)
      }
    }

    void load()
    return () => {
      active = false
    }
  }, [assistantMessageId, conversationId, open])

  const handleCreateDataset = async () => {
    if (!newDatasetName.trim()) {
      return
    }
    setIsCreatingDataset(true)
    setError(null)
    try {
      const dataset = await evalApi.createDataset({ name: newDatasetName.trim() })
      setDatasets((current) => [dataset, ...current])
      setSelectedDatasetId(dataset.id)
      setNewDatasetName('')
    } catch (nextError) {
      setError(getApiErrorMessage(nextError, 'Failed to create dataset.'))
    } finally {
      setIsCreatingDataset(false)
    }
  }

  const handleSave = async () => {
    if (!selectedDatasetId || !importDraft) {
      return
    }
    setIsSaving(true)
    setError(null)
    try {
      await evalApi.createCase(selectedDatasetId, {
        title,
        query,
        conversationContext: context,
        sourceType: importDraft.sourceType,
        expectations: importDraft.seededExpectations,
        provenance: importDraft.provenance,
      })
      onSaved?.(selectedDatasetId)
      onOpenChange(false)
    } catch (nextError) {
      setError(getApiErrorMessage(nextError, 'Failed to save eval case.'))
    } finally {
      setIsSaving(false)
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-2xl">
        <DialogHeader>
          <DialogTitle>Add To Eval Dataset</DialogTitle>
          <DialogDescription>
            Promote this conversation turn into a replayable eval case.
          </DialogDescription>
        </DialogHeader>

        {isLoading ? (
          <div className="flex items-center justify-center py-8">
            <Spinner className="h-5 w-5" />
          </div>
        ) : (
          <div className="space-y-4">
            {error ? (
              <div className="rounded-lg border border-destructive/40 bg-destructive/10 p-3 text-sm text-destructive">
                {error}
              </div>
            ) : null}

            <div className="grid gap-3 sm:grid-cols-[1fr_auto]">
              <div className="space-y-2">
                <p className="text-sm font-medium text-foreground">Dataset</p>
                <Select value={selectedDatasetId} onValueChange={setSelectedDatasetId}>
                  <SelectTrigger>
                    <SelectValue placeholder="Select dataset" />
                  </SelectTrigger>
                  <SelectContent>
                    {datasets.map((dataset) => (
                      <SelectItem key={dataset.id} value={dataset.id}>
                        {dataset.name}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <div className="space-y-2">
                <p className="text-sm font-medium text-foreground">Create dataset</p>
                <div className="flex gap-2">
                  <Input
                    value={newDatasetName}
                    onChange={(event) => setNewDatasetName(event.target.value)}
                    placeholder="New dataset"
                  />
                  <Button type="button" variant="outline" onClick={() => void handleCreateDataset()} disabled={isCreatingDataset || !newDatasetName.trim()}>
                    New
                  </Button>
                </div>
              </div>
            </div>

            <div className="space-y-2">
              <p className="text-sm font-medium text-foreground">Case title</p>
              <Input value={title} onChange={(event) => setTitle(event.target.value)} />
            </div>

            <div className="space-y-2">
              <p className="text-sm font-medium text-foreground">Query</p>
              <Textarea value={query} onChange={(event) => setQuery(event.target.value)} rows={3} />
            </div>

            <div className="space-y-2">
              <p className="text-sm font-medium text-foreground">Context</p>
              <div className="max-h-64 space-y-3 overflow-y-auto rounded-lg border border-border p-3">
                {context.length === 0 ? (
                  <p className="text-sm text-muted-foreground">This case does not need prior context.</p>
                ) : context.map((message, index) => (
                  <div key={`${message.role}-${index}`} className="space-y-1">
                    <p className="text-xs uppercase tracking-wide text-muted-foreground">{message.role}</p>
                    <Textarea
                      value={message.content}
                      onChange={(event) => {
                        setContext((current) => current.map((entry, entryIndex) => (
                          entryIndex === index
                            ? { ...entry, content: event.target.value }
                            : entry
                        )))
                      }}
                      rows={3}
                    />
                  </div>
                ))}
              </div>
            </div>

            {importDraft?.unavailable.length ? (
              <p className="text-xs text-muted-foreground">
                Unavailable historical diagnostics: {importDraft.unavailable.join(', ')}
              </p>
            ) : null}

            <div className="flex justify-end gap-2">
              <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
                Cancel
              </Button>
              <Button type="button" onClick={() => void handleSave()} disabled={isSaving || !selectedDatasetId || !title.trim() || !query.trim()}>
                {isSaving ? 'Saving...' : 'Save case'}
              </Button>
            </div>
          </div>
        )}
      </DialogContent>
    </Dialog>
  )
}
