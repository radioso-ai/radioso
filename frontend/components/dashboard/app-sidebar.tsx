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
  SidebarHeader,
  SidebarMenu,
  SidebarMenuAction,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarMenuSub,
  SidebarMenuSubButton,
  SidebarMenuSubItem,
  SidebarSeparator,
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
  User,
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
    return agents.find((agent) => agent.id === preferredAgentId) ?? null
  }

  return agents.find((agent) => agent.isDefault) ?? agents[0] ?? null
}

export function AppSidebar({ accountId, currentView, routeState }: AppSidebarProps) {
  const router = useRouter()
  const { user, logout } = useAuth()
  const { activeWorkspace, activeWorkspaceId } = useWorkspace()
  const { theme, setTheme } = useTheme()
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
  const [agentsMenuOpen, setAgentsMenuOpen] = useState(currentView === 'agents')
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
  const agentName = selectedAgentName?.trim() || activeWorkspace?.name || 'Agent'
  const agentLabel = `Agent: ${agentName}`

  useEffect(() => {
    if (currentView !== 'agents') {
      return
    }

    const timeout = window.setTimeout(() => {
      setAgentsMenuOpen(true)
    }, 0)

    return () => window.clearTimeout(timeout)
  }, [currentView])

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
    agentId: currentView === 'agents' ? routeState.agentId ?? selectedAgentId ?? undefined : selectedAgentId ?? undefined,
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
                  <Collapsible open={agentsMenuOpen} onOpenChange={setAgentsMenuOpen}>
                    <div className="relative">
                      <SidebarMenuButton asChild isActive={currentView === 'agents'} tooltip={agentLabel} className="pr-8">
                        <Link href={agentHref}>
                          <Bot className="w-4 h-4" />
                          <span>{agentLabel}</span>
                        </Link>
                      </SidebarMenuButton>
                      <CollapsibleTrigger asChild>
                        <SidebarMenuAction aria-label={agentsMenuOpen ? 'Collapse agents' : 'Expand agents'}>
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
                                <span>{agent.name || 'Agent'}{agent.isDefault ? ' (default)' : ''}</span>
                              </Link>
                            </SidebarMenuSubButton>
                          </SidebarMenuSubItem>
                        ))}
                        <SidebarMenuSubItem className="mt-1 border-t border-sidebar-border pt-1">
                          <SidebarMenuSubButton asChild size="md" className="h-auto py-2">
                            <button
                              type="button"
                              onClick={() => {
                                setCreateAgentError(null)
                                setCreateDialogOpen(true)
                              }}
                            >
                              <Plus className="h-4 w-4" />
                              <span className="flex min-w-0 flex-col items-start">
                                <span className="truncate">Create an agent</span>
                                <span className="truncate text-xs text-muted-foreground">Create a new agent</span>
                              </span>
                            </button>
                          </SidebarMenuSubButton>
                        </SidebarMenuSubItem>
                      </SidebarMenuSub>
                    </CollapsibleContent>
                  </Collapsible>
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
