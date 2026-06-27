'use client'

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
  SidebarMenuBadge,
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
} from 'lucide-react'
import {
  buildDashboardHref,
  type DashboardSection,
  type DashboardRouteState,
} from '@/lib/dashboard-routes'
import { useInboxCount } from '@/hooks/use-inbox-count'
import { cn } from '@/lib/utils'
import { WorkspaceSwitcher } from './workspace-switcher'
import { useWorkspace } from '@/lib/workspace-context'

interface AppSidebarProps {
  accountId: string
  currentView: DashboardSection
  routeState: DashboardRouteState
  /** The active section's nested sub-navigation, rendered under its rail row. */
  areaSubNav?: ReactNode
}

// Activity sits first and is visually separated from the build/config sections below —
// it's the operator's home: the "needs attention" inbox and other time-sensitive work.
const navItems = [
  { id: 'activity' as const, label: 'Activity', icon: Activity },
  { id: 'agents' as const, label: 'Agents', icon: Bot },
  { id: 'knowledge' as const, label: 'Knowledge Base', icon: BookOpen },
  { id: 'eval' as const, label: 'Eval', icon: FlaskConical },
  { id: 'settings' as const, label: 'Settings', icon: Settings },
]

export function AppSidebar({ accountId, currentView, routeState, areaSubNav }: AppSidebarProps) {
  const { user } = useAuth()
  const { activeWorkspace, activeWorkspaceId } = useWorkspace()
  const inboxCount = useInboxCount()
  const userDisplayName = user?.email?.split('@')[0] || 'User'
  const userInitial = userDisplayName.charAt(0).toUpperCase() || 'U'
  const isAccountActive = currentView === 'account'

  return (
    <Sidebar collapsible="offcanvas">
      <SidebarHeader className="border-b border-sidebar-border p-0">
        <WorkspaceSwitcher accountId={accountId} currentView={currentView} routeState={routeState} />
      </SidebarHeader>

      <SidebarContent>
        <SidebarGroup>
          <SidebarGroupContent>
            <SidebarMenu>
              {navItems.map((item) => {
                const isActive = item.id === 'activity'
                  ? currentView === 'activity' || currentView === 'quality'
                  : currentView === item.id
                const showBadge = item.id === 'activity' && inboxCount > 0
                // In the Agents section the row IS the agent picker (rendered inline by
                // areaSubNav), so there's a single agent entry instead of a picker above an
                // "Agents" row. Until areaSubNav is ready (e.g. workspace still loading) we
                // keep the plain row so the entry never collapses to an empty gap.
                const isAgentsPicker = item.id === 'agents' && isActive && Boolean(areaSubNav)

                return (
                  <SidebarMenuItem
                    key={item.id}
                    className={item.id === 'activity' ? 'mb-1 border-b border-sidebar-border pb-1' : undefined}
                  >
                    {isAgentsPicker ? null : (
                      <SidebarMenuButton asChild isActive={isActive} tooltip={item.label}>
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
                    )}
                    {showBadge ? (
                      <SidebarMenuBadge
                        className="bg-secondary text-secondary-foreground"
                        aria-label={`${inboxCount} items need attention`}
                      >
                        {inboxCount > 99 ? '99+' : inboxCount}
                      </SidebarMenuBadge>
                    ) : null}
                    {isActive && areaSubNav ? areaSubNav : null}
                  </SidebarMenuItem>
                )
              })}
            </SidebarMenu>
          </SidebarGroupContent>
        </SidebarGroup>
      </SidebarContent>

      <SidebarFooter>
        {isAccountActive && areaSubNav ? <div className="pb-1">{areaSubNav}</div> : null}
        <SidebarMenu>
          <SidebarMenuItem>
            <SidebarMenuButton
              asChild
              size="lg"
              isActive={isAccountActive}
              tooltip={user?.email || userDisplayName}
              className={cn('group/user', isAccountActive && 'bg-sidebar-accent')}
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
