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
  Bot,
  BookOpen,
  Inbox,
  MessageSquareWarning,
  Radar,
  Settings,
  type LucideIcon,
} from 'lucide-react'
import {
  buildDashboardHref,
  type DashboardRouteState,
  type DashboardSection,
} from '@/lib/dashboard-routes'
import { useNeedsAttentionOpenCount } from '@/lib/needs-attention-query-state'
import { cn } from '@/lib/utils'
import { WorkspaceSwitcher } from './workspace-switcher'
import { AccountMenu } from './account-menu'
import { useWorkspace } from '@/lib/workspace-context'

interface AppSidebarProps {
  accountId: string
  currentView: DashboardSection
  routeState: DashboardRouteState
  /** The active section's nested sub-navigation, rendered under its rail row. */
  areaSubNav?: ReactNode
}

interface NavItem {
  id: string
  label: string
  icon: LucideIcon
  section: DashboardSection
  /** Extra route state the link should carry beyond its section (e.g. a fixed sub-view). */
  extraRouteState?: Partial<DashboardRouteState>
  isActive: (routeState: DashboardRouteState) => boolean
}

// Inbox sits first and is visually separated from the build/config sections below —
// it's the operator's home: handoffs, approvals, and the full conversation log live
// behind its two lenses (see inbox-lens-toggle.tsx), not a sidebar sub-nav. Audience
// Pulse and Quality route to the `quality` section (distinguished by `qualityView`),
// and Quality's Evals sub-item routes to the separate `eval` section — see
// area-subnavs.tsx.
const navItems: NavItem[] = [
  {
    id: 'inbox',
    label: 'Inbox',
    icon: Inbox,
    section: 'activity',
    isActive: (routeState) => routeState.section === 'activity',
  },
  {
    id: 'agents',
    label: 'Agents',
    icon: Bot,
    section: 'agents',
    isActive: (routeState) => routeState.section === 'agents',
  },
  {
    id: 'knowledge',
    label: 'Knowledge Base',
    icon: BookOpen,
    section: 'knowledge',
    isActive: (routeState) => routeState.section === 'knowledge',
  },
  {
    id: 'audience-pulse',
    label: 'Audience Pulse',
    icon: Radar,
    section: 'quality',
    extraRouteState: { qualityView: 'audience-pulse' },
    isActive: (routeState) => routeState.section === 'quality' && routeState.qualityView === 'audience-pulse',
  },
  {
    id: 'quality',
    label: 'Quality',
    icon: MessageSquareWarning,
    section: 'quality',
    isActive: (routeState) =>
      routeState.section === 'eval'
      || (routeState.section === 'quality' && routeState.qualityView !== 'audience-pulse'),
  },
  {
    id: 'settings',
    label: 'Settings',
    icon: Settings,
    section: 'settings',
    isActive: (routeState) => routeState.section === 'settings',
  },
]

export function AppSidebar({ accountId, currentView, routeState, areaSubNav }: AppSidebarProps) {
  const { user } = useAuth()
  const { activeWorkspace, activeWorkspaceId } = useWorkspace()
  // Same unified open-count the tab title (useInboxAttentionSignal) and the
  // Needs-you lens toggle's "Needs you · N" badge use — decisions +
  // human-owned conversations + commented negative feedback, from the same
  // client inbox model, so the badge can never disagree with either of them
  // (a feedback-only workspace previously showed no badge at all here).
  const inboxCount = useNeedsAttentionOpenCount(activeWorkspaceId ?? '')
  const userDisplayName = user?.email?.split('@')[0] || 'User'
  const userInitial = userDisplayName.charAt(0).toUpperCase() || 'U'
  const isAccountActive = currentView === 'account'

  return (
    <Sidebar collapsible="offcanvas">
      <SidebarHeader className="h-16 border-b border-sidebar-border p-0">
        <WorkspaceSwitcher accountId={accountId} currentView={currentView} routeState={routeState} />
      </SidebarHeader>

      <SidebarContent>
        <SidebarGroup>
          <SidebarGroupContent>
            <SidebarMenu>
              {navItems.map((item) => {
                const isActive = item.isActive(routeState)
                const showBadge = item.id === 'inbox' && inboxCount > 0
                // In the Agents section the row IS the agent picker (rendered inline by
                // areaSubNav), so there's a single agent entry instead of a picker above an
                // "Agents" row. Until areaSubNav is ready (e.g. workspace still loading) we
                // keep the plain row so the entry never collapses to an empty gap.
                const isAgentsPicker = item.id === 'agents' && isActive && Boolean(areaSubNav)
                const navState: DashboardRouteState = {
                  section: item.section,
                  ...item.extraRouteState,
                  workspaceId: activeWorkspaceId ?? undefined,
                  workspacePublicRouteKey: activeWorkspace?.publicRouteKey,
                }

                return (
                  <SidebarMenuItem
                    key={item.id}
                    className={item.id === 'inbox' ? 'mb-1' : undefined}
                  >
                    {isAgentsPicker ? null : (
                        <SidebarMenuButton asChild isActive={isActive} tooltip={item.label}>
                          <Link
                            href={buildDashboardHref(accountId, navState)}
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
        <SidebarMenu>
          <SidebarMenuItem>
            <AccountMenu accountId={accountId} routeState={routeState}>
              <SidebarMenuButton
                size="lg"
                isActive={isAccountActive}
                tooltip={user?.email || userDisplayName}
                className={cn('group/user', isAccountActive && 'bg-sidebar-accent')}
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
              </SidebarMenuButton>
            </AccountMenu>
          </SidebarMenuItem>
        </SidebarMenu>
      </SidebarFooter>
    </Sidebar>
  )
}
