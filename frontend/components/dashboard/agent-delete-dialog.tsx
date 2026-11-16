'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'
import { Trash2 } from 'lucide-react'

import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { agentsApi } from '@/lib/api'
import { getApiErrorMessage } from '@/lib/api-error'

type DeleteBlock = 'last-agent' | 'not-allowed' | null

// The form mounts with the dialog and unmounts with it, so every opening starts with an empty confirmation.
function DeleteForm({
  accountId,
  agentId,
  agentName,
  block,
  onDone,
}: {
  accountId: string
  agentId: string
  agentName: string
  block: DeleteBlock
  onDone: () => void
}) {
  const router = useRouter()
  const [confirmName, setConfirmName] = useState('')
  const [deleting, setDeleting] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const confirmed = confirmName.trim() === agentName.trim()

  const handleDelete = async () => {
    if (!confirmed || block) return
    setDeleting(true)
    setError(null)
    try {
      await agentsApi.deleteAgent(agentId)
      onDone()
      window.dispatchEvent(new CustomEvent('radioso:agents-updated'))
      router.push(`/account/${accountId}/agents`)
    } catch (caught) {
      setError(getApiErrorMessage(caught, 'Failed to delete the agent.'))
      setDeleting(false)
    }
  }

  return (
    <>
      <DialogHeader>
        <DialogTitle>Delete agent</DialogTitle>
        <DialogDescription>
          This will permanently delete the agent <strong>{agentName}</strong> and
          its channel tokens, conversations, and settings. MCP connections stay in the workspace. This action cannot be undone.
        </DialogDescription>
      </DialogHeader>
      {block === 'last-agent' ? (
        <p className="text-sm text-muted-foreground">You cannot delete your only agent in this workspace. Create another agent first.</p>
      ) : block === 'not-allowed' ? (
        <p className="text-sm text-muted-foreground">Only owners and admins can delete agents.</p>
      ) : null}
      <div className="space-y-2 py-2">
        <Label htmlFor="deleteAgentConfirm" className="text-foreground">
          Type <strong>{agentName}</strong> to confirm
        </Label>
        <Input
          id="deleteAgentConfirm"
          value={confirmName}
          onChange={(event) => setConfirmName(event.target.value)}
          placeholder={agentName}
          disabled={block !== null}
        />
      </div>
      {error ? <p className="text-sm text-destructive">{error}</p> : null}
      <DialogFooter>
        <Button variant="outline" onClick={onDone}>Cancel</Button>
        <Button variant="destructive" onClick={handleDelete} disabled={!confirmed || block !== null} loading={deleting} icon={<Trash2 />}>
          Delete agent
        </Button>
      </DialogFooter>
    </>
  )
}

/**
 * The confirmation for deleting an agent: the operator types its name, and an agent that is the
 * workspace's last one, or an operator who is not an owner or admin, can read why it cannot go ahead.
 */
export function AgentDeleteDialog({
  accountId,
  agentId,
  agentName,
  agentCount,
  canDelete,
  open,
  onOpenChange,
}: {
  accountId: string
  agentId: string
  agentName: string
  agentCount: number
  canDelete: boolean
  open: boolean
  onOpenChange: (open: boolean) => void
}) {
  const block: DeleteBlock = agentCount <= 1 ? 'last-agent' : canDelete ? null : 'not-allowed'
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DeleteForm accountId={accountId} agentId={agentId} agentName={agentName} block={block} onDone={() => onOpenChange(false)} />
      </DialogContent>
    </Dialog>
  )
}
