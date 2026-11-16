'use client'

import { useEffect, useMemo, useState } from 'react'
import { useRouter } from 'next/navigation'
import { FileJson, Globe } from 'lucide-react'

import { AgentBundleImportDialog } from '@/components/dashboard/agent-bundle-import-dialog'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { agentsApi } from '@/lib/api'
import { loadAgentCreationActionDefinitions, resolveAgentCreationActions, type AgentCreationActionDefinition } from '@/lib/agent-creation-extensions'
import { WizardDialog as RawWizardDialog } from '@/lib/agent-creation-contributions'
import { setLastSelectedAgentId } from '@/lib/agent-selection'
import { editionController } from '@/lib/edition-controller'

/**
 * The three ways to add an agent: pick a setup path and name it, import a bundle, or run the
 * edition's creation wizard. The agent menu owns when the first two open; this owns what they do.
 */
export function AgentCreationDialogs({
  accountId,
  workspaceId,
  workspacePublicRouteKey,
  createOpen,
  onCreateOpenChange,
  importOpen,
  onImportOpenChange,
  onImported,
  profileHrefForAgent,
}: {
  accountId: string
  workspaceId: string | null
  workspacePublicRouteKey: string | undefined
  createOpen: boolean
  onCreateOpenChange: (open: boolean) => void
  importOpen: boolean
  onImportOpenChange: (open: boolean) => void
  onImported: () => void
  /** Where a new agent opens: its Build → Profile page. */
  profileHrefForAgent: (agentId: string) => string
}) {
  const router = useRouter()
  const [wizardOpen, setWizardOpen] = useState(false)
  const [newAgentName, setNewAgentName] = useState('')
  const [creating, setCreating] = useState(false)
  const [createError, setCreateError] = useState<string | null>(null)
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

  const createAgent = async (event: React.FormEvent) => {
    event.preventDefault()
    const name = newAgentName.trim()
    if (!name || !workspaceId || creating) return
    setCreating(true)
    setCreateError(null)
    try {
      const created = await agentsApi.createAgent({ name })
      setLastSelectedAgentId(workspaceId, created.id)
      onCreateOpenChange(false)
      setNewAgentName('')
      window.dispatchEvent(new CustomEvent('radioso:agents-updated', { detail: { agentId: created.id } }))
      router.push(profileHrefForAgent(created.id))
    } catch {
      setCreateError('Failed to create agent')
    } finally {
      setCreating(false)
    }
  }

  return (
    <>
      <Dialog open={createOpen} onOpenChange={(open) => { if (open) setCreateError(null); onCreateOpenChange(open) }}>
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
          <form onSubmit={createAgent} className="space-y-3">
            <div className="space-y-2">
              <Label htmlFor="sidebar-new-agent-name">Name</Label>
              <Input id="sidebar-new-agent-name" value={newAgentName} onChange={(event) => setNewAgentName(event.target.value)} placeholder="e.g. Acme Support" />
            </div>
            {createError ? <p role="alert" className="text-sm text-destructive">{createError}</p> : null}
            <DialogFooter>
              <Button type="button" variant="outline" onClick={() => onCreateOpenChange(false)}>Cancel</Button>
              <Button type="submit" disabled={!newAgentName.trim() || creating}>{creating ? 'Creating…' : 'Create manually'}</Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>
      <AgentBundleImportDialog
        open={importOpen}
        onOpenChange={onImportOpenChange}
        onImported={onImported}
        agentSettingsHrefBuilder={profileHrefForAgent}
      />
      {WizardDialog ? <WizardDialog open={wizardOpen} onOpenChange={setWizardOpen} agentSettingsHrefBuilder={profileHrefForAgent} /> : null}
    </>
  )
}
