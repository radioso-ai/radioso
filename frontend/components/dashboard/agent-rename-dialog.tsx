'use client'

import { useState } from 'react'

import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import type { AgentSettings } from '@/lib/api'
import { getApiErrorMessage } from '@/lib/api-error'
import { useAgents } from '@/lib/agents-context'

// The form mounts with the dialog and unmounts with it, so every opening starts from the agent's current names.
function RenameForm({ agent, onDone }: { agent: AgentSettings; onDone: () => void }) {
  const { renameAgent } = useAgents()
  const [name, setName] = useState(agent.name ?? '')
  const [internalName, setInternalName] = useState(agent.internalName ?? '')
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const changed = name.trim() !== (agent.name ?? '').trim() || internalName.trim() !== (agent.internalName ?? '').trim()
  // An agent with neither name would have nothing to be called in the menu.
  const nameless = name.trim() === '' && internalName.trim() === ''

  const submit = async (event: React.FormEvent) => {
    event.preventDefault()
    if (!changed || nameless || saving) return
    setSaving(true)
    setError(null)
    try {
      await renameAgent(agent.id, { name: name.trim(), internalName: internalName.trim() })
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
        <DialogDescription>Both names apply as soon as you save, the same as on Profile.</DialogDescription>
      </DialogHeader>
      <div className="space-y-2">
        <Label htmlFor="agent-rename-name">Name visitors see</Label>
        <Input id="agent-rename-name" value={name} maxLength={200} onChange={(event) => setName(event.target.value)} autoFocus />
        <p className="text-xs text-muted-foreground">Shown as the chat title.</p>
      </div>
      <div className="space-y-2">
        <Label htmlFor="agent-rename-internal-name">Internal name (optional)</Label>
        <Input id="agent-rename-internal-name" value={internalName} maxLength={200} onChange={(event) => setInternalName(event.target.value)} placeholder="e.g. Nico (IT)" />
        <p className="text-xs text-muted-foreground">Only you see this. It labels the agent in your dashboard.</p>
      </div>
      {error ? <p role="alert" className="text-sm text-destructive">{error}</p> : null}
      <DialogFooter>
        <Button type="button" variant="outline" onClick={onDone}>Cancel</Button>
        <Button type="submit" disabled={!changed || nameless} loading={saving}>Save</Button>
      </DialogFooter>
    </form>
  )
}

/** Renames the agent: the name visitors see and the optional internal name the dashboard shows. */
export function AgentRenameDialog({
  agent,
  open,
  onOpenChange,
}: {
  agent: AgentSettings
  open: boolean
  onOpenChange: (open: boolean) => void
}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-sm">
        <RenameForm agent={agent} onDone={() => onOpenChange(false)} />
      </DialogContent>
    </Dialog>
  )
}
