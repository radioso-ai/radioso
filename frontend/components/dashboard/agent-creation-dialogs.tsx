'use client'

import { useEffect, useMemo, useState } from 'react'
import { useRouter } from 'next/navigation'
import { FileJson, Globe } from 'lucide-react'

import { AgentBundleImportDialog } from '@/components/dashboard/agent-bundle-import-dialog'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { loadAgentCreationActionDefinitions, resolveAgentCreationActions, type AgentCreationActionDefinition } from '@/lib/agent-creation-extensions'
import { WizardDialog as RawWizardDialog } from '@/lib/agent-creation-contributions'
import { useAgents } from '@/lib/agents-context'
import { editionController } from '@/lib/edition-controller'

// The name form mounts with the dialog and unmounts with it, so every opening starts with no name and no error.
function CreateByNameForm({ onCancel, onCreated }: { onCancel: () => void; onCreated: (agentId: string) => void }) {
  const { createAgent } = useAgents()
  const [name, setName] = useState('')
  const [creating, setCreating] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const submit = async (event: React.FormEvent) => {
    event.preventDefault()
    const trimmed = name.trim()
    if (!trimmed || creating) return
    setCreating(true)
    setError(null)
    try {
      const created = await createAgent(trimmed)
      onCreated(created.id)
    } catch {
      setError('Failed to create agent')
      setCreating(false)
    }
  }

  return (
    <form onSubmit={submit} className="space-y-3">
      <div className="space-y-2">
        <Label htmlFor="sidebar-new-agent-name">Name</Label>
        <Input id="sidebar-new-agent-name" value={name} onChange={(event) => setName(event.target.value)} placeholder="e.g. Acme Support" />
      </div>
      {error ? <p role="alert" className="text-sm text-destructive">{error}</p> : null}
      <DialogFooter>
        <Button type="button" variant="outline" onClick={onCancel}>Cancel</Button>
        <Button type="submit" disabled={!name.trim() || creating}>{creating ? 'Creating…' : 'Create manually'}</Button>
      </DialogFooter>
    </form>
  )
}

/**
 * The three ways to add an agent: pick a setup path and name it, import a bundle, or run the
 * edition's creation wizard. The agent menu owns when the first two open; this owns what they do.
 */
export function AgentCreationDialogs({
  accountId,
  workspacePublicRouteKey,
  createOpen,
  onCreateOpenChange,
  importOpen,
  onImportOpenChange,
  profileHrefForAgent,
}: {
  accountId: string
  workspacePublicRouteKey: string | undefined
  createOpen: boolean
  onCreateOpenChange: (open: boolean) => void
  importOpen: boolean
  onImportOpenChange: (open: boolean) => void
  /** Where a new agent opens: its Build → Profile page. */
  profileHrefForAgent: (agentId: string) => string
}) {
  const router = useRouter()
  const { refresh } = useAgents()
  const [wizardOpen, setWizardOpen] = useState(false)
  const [creationDefinitions, setCreationDefinitions] = useState<AgentCreationActionDefinition[]>([])
  const extensionsEnabled = editionController.canUseAgentCreationExtensions()
  const creationActions = useMemo(() => extensionsEnabled
    ? resolveAgentCreationActions(creationDefinitions, { accountId, workspacePublicRouteKey })
    : [], [accountId, creationDefinitions, extensionsEnabled, workspacePublicRouteKey])
  const WizardDialog = extensionsEnabled ? RawWizardDialog : null

  useEffect(() => {
    if (!extensionsEnabled) return
    let active = true
    void loadAgentCreationActionDefinitions().then((definitions) => { if (active) setCreationDefinitions(definitions) })
    return () => { active = false }
  }, [extensionsEnabled])

  return (
    <>
      <Dialog open={createOpen} onOpenChange={onCreateOpenChange}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Create agent</DialogTitle>
            <DialogDescription>Choose a setup path for a new agent.</DialogDescription>
          </DialogHeader>
          <div className="space-y-2">
            {creationActions.map((action) => (
              <Button
                key={action.id}
                type="button"
                variant="outline"
                className="w-full justify-start"
                onClick={() => {
                  onCreateOpenChange(false)
                  if (action.kind === 'wizard-dialog' && WizardDialog) setWizardOpen(true)
                  else if (action.href) router.push(action.href)
                }}
              >
                <Globe className="mr-2 h-4 w-4" />
                {action.label}
              </Button>
            ))}
            <Button
              type="button"
              variant="outline"
              data-testid="create-agent-import-option"
              className="w-full justify-start"
              onClick={() => { onCreateOpenChange(false); onImportOpenChange(true) }}
            >
              <FileJson className="mr-2 h-4 w-4" />
              Import a bundle
            </Button>
          </div>
          <CreateByNameForm
            onCancel={() => onCreateOpenChange(false)}
            onCreated={(agentId) => {
              onCreateOpenChange(false)
              router.push(profileHrefForAgent(agentId))
            }}
          />
        </DialogContent>
      </Dialog>
      <AgentBundleImportDialog
        open={importOpen}
        onOpenChange={onImportOpenChange}
        onImported={() => void refresh()}
        agentSettingsHrefBuilder={profileHrefForAgent}
      />
      {WizardDialog ? <WizardDialog open={wizardOpen} onOpenChange={setWizardOpen} agentSettingsHrefBuilder={profileHrefForAgent} /> : null}
    </>
  )
}
