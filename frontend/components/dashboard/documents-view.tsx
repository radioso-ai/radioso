'use client'

import { useEffect, useState } from 'react'
import { Check, FileText, Pencil, Plus, RefreshCw } from 'lucide-react'

import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Spinner } from '@/components/ui/spinner'
import { Textarea } from '@/components/ui/textarea'
import {
  type DocumentSummary,
  documentsApi,
} from '@/lib/api'

type EditorMode = 'create' | 'edit'

const EMPTY_FORM = {
  title: '',
  content: '',
}

const getRagLabel = (document: Pick<DocumentSummary, 'status' | 'ragStatus'>) => {
  if (document.ragStatus === 'processed' && document.status === 'ready') {
    return 'RAG processed'
  }

  return `RAG ${document.status === 'ready' ? 'pending' : document.status}`
}

export function DocumentsView() {
  const [documents, setDocuments] = useState<DocumentSummary[]>([])
  const [isLoading, setIsLoading] = useState(true)
  const [isSaving, setIsSaving] = useState(false)
  const [isDialogOpen, setIsDialogOpen] = useState(false)
  const [isDocumentLoading, setIsDocumentLoading] = useState(false)
  const [editorMode, setEditorMode] = useState<EditorMode>('create')
  const [editingDocumentId, setEditingDocumentId] = useState<string | null>(null)
  const [formValues, setFormValues] = useState(EMPTY_FORM)

  const loadDocuments = async () => {
    try {
      const docs = await documentsApi.listDocuments()
      setDocuments(docs)
    } catch (error) {
      console.error('Failed to load documents:', error)
    } finally {
      setIsLoading(false)
    }
  }

  useEffect(() => {
    loadDocuments()
  }, [])

  const resetEditor = () => {
    setEditorMode('create')
    setEditingDocumentId(null)
    setFormValues(EMPTY_FORM)
    setIsDocumentLoading(false)
  }

  const openCreateDialog = () => {
    resetEditor()
    setIsDialogOpen(true)
  }

  const openEditDialog = async (documentId: string) => {
    setIsDialogOpen(true)
    setEditorMode('edit')
    setEditingDocumentId(documentId)
    setIsDocumentLoading(true)

    try {
      const document = await documentsApi.getDocument(documentId)
      setFormValues({
        title: document.title,
        content: document.content,
      })
    } catch (error) {
      console.error('Failed to load document:', error)
      setIsDialogOpen(false)
      resetEditor()
    } finally {
      setIsDocumentLoading(false)
    }
  }

  const upsertDocument = async (documentId: string) => {
    const nextDocument = await documentsApi.getDocument(documentId)
    setDocuments((currentDocuments) => {
      const withoutCurrent = currentDocuments.filter((document) => document.id !== documentId)
      return [nextDocument, ...withoutCurrent].sort(
        (left, right) => new Date(right.updatedAt).getTime() - new Date(left.updatedAt).getTime(),
      )
    })
  }

  const handleDialogChange = (open: boolean) => {
    setIsDialogOpen(open)
    if (!open && !isSaving) {
      resetEditor()
    }
  }

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    if (!formValues.title.trim() || !formValues.content.trim()) return

    setIsSaving(true)

    try {
      const payload = {
        title: formValues.title.trim(),
        content: formValues.content.trim(),
      }
      const response = editingDocumentId
        ? await documentsApi.updateDocument(editingDocumentId, payload)
        : await documentsApi.createDocument(payload)

      await upsertDocument(response.documentId)
      setIsDialogOpen(false)
      resetEditor()
    } catch (error) {
      console.error(`Failed to ${editingDocumentId ? 'update' : 'create'} document:`, error)
    } finally {
      setIsSaving(false)
    }
  }

  const formatDate = (date: string) => {
    return new Intl.DateTimeFormat('en-US', {
      month: 'short',
      day: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
    }).format(new Date(date))
  }

  const renderDialogBody = () => {
    if (isDocumentLoading) {
      return (
        <div className="flex flex-1 min-h-[240px] items-center justify-center">
          <Spinner className="w-6 h-6" />
        </div>
      )
    }

    return (
      <form onSubmit={handleSubmit} className="mt-4 flex min-h-0 flex-1 flex-col overflow-hidden">
        <div className="flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto pr-1">
          <div className="space-y-2 flex-shrink-0">
            <Label htmlFor="title">Title</Label>
            <Input
              id="title"
              value={formValues.title}
              onChange={(e) => setFormValues((current) => ({ ...current, title: e.target.value }))}
              placeholder="Document title"
              disabled={isSaving}
            />
          </div>
          <div className="flex min-h-0 flex-1 flex-col space-y-2">
            <Label htmlFor="content">Content</Label>
            <Textarea
              id="content"
              value={formValues.content}
              onChange={(e) => setFormValues((current) => ({ ...current, content: e.target.value }))}
              placeholder="Paste your document content here..."
              className="h-full min-h-[320px] flex-1 resize-none overflow-y-auto [field-sizing:fixed]"
              disabled={isSaving}
            />
          </div>
        </div>
        <div className="mt-4 flex flex-shrink-0 justify-end gap-2 border-t pt-4">
          <Button
            type="button"
            variant="outline"
            onClick={() => handleDialogChange(false)}
            disabled={isSaving}
          >
            Cancel
          </Button>
          <Button
            type="submit"
            disabled={isSaving || !formValues.title.trim() || !formValues.content.trim()}
          >
            {isSaving ? <Spinner className="mr-2" /> : null}
            {editorMode === 'edit' ? 'Save Document' : 'Add Document'}
          </Button>
        </div>
      </form>
    )
  }

  return (
    <div className="flex h-full flex-col">
      <div className="flex items-center justify-between border-b border-border px-6 py-4">
        <div>
          <h1 className="text-lg font-medium text-foreground">Documents</h1>
          <p className="text-sm text-muted-foreground">Manage your knowledge base</p>
        </div>
        <Button size="sm" onClick={openCreateDialog}>
          <Plus className="mr-2 h-4 w-4" />
          Add Document
        </Button>
      </div>

      <Dialog open={isDialogOpen} onOpenChange={handleDialogChange}>
        <DialogContent className="flex h-[min(85vh,760px)] max-h-[85vh] flex-col overflow-hidden sm:max-w-2xl">
          <DialogHeader>
            <DialogTitle>{editorMode === 'edit' ? 'Edit Document' : 'Add Document'}</DialogTitle>
            <DialogDescription>
              {editorMode === 'edit'
                ? 'Update the document and re-run it through the RAG ingestion pipeline.'
                : 'Add a new document to your knowledge base for retrieval.'}
            </DialogDescription>
          </DialogHeader>
          {renderDialogBody()}
        </DialogContent>
      </Dialog>

      <div className="flex-1 overflow-y-auto p-6">
        {isLoading ? (
          <div className="flex h-full items-center justify-center">
            <Spinner className="h-6 w-6" />
          </div>
        ) : documents.length === 0 ? (
          <div className="flex h-full flex-col items-center justify-center text-center">
            <div className="mb-4 flex h-12 w-12 items-center justify-center rounded-full bg-primary/10">
              <FileText className="h-5 w-5 text-primary" />
            </div>
            <h2 className="mb-1 text-lg font-medium text-foreground">No documents yet</h2>
            <p className="mb-4 max-w-sm text-sm text-muted-foreground">
              Add documents to your knowledge base to start asking questions.
            </p>
            <Button size="sm" onClick={openCreateDialog}>
              <Plus className="mr-2 h-4 w-4" />
              Add your first document
            </Button>
          </div>
        ) : (
          <div className="grid max-w-3xl gap-3">
            {documents.map((doc) => (
              <button
                key={doc.id}
                type="button"
                onClick={() => openEditDialog(doc.id)}
                className="flex cursor-pointer items-center gap-4 rounded-lg border border-border bg-card p-4 text-left transition-colors hover:border-primary/50 hover:bg-accent/20"
              >
                <div className="flex h-10 w-10 flex-shrink-0 items-center justify-center rounded bg-muted">
                  <FileText className="h-5 w-5 text-muted-foreground" />
                </div>
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2">
                    <h3 className="truncate font-medium text-foreground">{doc.title}</h3>
                    <Pencil className="h-3.5 w-3.5 text-muted-foreground" />
                  </div>
                  <p className="text-sm text-muted-foreground">
                    Updated {formatDate(doc.updatedAt)}
                  </p>
                </div>
                <div className="flex flex-col items-end gap-1 text-sm">
                  <div className="flex items-center gap-1 text-foreground">
                    {doc.ragStatus === 'processed' ? (
                      <Check className="h-4 w-4 text-green-500" />
                    ) : (
                      <RefreshCw className="h-4 w-4 text-amber-500" />
                    )}
                    <span>{getRagLabel(doc)}</span>
                  </div>
                  <span className="text-xs uppercase tracking-[0.16em] text-muted-foreground">
                    {doc.status}
                  </span>
                </div>
              </button>
            ))}
          </div>
        )}
      </div>
    </div>
  )
}
