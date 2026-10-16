'use client'

import { useState } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import { Trash2 } from 'lucide-react'

import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog'
import { Button } from '@/components/ui/button'
import { Spinner } from '@/components/ui/spinner'
import { chatApi } from '@/lib/api'
import { getApiErrorMessage } from '@/lib/api-error'
import { useAuth } from '@/lib/auth-context'
import { matchesWorkspaceInvalidation } from '@/lib/dashboard-query-invalidation'
import { useWorkspace } from '@/lib/workspace-context'

/**
 * Permanently erases one conversation after the operator confirms. Shown to owners and admins,
 * who hold `workspace.history.delete`; the server decides either way. Lists refresh here and, for
 * every other open dashboard, from the server's `conversation.deleted` event.
 */
export function DeleteConversationAction({
  conversationId,
  onDeleted,
}: {
  conversationId: string
  onDeleted: () => void
}) {
  const queryClient = useQueryClient()
  const { user } = useAuth()
  const { accounts, activeWorkspaceId } = useWorkspace()
  const [open, setOpen] = useState(false)
  const [deleting, setDeleting] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const role = accounts.find((account) => account.accountId === user?.accountId)?.role
  if (role !== 'owner' && role !== 'admin') {
    return null
  }

  const handleConfirm = async () => {
    setDeleting(true)
    setError(null)
    try {
      await chatApi.deleteHistoryConversation(conversationId)
      if (activeWorkspaceId) {
        void queryClient.invalidateQueries({
          predicate: (query) => matchesWorkspaceInvalidation('conversation.deleted', query.queryKey, activeWorkspaceId),
        })
      }
      setOpen(false)
      onDeleted()
    } catch (deleteError) {
      setError(getApiErrorMessage(deleteError, 'The conversation could not be deleted.'))
    } finally {
      setDeleting(false)
    }
  }

  return (
    <AlertDialog
      open={open}
      onOpenChange={(next) => {
        if (deleting) return
        setOpen(next)
        if (!next) setError(null)
      }}
    >
      <Button type="button" size="sm" variant="outline" className="gap-1.5" onClick={() => setOpen(true)}>
        <Trash2 className="h-3.5 w-3.5" />
        Delete conversation
      </Button>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>Delete this conversation permanently?</AlertDialogTitle>
          <AlertDialogDescription>
            Its messages and everything derived from them are erased for good. Notices and emails already sent stay with
            the people who got them.
          </AlertDialogDescription>
        </AlertDialogHeader>
        {error ? (
          <p className="text-sm text-destructive" role="alert">
            {error}
          </p>
        ) : null}
        <AlertDialogFooter>
          <AlertDialogCancel disabled={deleting}>Cancel</AlertDialogCancel>
          <AlertDialogAction
            onClick={(event) => {
              event.preventDefault()
              void handleConfirm()
            }}
            disabled={deleting}
            className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
          >
            {deleting ? (
              <>
                <Spinner className="mr-2 h-4 w-4" />
                Deleting...
              </>
            ) : (
              'Delete permanently'
            )}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  )
}
