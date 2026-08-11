'use client'

import React, { type FormEvent, useCallback, useEffect, useMemo, useState } from 'react'
import { useRouter } from 'next/navigation'
import { Globe2, RefreshCw } from 'lucide-react'

import { AgentSwitcher, DashboardSubNav, type ChannelStatus } from '@/components/dashboard/dashboard-subnav'
import { agentSectionFromRoute, agentSectionRoute, type AgentSectionId } from '@/lib/dashboard-areas'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { WizardDialog as RawWizardDialog } from '@/lib/agent-creation-contributions'
import {
  loadAgentCreationActionDefinitions,
  resolveAgentCreationActions,
  type AgentCreationActionDefinition,
} from '@/lib/agent-creation-extensions'
import { editionController } from '@/lib/edition-controller'
import { agentsApi, type AgentSettings } from '@/lib/api'
import { getLastSelectedAgentId, setLastSelectedAgentId } from '@/lib/agent-selection'
import { getAgentOperatorLabel } from '@/lib/agent-label'
import { useCopilotEntity } from '@/lib/copilot-context'
import { buildDashboardHref, type DashboardRouteState } from '@/lib/dashboard-routes'
import { useWorkspace } from '@/lib/workspace-context'

type WizardDialogComponent = (props: {
  open: boolean
  onOpenChange: (open: boolean) => void
  agentSettingsHrefBuilder: (agentId: string) => string
}) => React.ReactElement | null

const agentCreationExtensionsEnabled = editionController.canUseAgentCreationExtensions()
const WizardDialog = agentCreationExtensionsEnabled
  ? (RawWizardDialog as unknown as WizardDialogComponent | null)
  : null

const agentsByWorkspace = new Map<string, AgentSettings[]>()

const resolvePreferredAgent = (agents: AgentSettings[], preferredAgentId?: string | null) => {
  if (preferredAgentId) {
    return agents.find((agent) => agent.id === preferredAgentId) ?? agents[0] ?? null
  }
  return agents[0] ?? null
}

/**
 * Data + interaction owner for the agents second column. Loads the agent list,
 * resolves the active agent and channel on/off status, and renders the
 * presentational DashboardSubNav with the agent switcher in its header band.
 */
export function AgentSubNavContainer({
  accountId,
  routeState,
}: {
  accountId: string
  routeState: DashboardRouteState
}) {
  const router = useRouter()
  const { activeWorkspace, activeWorkspaceId } = useWorkspace()
  const workspacePublicRouteKey = activeWorkspace?.publicRouteKey
  const workspaceCacheKey = activeWorkspaceId ? `${accountId}:${activeWorkspaceId}` : null
  const preferredAgentId = routeState.agentId ?? getLastSelectedAgentId(activeWorkspaceId)

  const [agents, setAgents] = useState<AgentSettings[]>(() =>
    workspaceCacheKey ? agentsByWorkspace.get(workspaceCacheKey) ?? [] : [],
  )
  const [channelStatus, setChannelStatus] = useState<ChannelStatus>({})
  const [switcherOpen, setSwitcherOpen] = useState(false)
  const [createDialogOpen, setCreateDialogOpen] = useState(false)
  const [wizardOpen, setWizardOpen] = useState(false)
  const [newAgentName, setNewAgentName] = useState('')
  const [isCreatingAgent, setIsCreatingAgent] = useState(false)
  const [createAgentError, setCreateAgentError] = useState<string | null>(null)
  const [agentCreationActionDefinitions, setAgentCreationActionDefinitions] = useState<AgentCreationActionDefinition[]>([])

  const selectedAgent = resolvePreferredAgent(agents, preferredAgentId)
  const selectedAgentId = selectedAgent?.id ?? null
  // Prefer the operator-only internal label so two same-named agents (e.g. an EN
  // and an IT "Claudio") are distinguishable in the dashboard. Visitors never see it.
  const agentName = getAgentOperatorLabel(selectedAgent)
  const activeSection = agentSectionFromRoute(routeState)
  useCopilotEntity('agent', selectedAgentId, agentName, true)

  const agentCreationActions = useMemo(
    () =>
      agentCreationExtensionsEnabled
        ? resolveAgentCreationActions(agentCreationActionDefinitions, {
            accountId,
            workspacePublicRouteKey,
          })
        : [],
    [accountId, agentCreationActionDefinitions, workspacePublicRouteKey],
  )

  const loadAgents = useCallback(async () => {
    if (!workspaceCacheKey) {
      setAgents([])
      return
    }
    try {
      const response = await agentsApi.listAgents()
      agentsByWorkspace.set(workspaceCacheKey, response.agents)
      setAgents(response.agents)
    } catch {
      setAgents(workspaceCacheKey ? agentsByWorkspace.get(workspaceCacheKey) ?? [] : [])
    }
  }, [workspaceCacheKey])

  useEffect(() => {
    const timeout = window.setTimeout(() => void loadAgents(), 0)
    const handleAgentsUpdated = () => void loadAgents()
    window.addEventListener('radioso:agents-updated', handleAgentsUpdated)
    window.addEventListener('radioso:assistant-name-updated', handleAgentsUpdated)
    return () => {
      window.clearTimeout(timeout)
      window.removeEventListener('radioso:agents-updated', handleAgentsUpdated)
      window.removeEventListener('radioso:assistant-name-updated', handleAgentsUpdated)
    }
  }, [loadAgents])

  useEffect(() => {
    if (selectedAgentId) {
      setLastSelectedAgentId(activeWorkspaceId, selectedAgentId)
    }
  }, [activeWorkspaceId, selectedAgentId])

  useEffect(() => {
    if (!agentCreationExtensionsEnabled) return
    let active = true
    void loadAgentCreationActionDefinitions().then((definitions) => {
      if (active) setAgentCreationActionDefinitions(definitions)
    })
    return () => {
      active = false
    }
  }, [])

  // Channel on/off status for the active agent drives the sub-nav status dots.
  useEffect(() => {
    if (!selectedAgentId) {
      // eslint-disable-next-line react-hooks/set-state-in-effect -- Clear channel status when no agent is selected.
      setChannelStatus({})
      return
    }
    let active = true
    void (async () => {
      try {
        const settings = await agentsApi.getGeneralSettings(selectedAgentId)
        if (!active) return
        setChannelStatus({
          'public-chat-link': Boolean(settings.anonymousChatEnabled),
          'website-embed': Boolean(settings.websiteEmbedEnabled),
        })
      } catch {
        if (active) setChannelStatus({})
      }
    })()
    return () => {
      active = false
    }
  }, [selectedAgentId])

  const hrefForSection = useCallback(
    (section: AgentSectionId) => {
      const route = agentSectionRoute(section)
      return buildDashboardHref(accountId, {
        section: 'agents',
        workspaceId: activeWorkspaceId ?? undefined,
        workspacePublicRouteKey,
        agentId: selectedAgentId ?? undefined,
        agentTab: route.agentTab,
        anchor: route.anchor,
      })
    },
    [accountId, activeWorkspaceId, selectedAgentId, workspacePublicRouteKey],
  )

  const hrefForAgent = useCallback(
    (agentId: string) => {
      const route = agentSectionRoute(activeSection)
      return buildDashboardHref(accountId, {
        section: 'agents',
        workspaceId: activeWorkspaceId ?? undefined,
        workspacePublicRouteKey,
        agentId,
        agentTab: route.agentTab,
        anchor: route.anchor,
      })
    },
    [accountId, activeSection, activeWorkspaceId, workspacePublicRouteKey],
  )

  const handleCreateAgent = async (event: FormEvent) => {
    event.preventDefault()
    if (!activeWorkspaceId || !workspaceCacheKey || isCreatingAgent) return
    const name = newAgentName.trim()
    if (!name) return

    setIsCreatingAgent(true)
    setCreateAgentError(null)
    try {
      const created = await agentsApi.createAgent({ name })
      await loadAgents()
      setLastSelectedAgentId(activeWorkspaceId, created.id)
      setCreateDialogOpen(false)
      setNewAgentName('')
      window.dispatchEvent(new CustomEvent('radioso:agents-updated', { detail: { agentId: created.id } }))
      router.push(
        buildDashboardHref(accountId, {
          section: 'agents',
          workspaceId: activeWorkspaceId,
          workspacePublicRouteKey,
          agentId: created.id,
          agentTab: 'behavior',
          anchor: 'assistant-identity',
        }),
      )
    } catch {
      setCreateAgentError('Failed to create agent')
    } finally {
      setIsCreatingAgent(false)
    }
  }

  // The switcher is the Agents section's row itself; its nav items render nested below it.
  return (
    <>
      <div className="relative">
        <AgentSwitcher
          agentName={agentName}
          agents={agents.map((agent) => ({ id: agent.id, name: agent.name, internalName: agent.internalName }))}
          open={switcherOpen}
          onOpenChange={setSwitcherOpen}
          hrefForAgent={hrefForAgent}
          onSelectAgent={(agentId) => {
            setLastSelectedAgentId(activeWorkspaceId, agentId)
            setSwitcherOpen(false)
          }}
          onCreateAgent={() => {
            setSwitcherOpen(false)
            setCreateAgentError(null)
            setCreateDialogOpen(true)
          }}
        />
      </div>
      <DashboardSubNav
        activeSection={activeSection}
        hrefFor={hrefForSection}
        channelStatus={channelStatus}
      />

      <Dialog open={createDialogOpen} onOpenChange={setCreateDialogOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Create agent</DialogTitle>
            <DialogDescription>Pick how you&apos;d like to set up your new agent.</DialogDescription>
          </DialogHeader>

          {agentCreationActions[0] ? (
            <>
              <button
                type="button"
                onClick={() => {
                  const action = agentCreationActions[0]
                  setCreateDialogOpen(false)
                  if (action.kind === 'wizard-dialog' && WizardDialog) {
                    setWizardOpen(true)
                  } else if (action.href) {
                    router.push(action.href)
                  }
                }}
                className="group flex w-full items-start gap-4 rounded-lg border border-border bg-muted/20 p-4 text-left transition-colors hover:border-primary/40 hover:bg-muted/40"
              >
                <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-md bg-primary/10 text-primary">
                  <Globe2 className="h-5 w-5" />
                </div>
                <div className="flex-1 space-y-1">
                  <div className="flex items-center gap-2">
                    <span className="text-sm font-medium">{agentCreationActions[0].label}</span>
                    <span className="rounded-full bg-primary/10 px-2 py-0.5 text-[10px] font-medium uppercase tracking-wide text-primary">
                      Recommended
                    </span>
                  </div>
                  <p className="text-xs text-muted-foreground">
                    We&apos;ll read your site and configure name, tone, and instructions for you.
                  </p>
                </div>
              </button>
              <div className="flex items-center gap-3 text-xs uppercase tracking-wider text-muted-foreground">
                <div className="h-px flex-1 bg-border" />
                <span>or create manually</span>
                <div className="h-px flex-1 bg-border" />
              </div>
            </>
          ) : null}

          <form onSubmit={handleCreateAgent} className="space-y-4">
            <div className="space-y-2">
              <Label htmlFor="subnavNewAgentName">Name</Label>
              <Input
                id="subnavNewAgentName"
                value={newAgentName}
                onChange={(event) => setNewAgentName(event.target.value)}
                maxLength={200}
                placeholder="e.g. Acme Support"
              />
              <p className="text-xs text-muted-foreground">
                You can configure instructions, tone, and channels after creating the agent.
              </p>
            </div>
            {createAgentError ? <p className="text-sm text-destructive">{createAgentError}</p> : null}
            <DialogFooter>
              <Button type="button" variant="outline" onClick={() => setCreateDialogOpen(false)} disabled={isCreatingAgent}>
                Cancel
              </Button>
              <Button type="submit" disabled={!newAgentName.trim() || isCreatingAgent}>
                {isCreatingAgent ? <RefreshCw className="h-4 w-4 animate-spin" /> : null}
                Create
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>

      {WizardDialog ? (
        <WizardDialog
          open={wizardOpen}
          onOpenChange={setWizardOpen}
          agentSettingsHrefBuilder={(agentId) =>
            buildDashboardHref(accountId, {
              section: 'agents',
              agentId,
              agentTab: 'behavior',
              anchor: 'assistant-identity',
              workspaceId: activeWorkspaceId ?? undefined,
              workspacePublicRouteKey,
            })
          }
        />
      ) : null}
    </>
  )
}
