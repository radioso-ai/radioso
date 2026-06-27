'use client'

import {
  ArrowDownToLine,
  Boxes,
  Building2,
  FileText,
  FolderOpen,
  Gauge,
  LogOut,
  Monitor,
  Moon,
  Sun,
  Users,
} from 'lucide-react'

import { SectionNavBody, SubNavRow, type SubNavGroup } from '@/components/dashboard/subnav-column'
import { useTheme } from '@/components/theme-provider'
import { useAuth } from '@/lib/auth-context'
import { useWorkspace } from '@/lib/workspace-context'
import {
  buildDashboardHref,
  type AccountTab,
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

export function AccountSubNav({ accountId, routeState }: { accountId: string; routeState: DashboardRouteState }) {
  const parts = useWorkspaceRouteParts()
  const { theme, setTheme } = useTheme()
  const { logout } = useAuth()
  const active = routeState.accountTab ?? 'members'
  const href = (accountTab: AccountTab) => buildDashboardHref(accountId, { section: 'account', accountTab, ...parts })

  const groups: SubNavGroup[] = [
    {
      items: [
        { id: 'members', label: 'Members', icon: Users, href: href('members'), active: active === 'members' },
        { id: 'usage', label: 'Usage', icon: Gauge, href: href('usage'), active: active === 'usage' },
      ],
    },
    {
      label: 'Appearance',
      items: [
        { id: 'theme-light', label: 'Light', icon: Sun, active: theme === 'light', onClick: () => setTheme('light') },
        { id: 'theme-dark', label: 'Dark', icon: Moon, active: theme === 'dark', onClick: () => setTheme('dark') },
        { id: 'theme-system', label: 'System', icon: Monitor, active: theme === 'system', onClick: () => setTheme('system') },
      ],
    },
  ]

  return (
    <SectionNavBody
      groups={groups}
      footer={
        <SubNavRow entry={{ id: 'sign-out', label: 'Sign out', icon: LogOut, danger: true, onClick: () => void logout() }} />
      }
    />
  )
}
