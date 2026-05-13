'use client'

import Image from 'next/image'
import Link from 'next/link'
import { type FormEvent, useEffect, useState } from 'react'
import { useRouter } from 'next/navigation'

import {
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarGroup,
  SidebarGroupContent,
  SidebarGroupLabel,
  SidebarHeader,
  SidebarMenu,
  SidebarMenuAction,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarMenuSub,
  SidebarMenuSubButton,
  SidebarMenuSubItem,
} from '@/components/ui/sidebar'
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Textarea } from '@/components/ui/textarea'
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
  ChevronDown,
  ChevronUp,
  Plus,
  RefreshCw,
  Users,
  Gauge,
} from 'lucide-react'
import {
  buildDashboardHref,
  type DashboardSection,
  type DashboardRouteState,
} from '@/lib/dashboard-routes'
import { WorkspaceSwitcher } from './workspace-switcher'
import { useWorkspace } from '@/lib/workspace-context'
import { agentsApi, type AgentSettings } from '@/lib/api'
import { getLastSelectedAgentId, setLastSelectedAgentId } from '@/lib/agent-selection'

interface AppSidebarProps {
  accountId: string
  currentView: DashboardSection
  routeState: DashboardRouteState
}

const navItems = [
  { id: 'knowledge' as const, label: 'Knowledge Base', icon: BookOpen },
  { id: 'activity' as const, label: 'Activity', icon: Activity },
  { id: 'settings' as const, label: 'Settings', icon: Settings },
]

const agentsByWorkspace = new Map<string, AgentSettings[]>()

const resolvePreferredAgent = (agents: AgentSettings[], preferredAgentId?: string | null) => {
  if (preferredAgentId) {
    return agents.find((agent) => agent.id === preferredAgentId) ?? agents[0] ?? null
  }

  return agents[0] ?? null
}

export function AppSidebar({ accountId, currentView, routeState }: AppSidebarProps) {
  const router = useRouter()
  const { user, logout } = useAuth()
  const { activeWorkspace, activeWorkspaceId, accounts } = useWorkspace()
  const { theme, setTheme } = useTheme()
  const organizationName = accounts.find((account) => account.accountId === accountId)?.organizationName ?? 'radioso'
  const workspaceCacheKey = activeWorkspaceId ? `${accountId}:${activeWorkspaceId}` : null
  const routeAgentId = currentView === 'agents' ? routeState.agentId ?? null : null
  const preferredAgentId = routeAgentId ?? getLastSelectedAgentId(activeWorkspaceId)
  const cachedAgents = workspaceCacheKey ? agentsByWorkspace.get(workspaceCacheKey) ?? [] : []
  const [agentListState, setAgentListState] = useState<{
    workspaceCacheKey: string | null
    agents: AgentSettings[]
    isLoading: boolean
  }>(() => ({
    workspaceCacheKey,
    agents: cachedAgents,
    isLoading: Boolean(workspaceCacheKey && cachedAgents.length === 0),
  }))
  const [agentsMenuOpen, setAgentsMenuOpen] = useState(false)
  const [createDialogOpen, setCreateDialogOpen] = useState(false)
  const [newAgentName, setNewAgentName] = useState('')
  const [newAgentInstructions, setNewAgentInstructions] = useState('')
  const [isCreatingAgent, setIsCreatingAgent] = useState(false)
  const [createAgentError, setCreateAgentError] = useState<string | null>(null)
  const agents = agentListState.workspaceCacheKey === workspaceCacheKey
    ? agentListState.agents
    : cachedAgents
  const selectedAgent = resolvePreferredAgent(agents, preferredAgentId)
  const selectedAgentId = selectedAgent?.id ?? null
  const selectedAgentName = selectedAgent?.name ?? null
  const agentName = selectedAgentName?.trim() || 'Agent'
  const agentTooltip = `Agent: ${agentName}`
  const userDisplayName = user?.email?.split('@')[0] || 'User'
  const userInitial = userDisplayName.charAt(0).toUpperCase() || 'U'

  useEffect(() => {
    let active = true

    if (!workspaceCacheKey) {
      const timeout = window.setTimeout(() => {
        if (active) {
          setAgentListState({ workspaceCacheKey: null, agents: [], isLoading: false })
        }
      }, 0)

      return () => {
        active = false
        window.clearTimeout(timeout)
      }
    }

    const loadAgents = async () => {
      setAgentListState((current) => ({
        workspaceCacheKey,
        agents: current.workspaceCacheKey === workspaceCacheKey ? current.agents : agentsByWorkspace.get(workspaceCacheKey) ?? [],
        isLoading: true,
      }))
      try {
        const response = await agentsApi.listAgents()
        if (!active) return
        agentsByWorkspace.set(workspaceCacheKey, response.agents)
        const agent = resolvePreferredAgent(response.agents, preferredAgentId)
        const agentId = agent?.id ?? null
        if (agentId) {
          setLastSelectedAgentId(activeWorkspaceId, agentId)
        }
        setAgentListState({ workspaceCacheKey, agents: response.agents, isLoading: false })
      } catch {
        if (!active) return
        setAgentListState((current) => ({
          workspaceCacheKey,
          agents: current.workspaceCacheKey === workspaceCacheKey ? current.agents : agentsByWorkspace.get(workspaceCacheKey) ?? [],
          isLoading: false,
        }))
      }
    }

    const timeout = window.setTimeout(() => {
      void loadAgents()
    }, 0)
    const handleAssistantNameUpdated = (event: Event) => {
      void event
      void loadAgents()
    }

    window.addEventListener('radioso:assistant-name-updated', handleAssistantNameUpdated)
    return () => {
      active = false
      window.clearTimeout(timeout)
      window.removeEventListener('radioso:assistant-name-updated', handleAssistantNameUpdated)
    }
  }, [activeWorkspaceId, preferredAgentId, workspaceCacheKey])

  const agentHref = buildDashboardHref(accountId, {
    section: 'agents',
    workspaceId: activeWorkspaceId ?? undefined,
    workspacePublicRouteKey: activeWorkspace?.publicRouteKey,
    agentId: selectedAgentId ?? (currentView === 'agents' ? routeState.agentId ?? undefined : undefined),
    agentTab: currentView === 'agents' ? routeState.agentTab : undefined,
  })

  const buildAgentHref = (agentId: string) => buildDashboardHref(accountId, {
    section: 'agents',
    workspaceId: activeWorkspaceId ?? undefined,
    workspacePublicRouteKey: activeWorkspace?.publicRouteKey,
    agentId,
    agentTab: currentView === 'agents' ? routeState.agentTab : undefined,
  })

  const handleCreateAgent = async (event: FormEvent) => {
    event.preventDefault()
    if (!activeWorkspaceId || !workspaceCacheKey || isCreatingAgent) {
      return
    }

    const name = newAgentName.trim()
    if (!name) {
      return
    }

    setIsCreatingAgent(true)
    setCreateAgentError(null)
    try {
      const created = await agentsApi.createAgent({
        name,
        customInstruction: newAgentInstructions.trim(),
      })
      const response = await agentsApi.listAgents()
      agentsByWorkspace.set(workspaceCacheKey, response.agents)
      setAgentListState({
        workspaceCacheKey,
        agents: response.agents,
        isLoading: false,
      })
      setLastSelectedAgentId(activeWorkspaceId, created.id)
      setCreateDialogOpen(false)
      setNewAgentName('')
      setNewAgentInstructions('')
      setAgentsMenuOpen(true)
      window.dispatchEvent(new CustomEvent('radioso:agents-updated', {
        detail: { agentId: created.id },
      }))
      router.push(buildDashboardHref(accountId, {
        section: 'agents',
        workspaceId: activeWorkspaceId,
        workspacePublicRouteKey: activeWorkspace?.publicRouteKey,
        agentId: created.id,
        agentTab: 'behavior',
      }))
    } catch {
      setCreateAgentError('Failed to create agent')
    } finally {
      setIsCreatingAgent(false)
    }
  }

  return (
    <>
      <Sidebar collapsible="offcanvas">
        <SidebarHeader className="p-4">
          <div className="flex items-center gap-2">
            <Image
              src="/radioso-icon.svg"
              alt="radioso logo"
              width={32}
              height={32}
              className="h-8 w-8 flex-shrink-0"
            />
            <span className="truncate font-semibold text-foreground">
              {organizationName}
            </span>
          </div>
        </SidebarHeader>

        <SidebarContent>
          <SidebarGroup>
            <SidebarGroupLabel className="text-[11px] text-sidebar-foreground/50">Workspace</SidebarGroupLabel>
            <SidebarGroupContent>
              <WorkspaceSwitcher accountId={accountId} currentView={currentView} routeState={routeState} />
              <SidebarMenu>
                <SidebarMenuItem>
                  <Collapsible open={agentsMenuOpen} onOpenChange={setAgentsMenuOpen}>
                    <div className="relative">
                      <SidebarMenuButton asChild isActive={currentView === 'agents'} tooltip={agentTooltip} className="pr-8">
                        <Link href={agentHref}>
                          <Bot className="w-4 h-4" />
                          <span>{agentName}</span>
                        </Link>
                      </SidebarMenuButton>
                      <CollapsibleTrigger asChild>
                        <SidebarMenuAction
                          aria-label={agentsMenuOpen ? 'Collapse agents' : 'Expand agents'}
                          className="right-2 w-4 text-muted-foreground"
                        >
                          <ChevronDown className={`transition-transform ${agentsMenuOpen ? 'rotate-180' : ''}`} />
                        </SidebarMenuAction>
                      </CollapsibleTrigger>
                    </div>
                    <CollapsibleContent>
                      <SidebarMenuSub>
                        {agentListState.isLoading && agents.length === 0 ? (
                          <SidebarMenuSubItem>
                            <div className="flex h-7 items-center gap-2 px-2 text-xs text-muted-foreground">
                              <RefreshCw className="h-3.5 w-3.5 animate-spin" />
                              Loading agents
                            </div>
                          </SidebarMenuSubItem>
                        ) : null}
                        {agents.map((agent) => (
                          <SidebarMenuSubItem key={agent.id}>
                            <SidebarMenuSubButton
                              asChild
                              isActive={currentView === 'agents' && agent.id === selectedAgentId}
                            >
                              <Link
                                href={buildAgentHref(agent.id)}
                                onClick={() => setLastSelectedAgentId(activeWorkspaceId, agent.id)}
                              >
                                <span>{agent.name || 'Agent'}</span>
                              </Link>
                            </SidebarMenuSubButton>
                          </SidebarMenuSubItem>
                        ))}
                        <SidebarMenuSubItem className="mt-1 border-t border-sidebar-border pt-1">
                          <SidebarMenuSubButton asChild>
                            <button
                              type="button"
                              onClick={() => {
                                setCreateAgentError(null)
                                setCreateDialogOpen(true)
                              }}
                            >
                              <Plus className="h-4 w-4" />
                              <span>New agent</span>
                            </button>
                          </SidebarMenuSubButton>
                        </SidebarMenuSubItem>
                      </SidebarMenuSub>
                    </CollapsibleContent>
                  </Collapsible>
                </SidebarMenuItem>
              </SidebarMenu>
            </SidebarGroupContent>
          </SidebarGroup>

          <SidebarGroup>
            <SidebarGroupLabel className="text-[11px] text-sidebar-foreground/50">Navigation</SidebarGroupLabel>
            <SidebarGroupContent>
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
                      <p className="text-sm font-medium text-foreground truncate">
                        {userDisplayName}
                      </p>
                      <p className="text-xs text-muted-foreground truncate">
                        {user?.email || 'user@example.com'}
                      </p>
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
      <Dialog open={createDialogOpen} onOpenChange={setCreateDialogOpen}>
        <DialogContent>
          <form onSubmit={handleCreateAgent} className="space-y-4">
            <DialogHeader>
              <DialogTitle>Create agent</DialogTitle>
              <DialogDescription>
                Add a workspace agent with its own identity, instructions, and channel settings.
              </DialogDescription>
            </DialogHeader>
            <div className="space-y-2">
              <Label htmlFor="sidebarNewAgentName">Name</Label>
              <Input
                id="sidebarNewAgentName"
                value={newAgentName}
                onChange={(event) => setNewAgentName(event.target.value)}
                maxLength={200}
                autoFocus
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="sidebarNewAgentInstructions">Instructions</Label>
              <Textarea
                id="sidebarNewAgentInstructions"
                value={newAgentInstructions}
                onChange={(event) => setNewAgentInstructions(event.target.value.slice(0, 2000))}
                rows={4}
              />
            </div>
            {createAgentError ? <p className="text-sm text-destructive">{createAgentError}</p> : null}
            <DialogFooter>
              <Button type="button" variant="outline" onClick={() => setCreateDialogOpen(false)} disabled={isCreatingAgent}>
                Cancel
              </Button>
              <Button type="submit" disabled={!newAgentName.trim() || isCreatingAgent}>
                {isCreatingAgent ? <RefreshCw className="h-4 w-4 animate-spin" /> : null}
                Create
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>
    </>
  )
}
