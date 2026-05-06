'use client'

import Image from 'next/image'
import Link from 'next/link'
import { useEffect, useState } from 'react'

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
  SidebarSeparator,
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
  User,
  Users,
  Gauge,
} from 'lucide-react'
import {
  buildDashboardHref,
  type DashboardSection,
} from '@/lib/dashboard-routes'
import { WorkspaceSwitcher } from './workspace-switcher'
import { useWorkspace } from '@/lib/workspace-context'
import { generalSettingsApi } from '@/lib/api'
import { ENTERPRISE_USAGE_LIMITS_ENABLED } from '@/lib/enterprise-features'

interface AppSidebarProps {
  accountId: string
  currentView: DashboardSection
}

const navItems = [
  { id: 'knowledge' as const, label: 'Knowledge Base', icon: BookOpen },
  { id: 'activity' as const, label: 'Activity', icon: Activity },
  { id: 'settings' as const, label: 'Settings', icon: Settings },
]

const assistantNameByWorkspace = new Map<string, string | null>()

export function AppSidebar({ accountId, currentView }: AppSidebarProps) {
  const { user, logout } = useAuth()
  const { activeWorkspace, activeWorkspaceId } = useWorkspace()
  const { theme, setTheme } = useTheme()
  const workspaceCacheKey = activeWorkspaceId ? `${accountId}:${activeWorkspaceId}` : null
  const [assistantNameState, setAssistantNameState] = useState<{
    workspaceCacheKey: string | null
    assistantName: string | null
  }>(() => ({
    workspaceCacheKey,
    assistantName: workspaceCacheKey && assistantNameByWorkspace.has(workspaceCacheKey)
      ? (assistantNameByWorkspace.get(workspaceCacheKey) ?? null)
      : null,
  }))
  const cachedAssistantName = workspaceCacheKey && assistantNameByWorkspace.has(workspaceCacheKey)
    ? assistantNameByWorkspace.get(workspaceCacheKey) ?? null
    : null
  const assistantName = assistantNameState.workspaceCacheKey === workspaceCacheKey
    ? assistantNameState.assistantName
    : cachedAssistantName
  const agentName = assistantName?.trim() || activeWorkspace?.name || 'Agent'
  const agentLabel = `Agent: ${agentName}`

  useEffect(() => {
    if (!workspaceCacheKey) {
      return
    }

    let active = true
    const loadAssistantName = async () => {
      try {
        const settings = await generalSettingsApi.getGeneralSettings()
        if (!active) return
        assistantNameByWorkspace.set(workspaceCacheKey, settings.assistantName)
        setAssistantNameState({ workspaceCacheKey, assistantName: settings.assistantName })
      } catch {
        if (!active) return
        if (!assistantNameByWorkspace.has(workspaceCacheKey)) {
          setAssistantNameState({ workspaceCacheKey, assistantName: null })
        }
      }
    }

    void loadAssistantName()
    const handleAssistantNameUpdated = (event: Event) => {
      const customEvent = event as CustomEvent<{ assistantName?: string }>
      const assistantName = customEvent.detail?.assistantName ?? null
      assistantNameByWorkspace.set(workspaceCacheKey, assistantName)
      setAssistantNameState({ workspaceCacheKey, assistantName })
    }

    window.addEventListener('radioso:assistant-name-updated', handleAssistantNameUpdated)
    return () => {
      active = false
      window.removeEventListener('radioso:assistant-name-updated', handleAssistantNameUpdated)
    }
  }, [workspaceCacheKey])

  return (
    <Sidebar collapsible="icon">
      <SidebarHeader className="p-4">
        <div className="flex items-center gap-2">
          <Image
            src="/radioso-logo.png"
            alt="radioso logo"
            width={32}
            height={32}
            className="h-8 w-8 rounded-lg object-cover flex-shrink-0"
          />
          <span className="font-semibold text-foreground group-data-[collapsible=icon]:hidden">
            radioso
          </span>
        </div>
      </SidebarHeader>

      <div className="px-2">
        <WorkspaceSwitcher accountId={accountId} currentView={currentView} />
      </div>

      <SidebarContent>
        <SidebarGroup>
          <SidebarGroupContent>
            <SidebarMenu>
              <SidebarMenuItem>
                <SidebarMenuButton asChild isActive={currentView === 'agents'} tooltip={agentLabel}>
                  <Link
                    href={buildDashboardHref(accountId, {
                      section: 'agents',
                      workspaceId: activeWorkspaceId ?? undefined,
                      workspacePublicRouteKey: activeWorkspace?.publicRouteKey,
                    })}
                  >
                    <Bot className="w-4 h-4" />
                    <span>{agentLabel}</span>
                  </Link>
                </SidebarMenuButton>
              </SidebarMenuItem>
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
        <SidebarSeparator />
        <SidebarMenu>
          <SidebarMenuItem>
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <SidebarMenuButton className="w-full">
                  <div className="w-6 h-6 rounded-full bg-muted flex items-center justify-center flex-shrink-0">
                    <User className="w-3.5 h-3.5 text-muted-foreground" />
                  </div>
                  <div className="flex-1 min-w-0 text-left group-data-[collapsible=icon]:hidden">
                    <p className="text-sm font-medium text-foreground truncate">
                      {user?.email?.split('@')[0] || 'User'}
                    </p>
                    <p className="text-xs text-muted-foreground truncate">
                      {user?.email || 'user@example.com'}
                    </p>
                  </div>
                  <ChevronUp className="w-4 h-4 text-muted-foreground group-data-[collapsible=icon]:hidden" />
                </SidebarMenuButton>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="start" className="w-56">
                <div className="px-2 py-1.5">
                  <p className="text-sm font-medium">{user?.email?.split('@')[0]}</p>
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
                {ENTERPRISE_USAGE_LIMITS_ENABLED ? (
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
                ) : null}
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
