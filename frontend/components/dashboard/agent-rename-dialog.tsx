'use client'

import { useState } from 'react'

import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { agentRenameField, agentRenameInitialValue, renameAgent } from '@/lib/agent-rename'
import type { AgentLabelSource } from '@/lib/agent-label'
import { getApiErrorMessage } from '@/lib/api-error'

// The form mounts with the dialog and unmounts with it, so every opening starts from the agent's current name.
function RenameForm({ agentId, agent, onDone }: { agentId: string; agent: AgentLabelSource; onDone: () => void }) {
  const [value, setValue] = useState(() => agentRenameInitialValue(agent))
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const visitorFacing = agentRenameField(agent) === 'name'

  const submit = async (event: React.FormEvent) => {
    event.preventDefault()
    if (!value.trim() || saving) return
    setSaving(true)
    setError(null)
    try {
      await renameAgent(agentId, agent, value)
      onDone()
    } catch (caught) {
      setError(getApiErrorMessage(caught, 'The agent could not be renamed.'))
      setSaving(false)
    }
  }

  return (
    <form onSubmit={submit} className="space-y-4">
      <DialogHeader>
        <DialogTitle>Rename agent</DialogTitle>
        <DialogDescription>
          {visitorFacing
            ? 'Visitors see this name as the chat title. It applies as soon as you save.'
            : 'Only you see this name, in the dashboard. Visitors see the assistant name set on Profile.'}
        </DialogDescription>
      </DialogHeader>
      <div className="space-y-2">
        <Label htmlFor="agent-rename-input">Name</Label>
        <Input id="agent-rename-input" value={value} maxLength={200} onChange={(event) => setValue(event.target.value)} autoFocus />
      </div>
      {error ? <p role="alert" className="text-sm text-destructive">{error}</p> : null}
      <DialogFooter>
        <Button type="button" variant="outline" onClick={onDone}>Cancel</Button>
        <Button type="submit" disabled={!value.trim()} loading={saving}>Save</Button>
      </DialogFooter>
    </form>
  )
}

/** Renames the agent as the agent menu shows it. The change applies live, like the Profile name fields. */
export function AgentRenameDialog({
  agentId,
  agent,
  open,
  onOpenChange,
}: {
  agentId: string
  agent: AgentLabelSource
  open: boolean
  onOpenChange: (open: boolean) => void
}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-sm">
        <RenameForm agentId={agentId} agent={agent} onDone={() => onOpenChange(false)} />
      </DialogContent>
    </Dialog>
  )
}
