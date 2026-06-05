'use client'

import Image from 'next/image'
import Link from 'next/link'
import type { ReactNode } from 'react'

import {
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarGroup,
  SidebarGroupContent,
  SidebarHeader,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
} from '@/components/ui/sidebar'
import { useAuth } from '@/lib/auth-context'
import {
  Activity,
  Bot,
  BookOpen,
  Settings,
  FlaskConical,
  ShieldAlert,
} from 'lucide-react'
import {
  buildDashboardHref,
  type DashboardSection,
  type DashboardRouteState,
} from '@/lib/dashboard-routes'
import { WorkspaceSwitcher } from './workspace-switcher'
import { useWorkspace } from '@/lib/workspace-context'

interface AppSidebarProps {
  accountId: string
  currentView: DashboardSection
  routeState: DashboardRouteState
  /** The active area's second column, shown inside the mobile drawer only. */
  areaSubNav?: ReactNode
}

const navItems = [
  { id: 'agents' as const, label: 'Agents', icon: Bot },
  { id: 'knowledge' as const, label: 'Knowledge Base', icon: BookOpen },
  { id: 'activity' as const, label: 'Activity', icon: Activity },
  { id: 'quality' as const, label: 'Quality', icon: ShieldAlert },
  { id: 'eval' as const, label: 'Eval', icon: FlaskConical },
  { id: 'settings' as const, label: 'Settings', icon: Settings },
]

export function AppSidebar({ accountId, currentView, routeState, areaSubNav }: AppSidebarProps) {
  const { user } = useAuth()
  const { activeWorkspace, activeWorkspaceId, accounts } = useWorkspace()
  const organizationName =
    user?.accountId === accountId && user.organizationName
      ? user.organizationName
      : accounts.find((account) => account.accountId === accountId)?.organizationName ?? 'radioso'
  const userDisplayName = user?.email?.split('@')[0] || 'User'
  const userInitial = userDisplayName.charAt(0).toUpperCase() || 'U'

  return (
    <Sidebar collapsible="icon">
      <SidebarHeader className="h-14 flex-row items-center gap-2 border-b border-sidebar-border px-4 py-0 group-data-[collapsible=icon]:justify-center group-data-[collapsible=icon]:px-0">
        <Image
          src="/radioso-icon.svg"
          alt="radioso logo"
          width={28}
          height={28}
          priority
          loading="eager"
          className="h-7 w-7 flex-shrink-0"
        />
        <span className="truncate font-display text-lg font-semibold text-foreground group-data-[collapsible=icon]:hidden">
          {organizationName}
        </span>
      </SidebarHeader>

      <SidebarContent>
        <SidebarGroup>
          <SidebarGroupContent>
            <WorkspaceSwitcher accountId={accountId} currentView={currentView} routeState={routeState} />
            <SidebarMenu>
              {navItems.map((item) => (
                <SidebarMenuItem key={item.id}>
                  <SidebarMenuButton asChild isActive={currentView === item.id} tooltip={item.label}>
                    <Link
                      href={buildDashboardHref(accountId, {
                        section: item.id,
                        workspaceId: activeWorkspaceId ?? undefined,
                        workspacePublicRouteKey: activeWorkspace?.publicRouteKey,
                      })}
                    >
                      <item.icon className="w-4 h-4" />
                      <span>{item.label}</span>
                    </Link>
                  </SidebarMenuButton>
                </SidebarMenuItem>
              ))}
            </SidebarMenu>
          </SidebarGroupContent>
        </SidebarGroup>

        {areaSubNav ? (
          <SidebarGroup className="md:hidden">
            <SidebarGroupContent className="[&>aside]:w-full [&>aside]:border-r-0">{areaSubNav}</SidebarGroupContent>
          </SidebarGroup>
        ) : null}
      </SidebarContent>

      <SidebarFooter>
        <SidebarMenu>
          <SidebarMenuItem>
            <SidebarMenuButton
              asChild
              isActive={currentView === 'account'}
              tooltip={user?.email || userDisplayName}
              className="group/user"
            >
              <Link
                href={buildDashboardHref(accountId, {
                  section: 'account',
                  accountTab: 'members',
                  workspaceId: activeWorkspaceId ?? undefined,
                  workspacePublicRouteKey: activeWorkspace?.publicRouteKey,
                })}
              >
                <div className="relative flex-shrink-0">
                  <div className="flex h-6 w-6 items-center justify-center rounded-full bg-gradient-to-br from-secondary/60 to-primary/40 text-xs font-semibold text-sidebar-foreground">
                    {userInitial}
                  </div>
                  <span className="absolute -bottom-0.5 -right-0.5 h-2 w-2 rounded-full bg-emerald-500 ring-2 ring-sidebar" />
                </div>
                <div className="min-w-0 flex-1 text-left">
                  <p className="truncate text-sm font-medium text-foreground">{userDisplayName}</p>
                  <p className="truncate text-xs text-muted-foreground">{user?.email || 'user@example.com'}</p>
                </div>
              </Link>
            </SidebarMenuButton>
          </SidebarMenuItem>
        </SidebarMenu>
      </SidebarFooter>
    </Sidebar>
  )
}
