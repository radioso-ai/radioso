'use client'

import {
  ArrowDownToLine,
  Boxes,
  Building2,
  FileText,
  FolderOpen,
  Inbox,
  MessagesSquare,
  MessageSquareWarning,
} from 'lucide-react'

import { SectionNavBody, type SubNavGroup } from '@/components/dashboard/subnav-column'
import { buildActivityTabHref, type ActivitySurfaceTab } from '@/components/dashboard/activity-tabs'
import { useWorkspace } from '@/lib/workspace-context'
import {
  buildDashboardHref,
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
  const activeTab: ActivitySurfaceTab =
    routeState.section === 'quality' ? 'quality' : routeState.activityTab === 'all' ? 'all' : 'needs-attention'
  const href = (target: ActivitySurfaceTab) => buildActivityTabHref(accountId, routeState, activeTab, target)

  const groups: SubNavGroup[] = [
    {
      items: [
        { id: 'needs-attention', label: 'Needs attention', icon: Inbox, href: href('needs-attention'), active: activeTab === 'needs-attention' },
        { id: 'all', label: 'All activity', icon: MessagesSquare, href: href('all'), active: activeTab === 'all' },
        { id: 'quality', label: 'Quality', icon: MessageSquareWarning, href: href('quality'), active: activeTab === 'quality' },
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
