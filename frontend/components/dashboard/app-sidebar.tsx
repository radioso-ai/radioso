'use client'

import Image from 'next/image'
import Link from 'next/link'

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
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { useAuth } from '@/lib/auth-context'
import { useTheme } from '@/components/theme-provider'
import {
  Activity,
  Bot,
  BookOpen,
  Settings,
  LogOut,
  Moon,
  Sun,
  Monitor,
  ChevronUp,
  Users,
  Gauge,
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
}

const navItems = [
  { id: 'agents' as const, label: 'Agents', icon: Bot },
  { id: 'knowledge' as const, label: 'Knowledge Base', icon: BookOpen },
  { id: 'activity' as const, label: 'Activity', icon: Activity },
  { id: 'quality' as const, label: 'Quality', icon: ShieldAlert },
  { id: 'eval' as const, label: 'Eval', icon: FlaskConical },
  { id: 'settings' as const, label: 'Settings', icon: Settings },
]

export function AppSidebar({ accountId, currentView, routeState }: AppSidebarProps) {
  const { user, logout } = useAuth()
  const { activeWorkspace, activeWorkspaceId, accounts } = useWorkspace()
  const { theme, setTheme } = useTheme()
  const organizationName = accounts.find((account) => account.accountId === accountId)?.organizationName ?? 'radioso'
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
      </SidebarContent>

      <SidebarFooter>
        <SidebarMenu>
          <SidebarMenuItem>
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <SidebarMenuButton className="group/user w-full">
                  <div className="relative flex-shrink-0">
                    <div className="w-7 h-7 rounded-full bg-gradient-to-br from-secondary/60 to-primary/40 flex items-center justify-center text-xs font-semibold text-sidebar-foreground">
                      {userInitial}
                    </div>
                    <span className="absolute -bottom-0.5 -right-0.5 w-2 h-2 rounded-full bg-emerald-500 ring-2 ring-sidebar" />
                  </div>
                  <div className="flex-1 min-w-0 text-left">
                    <p className="text-sm font-medium text-foreground truncate">{userDisplayName}</p>
                    <p className="text-xs text-muted-foreground truncate">{user?.email || 'user@example.com'}</p>
                  </div>
                  <ChevronUp className="w-4 h-4 text-muted-foreground transition-transform duration-200 group-data-[state=open]/user:rotate-180" />
                </SidebarMenuButton>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="start" className="w-56">
                <div className="px-2 py-1.5">
                  <p className="text-sm font-medium">{userDisplayName}</p>
                  <p className="text-xs text-muted-foreground">{user?.email}</p>
                </div>
                <DropdownMenuSeparator />
                <DropdownMenuItem onClick={() => setTheme('light')}>
                  <Sun className="w-4 h-4 mr-2" />
                  Light
                  {theme === 'light' && <span className="ml-auto text-xs">✓</span>}
                </DropdownMenuItem>
                <DropdownMenuItem onClick={() => setTheme('dark')}>
                  <Moon className="w-4 h-4 mr-2" />
                  Dark
                  {theme === 'dark' && <span className="ml-auto text-xs">✓</span>}
                </DropdownMenuItem>
                <DropdownMenuItem onClick={() => setTheme('system')}>
                  <Monitor className="w-4 h-4 mr-2" />
                  System
                  {theme === 'system' && <span className="ml-auto text-xs">✓</span>}
                </DropdownMenuItem>
                <DropdownMenuSeparator />
                <DropdownMenuItem asChild>
                  <Link
                    href={buildDashboardHref(accountId, {
                      section: 'settings',
                      settingsTab: 'users',
                      workspaceId: activeWorkspaceId ?? undefined,
                      workspacePublicRouteKey: activeWorkspace?.publicRouteKey,
                    })}
                  >
                    <Users className="w-4 h-4 mr-2" />
                    Users
                  </Link>
                </DropdownMenuItem>
                <DropdownMenuItem asChild>
                  <Link
                    href={buildDashboardHref(accountId, {
                      section: 'usage',
                      workspaceId: activeWorkspaceId ?? undefined,
                      workspacePublicRouteKey: activeWorkspace?.publicRouteKey,
                    })}
                  >
                    <Gauge className="w-4 h-4 mr-2" />
                    Usage
                  </Link>
                </DropdownMenuItem>
                <DropdownMenuSeparator />
                <DropdownMenuItem onClick={logout} className="text-destructive focus:text-destructive">
                  <LogOut className="w-4 h-4 mr-2" />
                  Sign out
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          </SidebarMenuItem>
        </SidebarMenu>
      </SidebarFooter>
    </Sidebar>
  )
}
