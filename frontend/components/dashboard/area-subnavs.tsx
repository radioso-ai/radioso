'use client'

import {
  ArrowDownToLine,
  Boxes,
  Building2,
  ClipboardCheck,
  FileText,
  FlaskConical,
  FolderOpen,
  Inbox,
  MessagesSquare,
} from 'lucide-react'

import { SectionNavBody, type SubNavGroup } from '@/components/dashboard/subnav-column'
import {
  buildActivityTabHref,
  buildQualityTabHref,
  type QualitySurfaceTab,
} from '@/components/dashboard/activity-tabs'
import { useWorkspace } from '@/lib/workspace-context'
import {
  buildDashboardHref,
  type ActivityTab,
  type DashboardRouteState,
  type KnowledgeTab,
  type SettingsTab,
} from '@/lib/dashboard-routes'

function useWorkspaceRouteParts() {
  const { activeWorkspace, activeWorkspaceId } = useWorkspace()
  return {
    workspaceId: activeWorkspaceId ?? undefined,
    workspacePublicRouteKey: activeWorkspace?.publicRouteKey,
  }
}

export function ActivitySubNav({ accountId, routeState }: { accountId: string; routeState: DashboardRouteState }) {
  const activeTab: ActivityTab = routeState.activityTab === 'all' ? 'all' : 'needs-attention'
  const href = (target: ActivityTab) => buildActivityTabHref(accountId, routeState, activeTab, target)

  const groups: SubNavGroup[] = [
    {
      items: [
        { id: 'needs-attention', label: 'Inbox', icon: Inbox, href: href('needs-attention'), active: activeTab === 'needs-attention' },
        { id: 'all', label: 'Conversations', icon: MessagesSquare, href: href('all'), active: activeTab === 'all' },
      ],
    },
  ]

  return <SectionNavBody groups={groups} />
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
        { id: 'providers', label: 'Providers', icon: Boxes, href: href('providers'), active: active === 'providers' },
      ],
    },
  ]

  return <SectionNavBody groups={groups} />
}
