'use client'

import Link from 'next/link'
import {
  ArrowDownToLine,
  Boxes,
  Building2,
  ClipboardCheck,
  FileText,
  FlaskConical,
  FolderOpen,
  KeyRound,
  ChevronDown,
  FileJson,
  Globe,
  MessageCircle,
  MessageSquare,
  Plus,
  Wrench,
  type LucideIcon,
} from 'lucide-react'

import { SectionNavBody, SubNavRow, type SubNavGroup } from '@/components/dashboard/subnav-column'
import {
  buildQualityTabHref,
  type QualitySurfaceTab,
} from '@/components/dashboard/activity-tabs'
import {
  buildAgentSectionHref,
  buildDashboardHref,
  type DashboardRouteState,
  type KnowledgeTab,
  type SettingsTab,
} from '@/lib/dashboard-routes'
import { agentSectionFromRoute, agentSectionRoute, type AgentSectionId } from '@/lib/dashboard-areas'
import { agentsApi, type AgentSettings } from '@/lib/api'
import { agentToGeneralSettings } from '@/lib/api-types'
import { getAgentOperatorLabel } from '@/lib/agent-label'
import { getLastSelectedAgentId, setLastSelectedAgentId } from '@/lib/agent-selection'
import { agentChannelCredentialsApi } from '@/lib/api-agent-channel-credentials'
import { slackApi } from '@/lib/api-slack'
import { connectorsApi } from '@/lib/api-connectors'
import { resolveAgentChannelCatalog, type AgentChannelCatalogId } from '@/lib/agent-channel-catalog'
import { useEffect, useMemo, useState } from 'react'
import { useRouter } from 'next/navigation'
import { useWorkspace } from '@/lib/workspace-context'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { AgentBundleImportDialog } from '@/components/dashboard/agent-bundle-import-dialog'
import { WizardDialog as RawWizardDialog } from '@/lib/agent-creation-contributions'
import { editionController } from '@/lib/edition-controller'
import { loadAgentCreationActionDefinitions, resolveAgentCreationActions, type AgentCreationActionDefinition } from '@/lib/agent-creation-extensions'

function useWorkspaceRouteParts() {
  const { activeWorkspace, activeWorkspaceId } = useWorkspace()
  return {
    workspaceId: activeWorkspaceId ?? undefined,
    workspacePublicRouteKey: activeWorkspace?.publicRouteKey,
  }
}

/**
 * Quality's two surfaces: the triage Review queue (`quality` section) and Evals
 * (the separate `eval` section), nested here so one rail row covers both.
 */
export function QualitySubNav({ accountId, routeState }: { accountId: string; routeState: DashboardRouteState }) {
  const activeTab: QualitySurfaceTab = routeState.section === 'eval' ? 'evals' : 'review'
  const href = (target: QualitySurfaceTab) => buildQualityTabHref(accountId, routeState, activeTab, target)

  const groups: SubNavGroup[] = [
    {
      items: [
        { id: 'review', label: 'Review', icon: ClipboardCheck, href: href('review'), active: activeTab === 'review' },
        { id: 'evals', label: 'Evals', icon: FlaskConical, href: href('evals'), active: activeTab === 'evals' },
      ],
    },
  ]

  return <SectionNavBody groups={groups} />
}

export function KnowledgeSubNav({ accountId, routeState }: { accountId: string; routeState: DashboardRouteState }) {
  const parts = useWorkspaceRouteParts()
  const active = routeState.knowledgeTab ?? 'documents'
  const href = (knowledgeTab: KnowledgeTab) =>
    buildDashboardHref(accountId, { section: 'knowledge', knowledgeTab, ...parts })

  const groups: SubNavGroup[] = [
    {
      items: [
        { id: 'documents', label: 'Documents', icon: FileText, href: href('documents'), active: active === 'documents' },
        { id: 'sources', label: 'Sources', icon: FolderOpen, href: href('sources'), active: active === 'sources' },
        { id: 'ingestion', label: 'Ingestion', icon: ArrowDownToLine, href: href('ingestion'), active: active === 'ingestion' },
      ],
    },
  ]

  return <SectionNavBody groups={groups} />
}

export function SettingsSubNav({ accountId, routeState }: { accountId: string; routeState: DashboardRouteState }) {
  const parts = useWorkspaceRouteParts()
  const active = routeState.settingsTab ?? 'workspace'
  const href = (settingsTab: SettingsTab) =>
    buildDashboardHref(accountId, { section: 'settings', settingsTab, ...parts })

  const groups: SubNavGroup[] = [
    {
      items: [
        { id: 'workspace', label: 'Workspace', icon: Building2, href: href('workspace'), active: active === 'workspace' },
        { id: 'api-access', label: 'API access', icon: KeyRound, href: href('api-access'), active: active === 'api-access' },
        { id: 'providers', label: 'Providers', icon: Boxes, href: href('providers'), active: active === 'providers' },
      ],
    },
  ]

  return <SectionNavBody groups={groups} />
}

const channelMetadata: Record<AgentChannelCatalogId, { label: string; icon: LucideIcon }> = {
  'web-chat': { label: 'Web chat', icon: Globe },
  'api-channel': { label: 'Agent API', icon: KeyRound },
  'mcp-channel': { label: 'MCP', icon: Wrench },
  'slack-channel': { label: 'Slack', icon: MessageCircle },
  'whatsapp-channel': { label: 'WhatsApp', icon: MessageCircle },
}

const initials = (name: string) => name.trim().split(/\s+/).map((part) => part[0]).join('').slice(0, 2).toUpperCase() || 'A'

const agentHref = (accountId: string, routeState: DashboardRouteState, agentId: string, section: AgentSectionId, workspaceId?: string, workspacePublicRouteKey?: string) => {
  const route = agentSectionRoute(section)
  return buildAgentSectionHref(accountId, routeState, agentId, route, { workspaceId, workspacePublicRouteKey })
}

/** Agent area navigation mounted inside the single application sidebar. */
export function AgentAreaSubNav({ accountId, routeState }: { accountId: string; routeState: DashboardRouteState }) {
  const router = useRouter()
  const { activeWorkspace, activeWorkspaceId } = useWorkspace()
  const [agents, setAgents] = useState<AgentSettings[]>([])
  const [agentOpen, setAgentOpen] = useState(true)
  const [channelsOpen, setChannelsOpen] = useState(() => routeState.agentTab === 'channels')
  const [createOpen, setCreateOpen] = useState(false)
  const [wizardOpen, setWizardOpen] = useState(false)
  const [importOpen, setImportOpen] = useState(false)
  const [newAgentName, setNewAgentName] = useState('')
  const [creating, setCreating] = useState(false)
  const [createError, setCreateError] = useState<string | null>(null)
  const [channelCatalog, setChannelCatalog] = useState<ReturnType<typeof resolveAgentChannelCatalog>>([])
  const [creationDefinitions, setCreationDefinitions] = useState<AgentCreationActionDefinition[]>([])

  const selectedAgent = useMemo(() => {
    const preferred = routeState.agentId ?? getLastSelectedAgentId(activeWorkspaceId)
    return agents.find((agent) => agent.id === preferred) ?? agents[0] ?? null
  }, [activeWorkspaceId, agents, routeState.agentId])
  const selectedAgentId = selectedAgent?.id
  const activeSection = agentSectionFromRoute(routeState)
  const workspaceParts = {
    workspaceId: activeWorkspaceId ?? undefined,
    workspacePublicRouteKey: activeWorkspace?.publicRouteKey,
  }
  const creationActions = useMemo(() => editionController.canUseAgentCreationExtensions()
    ? resolveAgentCreationActions(creationDefinitions, { accountId, workspacePublicRouteKey: activeWorkspace?.publicRouteKey })
    : [], [accountId, activeWorkspace?.publicRouteKey, creationDefinitions])
  const WizardDialog = editionController.canUseAgentCreationExtensions() ? RawWizardDialog : null

  useEffect(() => {
    if (!activeWorkspaceId) return
    let active = true
    void agentsApi.listAgents().then((result) => {
      if (active) setAgents(result.agents)
    }).catch(() => {
      if (active) setAgents([])
    })
    const refresh = () => void agentsApi.listAgents().then((result) => { if (active) setAgents(result.agents) }).catch(() => undefined)
    window.addEventListener('radioso:agents-updated', refresh)
    window.addEventListener('radioso:assistant-name-updated', refresh)
    return () => {
      active = false
      window.removeEventListener('radioso:agents-updated', refresh)
      window.removeEventListener('radioso:assistant-name-updated', refresh)
    }
  }, [activeWorkspaceId])

  const channelsExpanded = channelsOpen
  useEffect(() => {
    if (!selectedAgentId || !channelsExpanded || !activeWorkspaceId) return
    let active = true
    void Promise.allSettled([
      agentsApi.getGeneralSettings(selectedAgentId),
      agentChannelCredentialsApi.list(selectedAgentId, 'rest'),
      agentChannelCredentialsApi.list(selectedAgentId, 'mcp'),
      slackApi.getInstallStatus(activeWorkspaceId, selectedAgentId),
      slackApi.listBindings(activeWorkspaceId, selectedAgentId),
      connectorsApi.get('whatsapp'),
    ]).then(([general, rest, mcp, slack, bindings, whatsappConnector]) => {
      if (!active) return
      const generalSettings = general.status === 'fulfilled' ? general.value : null
      const restCredentials = rest.status === 'fulfilled' ? rest.value.credentials.filter((credential) => credential.status === 'active') : []
      const mcpCredentials = mcp.status === 'fulfilled' ? mcp.value.credentials.filter((credential) => credential.status === 'active') : []
      const slackStatus = slack.status === 'fulfilled' ? slack.value : null
      const slackBindings = bindings.status === 'fulfilled' ? bindings.value.bindings : []
      const slackBound = slackBindings.some((binding) => binding.answeringAgentId === selectedAgentId)
      const whatsapp = whatsappConnector.status === 'fulfilled' ? whatsappConnector.value : null
      setChannelCatalog(resolveAgentChannelCatalog({
        webChatEnabled: Boolean(generalSettings?.anonymousChatEnabled || generalSettings?.websiteEmbedEnabled),
        apiCredentialCount: restCredentials.length,
        mcpCredentialCount: mcpCredentials.length,
        slackConfigured: slackBound,
        slackConnected: slackStatus?.status === 'connected',
        slackBound,
        whatsappAvailable: whatsappConnector.status === 'fulfilled',
        whatsappConfigured: whatsapp?.enabled ?? false,
        whatsappError: Boolean(whatsapp?.errorStatus),
      }))
    })
    return () => { active = false }
  }, [activeWorkspaceId, channelsExpanded, selectedAgentId])

  useEffect(() => {
    if (!editionController.canUseAgentCreationExtensions()) return
    let active = true
    void loadAgentCreationActionDefinitions().then((definitions) => { if (active) setCreationDefinitions(definitions) })
    return () => { active = false }
  }, [])

  const createAgent = async (event: React.FormEvent) => {
    event.preventDefault()
    const name = newAgentName.trim()
    if (!name || !activeWorkspaceId || creating) return
    setCreating(true)
    setCreateError(null)
    try {
      const created = await agentsApi.createAgent({ name })
      setLastSelectedAgentId(activeWorkspaceId, created.id)
      setCreateOpen(false)
      setNewAgentName('')
      window.dispatchEvent(new CustomEvent('radioso:agents-updated', { detail: { agentId: created.id } }))
      router.push(agentHref(accountId, routeState, created.id, 'profile', workspaceParts.workspaceId, workspaceParts.workspacePublicRouteKey))
    } catch {
      setCreateError('Failed to create agent')
    } finally {
      setCreating(false)
    }
  }

  const selectedLabel = selectedAgent ? getAgentOperatorLabel(selectedAgent) : 'Select an agent'
  const logoUrl = selectedAgent ? agentToGeneralSettings(selectedAgent).assistantLogoUrl : null
  const selectedSection = activeSection
  const channelGroups: SubNavGroup[] = [{ items: [
    ...channelCatalog.map((entry) => ({
    ...channelMetadata[entry.id],
    id: entry.id,
    href: selectedAgentId ? agentHref(accountId, routeState, selectedAgentId, entry.id, workspaceParts.workspaceId, workspaceParts.workspacePublicRouteKey) : undefined,
    active: selectedSection === entry.id,
    status: entry.status !== 'attention',
    statusLabel: entry.statusLabel,
    statusTone: entry.status === 'attention' ? ('attention' as const) : ('active' as const),
    })),
    {
      id: 'channels-overview',
      label: 'Manage channels',
      icon: Globe,
      href: selectedAgentId ? agentHref(accountId, routeState, selectedAgentId, 'channels-overview', workspaceParts.workspaceId, workspaceParts.workspacePublicRouteKey) : undefined,
      active: selectedSection === 'channels-overview',
    },
  ] }]

  return (
    <div className="ml-2 space-y-1 border-l border-sidebar-border/70 pl-2">
      <div className="space-y-1">
        <button type="button" onClick={() => setAgentOpen((open) => !open)} aria-expanded={agentOpen} className="flex w-full items-center gap-2 rounded-md bg-sidebar-accent px-2 py-1.5 text-left text-sm font-medium text-sidebar-accent-foreground">
          <span aria-hidden="true" className="flex h-6 w-6 shrink-0 items-center justify-center overflow-hidden rounded-md bg-primary/15 text-[10px] font-semibold text-primary" style={logoUrl ? { backgroundImage: `url(${logoUrl})`, backgroundPosition: 'center', backgroundSize: 'cover' } : undefined}>
            {logoUrl ? null : initials(selectedLabel)}
          </span>
          <span className="min-w-0 flex-1 truncate">{selectedLabel}</span>
          <ChevronDown className={`h-3.5 w-3.5 shrink-0 text-muted-foreground transition-transform ${agentOpen ? '' : '-rotate-90'}`} />
        </button>
      </div>
      {agentOpen ? <>
        <SubNavRow entry={{ id: 'chat', label: 'Test Chat', icon: MessageSquare, href: selectedAgentId ? agentHref(accountId, routeState, selectedAgentId, 'chat', workspaceParts.workspaceId, workspaceParts.workspacePublicRouteKey) : undefined, active: selectedSection === 'chat' }} />
        <div>
          <button type="button" onClick={() => setChannelsOpen((open) => !open)} aria-expanded={channelsOpen} className="flex w-full items-center gap-1 rounded-md px-2 py-1 text-[11px] font-medium uppercase tracking-wide text-sidebar-foreground/45 hover:text-sidebar-foreground/70">
            <ChevronDown className={`h-3 w-3 transition-transform ${channelsOpen ? '' : '-rotate-90'}`} />
            <span className="flex-1 text-left">Channels</span>
          </button>
          {channelsOpen ? <SectionNavBody groups={channelGroups} /> : null}
        </div>
      </> : null}
      <div className="max-h-36 space-y-0.5 overflow-y-auto">
        {agents.filter((agent) => agent.id !== selectedAgentId).map((agent) => {
          const label = getAgentOperatorLabel(agent)
          const agentLogoUrl = agentToGeneralSettings(agent).assistantLogoUrl
          return <Link key={agent.id} href={agentHref(accountId, routeState, agent.id, activeSection, workspaceParts.workspaceId, workspaceParts.workspacePublicRouteKey)} className="flex items-center gap-2 rounded-md px-2 py-1.5 text-xs text-sidebar-foreground/70 hover:bg-sidebar-accent hover:text-sidebar-accent-foreground">
            <span aria-hidden="true" className="flex h-5 w-5 shrink-0 items-center justify-center overflow-hidden rounded bg-sidebar-accent text-[9px] font-semibold" style={agentLogoUrl ? { backgroundImage: `url(${agentLogoUrl})`, backgroundPosition: 'center', backgroundSize: 'cover' } : undefined}>{agentLogoUrl ? null : initials(label)}</span>
            <span className="min-w-0 flex-1 truncate">{label}</span>
          </Link>
        })}
      </div>
      {agents.length === 0 ? <button type="button" data-testid="empty-state-import-bundle" onClick={() => setImportOpen(true)} className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-sm text-sidebar-foreground/75 hover:bg-sidebar-accent hover:text-sidebar-accent-foreground"><FileJson className="h-4 w-4" />Import a bundle</button> : null}
      <button type="button" onClick={() => { setCreateError(null); setCreateOpen(true) }} className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-sm text-sidebar-foreground/75 hover:bg-sidebar-accent hover:text-sidebar-accent-foreground"><Plus className="h-4 w-4" />New agent</button>
      <Dialog open={createOpen} onOpenChange={setCreateOpen}><DialogContent><DialogHeader><DialogTitle>Create agent</DialogTitle><DialogDescription>Choose a setup path for a new agent.</DialogDescription></DialogHeader><div className="space-y-2">{creationActions.map((action) => <Button key={action.id} type="button" variant="outline" className="w-full justify-start" onClick={() => { setCreateOpen(false); if (action.kind === 'wizard-dialog' && WizardDialog) setWizardOpen(true); else if (action.href) router.push(action.href) }}><Globe className="mr-2 h-4 w-4" />{action.label}</Button>)}<Button type="button" variant="outline" data-testid="create-agent-import-option" className="w-full justify-start" onClick={() => { setCreateOpen(false); setImportOpen(true) }}><FileJson className="mr-2 h-4 w-4" />Import a bundle</Button></div><form onSubmit={createAgent} className="space-y-3"><div className="space-y-2"><Label htmlFor="sidebar-new-agent-name">Name</Label><Input id="sidebar-new-agent-name" value={newAgentName} onChange={(event) => setNewAgentName(event.target.value)} placeholder="e.g. Acme Support" /></div>{createError ? <p role="alert" className="text-sm text-destructive">{createError}</p> : null}<DialogFooter><Button type="button" variant="outline" onClick={() => setCreateOpen(false)}>Cancel</Button><Button type="submit" disabled={!newAgentName.trim() || creating}>{creating ? 'Creating…' : 'Create manually'}</Button></DialogFooter></form></DialogContent></Dialog>
      <AgentBundleImportDialog open={importOpen} onOpenChange={setImportOpen} onImported={() => void agentsApi.listAgents().then((result) => setAgents(result.agents))} agentSettingsHrefBuilder={(agentId) => agentHref(accountId, routeState, agentId, 'profile', workspaceParts.workspaceId, workspaceParts.workspacePublicRouteKey)} />
      {WizardDialog ? <WizardDialog open={wizardOpen} onOpenChange={setWizardOpen} agentSettingsHrefBuilder={(agentId) => agentHref(accountId, routeState, agentId, 'profile', workspaceParts.workspaceId, workspaceParts.workspacePublicRouteKey)} /> : null}
    </div>
  )
}
