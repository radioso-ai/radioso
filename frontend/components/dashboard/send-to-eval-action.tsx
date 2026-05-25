'use client'

import { useCallback, useEffect, useState } from 'react'
import { useRouter } from 'next/navigation'
import { FlaskConical } from 'lucide-react'

import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { evalsApi } from '@/lib/api'
import type { EvalAssertion } from '@/lib/api-eval'
import { getApiErrorMessage } from '@/lib/api-error'
import { buildDashboardHref, type DashboardRouteState } from '@/lib/dashboard-routes'
import { useAuth } from '@/lib/auth-context'
import { useWorkspace } from '@/lib/workspace-context'

interface SendToEvalActionProps {
  conversationId: string
  assistantMessageId: string
  // First few characters of the user's last question, used as the default
  // case name suggestion. Optional — falls back to a date-based default.
  userQueryPreview?: string
  // The assistant's answer for this turn. When present, the new case is
  // pre-seeded with one LLM-judge expectation using this text as the
  // reference answer. Operator can run immediately without configuring.
  originalAnswer?: string
  className?: string
}

export function SendToEvalAction({
  conversationId,
  assistantMessageId,
  userQueryPreview,
  originalAnswer,
  className,
}: SendToEvalActionProps) {
  const [open, setOpen] = useState(false)

  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        className={
          className ??
          'inline-flex h-7 w-7 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-accent hover:text-foreground'
        }
        aria-label="Send to eval"
        title="Send to eval"
      >
        <FlaskConical className="size-3.5" />
      </button>
      {open ? (
        <SendToEvalDialog
          conversationId={conversationId}
          assistantMessageId={assistantMessageId}
          userQueryPreview={userQueryPreview}
          originalAnswer={originalAnswer}
          onClose={() => setOpen(false)}
        />
      ) : null}
    </>
  )
}

interface SendToEvalDialogProps {
  conversationId: string
  assistantMessageId: string
  userQueryPreview?: string
  originalAnswer?: string
  onClose: () => void
}

const defaultCaseName = (queryPreview: string | undefined): string => {
  const date = new Intl.DateTimeFormat(undefined, {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
  }).format(new Date())
  const trimmed = queryPreview?.trim()
  if (trimmed) {
    const snippet = trimmed.length > 60 ? `${trimmed.slice(0, 57)}…` : trimmed
    return `${date} · "${snippet}"`
  }
  return `Eval from ${date}`
}

function SendToEvalDialog({
  conversationId,
  assistantMessageId,
  userQueryPreview,
  originalAnswer,
  onClose,
}: SendToEvalDialogProps) {
  const router = useRouter()
  const { user } = useAuth()
  const { activeWorkspaceId, workspaces } = useWorkspace()
  const workspacePublicRouteKey = activeWorkspaceId
    ? workspaces.find((w) => w.id === activeWorkspaceId)?.publicRouteKey
    : undefined

  const [name, setName] = useState(() => defaultCaseName(userQueryPreview))
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState<string | null>(null)

  // Re-seed the name suggestion if the dialog is reopened on a different turn.
  useEffect(() => {
    setName(defaultCaseName(userQueryPreview))
  }, [userQueryPreview])

  const submit = useCallback(async () => {
    setError(null)
    setSubmitting(true)
    try {
      const snapshot = await evalsApi.captureSnapshot({
        conversationId,
        messageId: assistantMessageId,
      })
      // Pre-seed the case with one LLM-judge expectation using the original
      // answer as the reference. Most "send this to eval" turns translate to
      // "the assistant should keep answering this way" — operator can run
      // immediately, or edit/replace the expectation in the editor.
      const seededAssertions: EvalAssertion[] = originalAnswer && originalAnswer.trim()
        ? [{ type: 'llm_judge', expectedAnswer: originalAnswer.trim() }]
        : []
      const created = await evalsApi.createCase({
        snapshotId: snapshot.id,
        name: name.trim() || defaultCaseName(userQueryPreview),
        assertions: seededAssertions,
      })

      if (user) {
        const target: DashboardRouteState = {
          section: 'eval',
          evalCaseId: created.id,
          workspaceId: activeWorkspaceId ?? undefined,
          workspacePublicRouteKey,
        }
        router.push(buildDashboardHref(user.accountId, target))
      }
      onClose()
    } catch (err) {
      setError(getApiErrorMessage(err, 'Failed to create eval case'))
    } finally {
      setSubmitting(false)
    }
  }, [
    activeWorkspaceId,
    assistantMessageId,
    conversationId,
    name,
    onClose,
    originalAnswer,
    router,
    user,
    userQueryPreview,
    workspacePublicRouteKey,
  ])

  return (
    <Dialog open onOpenChange={(o) => { if (!o) onClose() }}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Save this turn as an eval</DialogTitle>
          <DialogDescription>
            {originalAnswer && originalAnswer.trim()
              ? "We'll save this conversation along with the current answer as the expected answer. You can run the eval on the next screen to check the assistant still answers the same way."
              : 'Captures this conversation. You can configure what to check and run the eval on the next screen.'}
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-2">
          <Label htmlFor="send-eval-name">Case name</Label>
          <Input
            id="send-eval-name"
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="Name for this eval case"
            disabled={submitting}
            autoFocus
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !submitting && name.trim()) {
                e.preventDefault()
                void submit()
              }
            }}
          />
          {error ? <p className="text-sm text-rose-600">{error}</p> : null}
        </div>
        <DialogFooter>
          <Button variant="ghost" onClick={onClose} disabled={submitting}>
            Cancel
          </Button>
          <Button onClick={submit} disabled={submitting || !name.trim()}>
            {submitting ? 'Creating…' : 'Create and open editor'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
