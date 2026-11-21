'use client'

import { useCallback, useEffect, useState } from 'react'
import { ArrowLeft, CheckCircle2, Plus } from 'lucide-react'

import { ConfirmDeleteDialog } from '@/components/dashboard/settings/confirm-delete-dialog'
import { QuietList, QuietListRow } from '@/components/dashboard/settings/quiet-list'
import { Button } from '@/components/ui/button'
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from '@/components/ui/sheet'
import { Spinner } from '@/components/ui/spinner'
import { getApiErrorMessage } from '@/lib/api-error'
import { apiConnectionsApi, skillsBlockingDelete, type ApiConnection } from '@/lib/api-connections'
import { ApiConnectionForm } from './ApiConnectionForm'
import {
  buildConnectionInput,
  buildCreateConnectionInput,
  canSaveConnection,
  connectionDraftFrom,
  emptyConnectionDraft,
  type ApiConnectionDraft,
} from './api-connection-form-model'

// What the panel shows: the list, a new connection's form, or one connection's form.
type View = { kind: 'list' } | { kind: 'new' } | { kind: 'edit'; connectionId: string }

const deleteFailureMessage = (error: unknown): string => {
  const skills = skillsBlockingDelete(error)
  if (skills) {
    return skills.length > 0
      ? `Used by ${skills.join(', ')}. Delete or retarget those skills first.`
      : 'Used by skills. Delete or retarget them first.'
  }
  return getApiErrorMessage(error, 'Failed to delete API connection.')
}

function ApiConnectionsSection({ onChanged }: { onChanged?: () => void }) {
  const [connections, setConnections] = useState<ApiConnection[]>([])
  const [isLoading, setIsLoading] = useState(true)
  const [isSaving, setIsSaving] = useState(false)
  const [isDeleting, setIsDeleting] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [view, setView] = useState<View>({ kind: 'list' })
  const [draft, setDraft] = useState<ApiConnectionDraft>(emptyConnectionDraft)
  const [confirmingDelete, setConfirmingDelete] = useState(false)

  const load = useCallback(async () => {
    try {
      setConnections(await apiConnectionsApi.list())
      setError(null)
    } catch (loadError) {
      setError(getApiErrorMessage(loadError, 'Failed to load API connections.'))
    } finally {
      setIsLoading(false)
    }
  }, [])

  useEffect(() => {
    queueMicrotask(() => void load())
  }, [load])

  const editing = view.kind === 'edit' ? connections.find((connection) => connection.id === view.connectionId) ?? null : null

  const openNew = () => {
    setError(null)
    setDraft(emptyConnectionDraft())
    setView({ kind: 'new' })
  }
  const openEdit = (connection: ApiConnection) => {
    setError(null)
    setDraft(connectionDraftFrom(connection))
    setView({ kind: 'edit', connectionId: connection.id })
  }
  const backToList = () => {
    setError(null)
    setView({ kind: 'list' })
  }

  const save = async () => {
    setIsSaving(true)
    setError(null)
    try {
      if (editing) await apiConnectionsApi.update(editing.id, buildConnectionInput(draft))
      else await apiConnectionsApi.create(buildCreateConnectionInput(draft))
      await load()
      onChanged?.()
      setView({ kind: 'list' })
    } catch (saveError) {
      setError(getApiErrorMessage(saveError, 'Failed to save API connection.'))
    } finally {
      setIsSaving(false)
    }
  }

  const remove = async () => {
    if (!editing) return
    setIsDeleting(true)
    try {
      await apiConnectionsApi.remove(editing.id)
      await load()
      onChanged?.()
      setView({ kind: 'list' })
    } catch (deleteError) {
      setError(deleteFailureMessage(deleteError))
    } finally {
      setIsDeleting(false)
      setConfirmingDelete(false)
    }
  }

  if (isLoading) {
    return (
      <div className="flex items-center gap-2 text-sm text-muted-foreground">
        <Spinner className="h-4 w-4" />
        Loading connections...
      </div>
    )
  }

  if (view.kind === 'list') {
    return (
      <div className="space-y-4">
        {error ? <p className="text-sm text-destructive" role="alert">{error}</p> : null}
        {connections.length > 0 ? (
          <QuietList>
            {connections.map((connection) => (
              <QuietListRow
                key={connection.id}
                domId={`api-connection-row-${connection.id}`}
                title={connection.name}
                summary={connection.baseUrl}
                onOpen={() => openEdit(connection)}
              />
            ))}
          </QuietList>
        ) : null}
        <Button type="button" variant="outline" size="sm" onClick={openNew}>
          <Plus className="h-4 w-4" />
          Add API connection
        </Button>
      </div>
    )
  }

  return (
    <div className="space-y-4">
      <Button type="button" variant="ghost" size="sm" onClick={backToList}>
        <ArrowLeft className="h-4 w-4" />
        Connections
      </Button>
      {error ? <p className="text-sm text-destructive" role="alert">{error}</p> : null}
      <ApiConnectionForm draft={draft} existing={editing} onChange={setDraft} />
      <div className="flex items-center gap-2">
        <Button type="button" onClick={() => void save()} disabled={!canSaveConnection(draft, editing)} loading={isSaving} icon={<CheckCircle2 />}>
          {editing ? 'Save connection' : 'Create connection'}
        </Button>
        {editing ? (
          <Button type="button" variant="ghost" className="ml-auto text-destructive hover:text-destructive" onClick={() => setConfirmingDelete(true)}>
            Delete
          </Button>
        ) : null}
      </div>
      {editing ? (
        <ConfirmDeleteDialog
          open={confirmingDelete}
          onOpenChange={setConfirmingDelete}
          title="Delete API connection?"
          description={`Deletes "${editing.name}" for every agent in this workspace.`}
          confirmLabel="Delete connection"
          busy={isDeleting}
          onConfirm={() => void remove()}
        />
      ) : null}
    </div>
  )
}

export function ApiConnectionsPanel({ open, onOpenChange, onChanged }: {
  open: boolean
  onOpenChange: (open: boolean) => void
  onChanged?: () => void
}) {
  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent className="w-full gap-0 sm:max-w-xl">
        <SheetHeader className="border-b border-border px-6 py-5 pr-12">
          <SheetTitle>API connections</SheetTitle>
          <SheetDescription>Connect an API once, and skills on every agent in this workspace can call it.</SheetDescription>
        </SheetHeader>
        <div className="min-h-0 flex-1 overflow-y-auto p-6">
          {open ? <ApiConnectionsSection onChanged={onChanged} /> : null}
        </div>
      </SheetContent>
    </Sheet>
  )
}
