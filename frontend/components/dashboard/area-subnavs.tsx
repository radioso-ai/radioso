'use client'

import {
  ArrowDownToLine,
  Boxes,
  Building2,
  ClipboardCheck,
  FileJson,
  FileText,
  FlaskConical,
  FolderOpen,
  KeyRound,
  MessageSquare,
  Radio,
  SquarePen,
} from 'lucide-react'
import { useEffect, useMemo, useState } from 'react'

import { AgentCreationDialogs } from '@/components/dashboard/agent-creation-dialogs'
import { AgentSwitcher } from '@/components/dashboard/agent-switcher'
import { SectionNavBody, SubNavRow, type SubNavEntry, type SubNavGroup, type SubNavStatus } from '@/components/dashboard/subnav-column'
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
import { agentRowForSection, agentSectionFromRoute, agentSectionRoute, type AgentSectionId } from '@/lib/dashboard-areas'
import { agentsApi, type AgentSettings } from '@/lib/api'
import { summarizeAgentChannels, type AgentChannelCatalogEntry } from '@/lib/agent-channel-catalog'
import { requestAgentDelete } from '@/lib/agent-delete-request'
import { getLastSelectedAgentId } from '@/lib/agent-selection'
import { useAgentChannelCatalog } from '@/lib/use-agent-channel-catalog'
import { hasPublishableChanges, useAgentRevisionState } from '@/lib/use-agent-revision-state'
import { useWorkspace } from '@/lib/workspace-context'

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

const agentHref = (accountId: string, routeState: DashboardRouteState, agentId: string, section: AgentSectionId, workspaceId?: string, workspacePublicRouteKey?: string) => {
  const route = agentSectionRoute(section)
  return buildAgentSectionHref(accountId, routeState, agentId, route, { workspaceId, workspacePublicRouteKey })
}

/** What the Channels row says: "Needs setup" when any channel cannot serve, else how many are on. */
const channelsRowStatus = (entries: ReadonlyArray<AgentChannelCatalogEntry> | null): SubNavStatus | undefined => {
  if (!entries) return undefined
  const { onCount, needsSetup } = summarizeAgentChannels(entries)
  return needsSetup ? { tone: 'warning', label: 'Needs setup' } : { tone: 'none', label: `${onCount} on` }
}

/** Agent area navigation mounted inside the single application sidebar. */
export function AgentAreaSubNav({ accountId, routeState }: { accountId: string; routeState: DashboardRouteState }) {
  const { activeWorkspace, activeWorkspaceId } = useWorkspace()
  const [agents, setAgents] = useState<AgentSettings[]>([])
  const [createOpen, setCreateOpen] = useState(false)
  const [importOpen, setImportOpen] = useState(false)

  const selectedAgent = useMemo(() => {
    const preferred = routeState.agentId ?? getLastSelectedAgentId(activeWorkspaceId)
    return agents.find((agent) => agent.id === preferred) ?? agents[0] ?? null
  }, [activeWorkspaceId, agents, routeState.agentId])
  const selectedAgentId = selectedAgent?.id
  const activeSection = agentSectionFromRoute(routeState)
  const activeRow = agentRowForSection(activeSection)
  const workspacePublicRouteKey = activeWorkspace?.publicRouteKey
  const hrefFor = (agentId: string, section: AgentSectionId) => agentHref(accountId, routeState, agentId, section, activeWorkspaceId ?? undefined, workspacePublicRouteKey)

  const draft = useAgentRevisionState(selectedAgentId)
  // The operator may change a channel on its page, so the summary is read again on the way into and
  // out of Channels, and between its pages, but not on every Build tab.
  const channels = useAgentChannelCatalog({
    workspaceId: activeWorkspaceId,
    agentId: selectedAgentId,
    refreshKey: activeRow === 'channels' ? activeSection : 'elsewhere',
  })

  useEffect(() => {
    if (!activeWorkspaceId) return
    let active = true
    const load = () => void agentsApi.listAgents().then((result) => { if (active) setAgents(result.agents) }).catch(() => { if (active) setAgents([]) })
    load()
    window.addEventListener('radioso:agents-updated', load)
    window.addEventListener('radioso:assistant-name-updated', load)
    return () => {
      active = false
      window.removeEventListener('radioso:agents-updated', load)
      window.removeEventListener('radioso:assistant-name-updated', load)
    }
  }, [activeWorkspaceId])

  const rows: SubNavEntry[] = [
    {
      id: 'build',
      label: 'Build',
      icon: SquarePen,
      href: selectedAgentId ? hrefFor(selectedAgentId, 'profile') : undefined,
      active: activeRow === 'build',
      status: draft.state && hasPublishableChanges(draft.state) ? { tone: 'warning', label: 'Unpublished changes', dotOnly: true } : undefined,
    },
    {
      id: 'test',
      label: 'Test',
      icon: MessageSquare,
      href: selectedAgentId ? hrefFor(selectedAgentId, 'chat') : undefined,
      active: activeRow === 'test',
    },
    {
      id: 'channels',
      label: 'Channels',
      icon: Radio,
      href: selectedAgentId ? hrefFor(selectedAgentId, 'channels-overview') : undefined,
      active: activeRow === 'channels',
      status: channelsRowStatus(channels.entries),
    },
  ]

  return (
    <div className="ml-2 space-y-1.5 border-l border-sidebar-border/70 pl-2">
      <AgentSwitcher
        agents={agents}
        selectedAgent={selectedAgent}
        hrefForAgent={(agentId) => hrefFor(agentId, activeSection)}
        onNewAgent={() => setCreateOpen(true)}
        onImportBundle={() => setImportOpen(true)}
        onDeleteAgent={requestAgentDelete}
      />
      <div className="space-y-0.5">
        {rows.map((entry) => <SubNavRow key={entry.id} entry={entry} />)}
      </div>
      {agents.length === 0 ? (
        <button type="button" data-testid="empty-state-import-bundle" onClick={() => setImportOpen(true)} className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-sm text-sidebar-foreground/75 hover:bg-sidebar-accent hover:text-sidebar-accent-foreground">
          <FileJson className="h-4 w-4" />
          Import a bundle
        </button>
      ) : null}
      <AgentCreationDialogs
        accountId={accountId}
        workspaceId={activeWorkspaceId}
        workspacePublicRouteKey={workspacePublicRouteKey}
        createOpen={createOpen}
        onCreateOpenChange={setCreateOpen}
        importOpen={importOpen}
        onImportOpenChange={setImportOpen}
        onImported={() => void agentsApi.listAgents().then((result) => setAgents(result.agents)).catch(() => undefined)}
        profileHrefForAgent={(agentId) => hrefFor(agentId, 'profile')}
      />
    </div>
  )
}
