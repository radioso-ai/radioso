'use client'

import { useState } from 'react'
import { Trash2 } from 'lucide-react'

import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { getApiErrorMessage } from '@/lib/api-error'
import { useAgents } from '@/lib/agents-context'

type DeleteBlock = 'last-agent' | 'not-allowed' | null

// The form mounts with the dialog and unmounts with it, so every opening starts with an empty confirmation.
function DeleteForm({
  agentId,
  agentName,
  block,
  onDone,
}: {
  agentId: string
  agentName: string
  block: DeleteBlock
  onDone: () => void
}) {
  const { deleteAgent } = useAgents()
  const [confirmName, setConfirmName] = useState('')
  const [deleting, setDeleting] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const confirmed = confirmName.trim() === agentName.trim()

  const handleDelete = async () => {
    if (!confirmed || block) return
    setDeleting(true)
    setError(null)
    try {
      // The agent list drops it and selects the next agent, and the agent view follows that selection:
      // one move away from the deleted agent's URL, which replaces it rather than adding to the history.
      await deleteAgent(agentId)
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
  agentId,
  agentName,
  agentCount,
  canDelete,
  open,
  onOpenChange,
}: {
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
        <DeleteForm agentId={agentId} agentName={agentName} block={block} onDone={() => onOpenChange(false)} />
      </DialogContent>
    </Dialog>
  )
}
