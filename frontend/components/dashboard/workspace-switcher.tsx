'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'
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
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { SidebarMenu, SidebarMenuButton, SidebarMenuItem } from '@/components/ui/sidebar'
import { useWorkspace } from '@/lib/workspace-context'
import { accountApi, seedWorkspaceSession, setPendingAccountSwitchId } from '@/lib/api'
import { useAuth } from '@/lib/auth-context'
import {
  buildDashboardHref,
  retargetDashboardRouteToWorkspace,
  type DashboardRouteState,
  type DashboardSection,
} from '@/lib/dashboard-routes'
import { Building2, ChevronsUpDown, Check, Plus, Layers } from 'lucide-react'

interface WorkspaceSwitcherProps {
  accountId: string
  currentView: DashboardSection
  routeState: DashboardRouteState
}

export function WorkspaceSwitcher({ accountId, currentView, routeState }: WorkspaceSwitcherProps) {
  const router = useRouter()
  const { user, login } = useAuth()
  const {
    workspaces,
    activeWorkspace,
    accounts,
    accountsLoaded,
    accountsLoadFailed,
    switchWorkspace,
    createWorkspace,
  } = useWorkspace()
  const [isCreateOpen, setIsCreateOpen] = useState(false)
  const [isCreateOrganizationOpen, setIsCreateOrganizationOpen] = useState(false)
  const [newName, setNewName] = useState('')
  const [newOrganizationName, setNewOrganizationName] = useState('')
  const [isCreating, setIsCreating] = useState(false)
  const [isCreatingOrganization, setIsCreatingOrganization] = useState(false)
  const [createOrganizationError, setCreateOrganizationError] = useState<string | null>(null)
  const [isSwitchingAccountId, setIsSwitchingAccountId] = useState<string | null>(null)

  const handleCreate = async (e: React.FormEvent) => {
    e.preventDefault()
    const trimmed = newName.trim()
    if (!trimmed || isCreating) return

    setIsCreating(true)
    try {
      const workspace = await createWorkspace(trimmed)
      router.push(buildWorkspaceSwitchHref(workspace))
      setNewName('')
      setIsCreateOpen(false)
    } finally {
      setIsCreating(false)
    }
  }

  const buildWorkspaceSwitchHref = (workspace: { id: string; publicRouteKey?: string | null }) => {
    return buildDashboardHref(
      accountId,
      retargetDashboardRouteToWorkspace(routeState, workspace.id, workspace.publicRouteKey),
    )
  }

  const handleWorkspaceSwitch = async (workspace: { id: string; publicRouteKey?: string | null }) => {
    router.push(buildWorkspaceSwitchHref(workspace))
    await switchWorkspace(workspace.id)
  }

  const handleAccountSwitch = async (targetAccountId: string, preferredWorkspaceId: string) => {
    if (!user || isSwitchingAccountId) {
      return
    }

    setIsSwitchingAccountId(targetAccountId)
    try {
      setPendingAccountSwitchId(targetAccountId)
      const response = await accountApi.switchAccount(targetAccountId, preferredWorkspaceId)
      seedWorkspaceSession(response.workspaceId, response.workspacePublicRouteKey)
      await login(user.email, response.userId, response.accountId, response.organizationName)
      router.replace(buildDashboardHref(response.accountId, {
        section: currentView,
        workspaceId: response.workspaceId,
        workspacePublicRouteKey: response.workspacePublicRouteKey,
      }))
    } finally {
      setIsSwitchingAccountId(null)
    }
  }

  const handleCreateOrganization = async (event: React.FormEvent) => {
    event.preventDefault()
    const trimmed = newOrganizationName.trim()
    if (!trimmed || isCreatingOrganization || !user) {
      return
    }

    setIsCreatingOrganization(true)
    setCreateOrganizationError(null)
    try {
      const response = await accountApi.createOrganization(trimmed)
      setPendingAccountSwitchId(response.accountId)
      seedWorkspaceSession(response.workspaceId, response.workspacePublicRouteKey)
      await login(user.email, response.userId, response.accountId, response.organizationName)
      setNewOrganizationName('')
      setIsCreateOrganizationOpen(false)
      router.replace(buildDashboardHref(response.accountId, {
        section: currentView,
        workspaceId: response.workspaceId,
        workspacePublicRouteKey: response.workspacePublicRouteKey,
      }))
    } catch {
      setCreateOrganizationError('Failed to create organization')
    } finally {
      setIsCreatingOrganization(false)
    }
  }

  const displayedAccounts =
    user?.accountId === accountId && user.organizationName
      ? accounts.map((account) => account.accountId === accountId
        ? { ...account, organizationName: user.organizationName ?? account.organizationName }
        : account)
      : accounts
  const currentAccount = displayedAccounts.find((account) => account.accountId === accountId) ?? null
  const otherAccounts = displayedAccounts.filter((account) => account.accountId !== accountId)

  return (
    <>
      <SidebarMenu>
        <SidebarMenuItem>
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <SidebarMenuButton
                className="w-full"
                tooltip={activeWorkspace?.name ?? 'Workspace'}
              >
                <Layers className="w-4 h-4" />
                <span className="truncate ">
                  {activeWorkspace?.name ?? 'Workspace'}
                </span>
                <ChevronsUpDown className="ml-auto w-4 h-4 text-muted-foreground " />
              </SidebarMenuButton>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="start" className="w-72">
              {accountsLoaded ? (
                displayedAccounts.length > 0 ? (
                  <>
                    {currentAccount ? (
                      <>
                        <div className="px-2 pt-1.5 pb-1 text-xs font-medium text-muted-foreground">
                          {currentAccount.organizationName}
                        </div>
                        {workspaces.map((workspace) => (
                          <DropdownMenuItem
                            key={workspace.id}
                            onClick={() => void handleWorkspaceSwitch(workspace)}
                          >
                            <Layers className="w-4 h-4 mr-2 text-muted-foreground" />
                            <span className="truncate">{workspace.name}</span>
                            {workspace.id === activeWorkspace?.id ? (
                              <Check className="ml-auto w-4 h-4" />
                            ) : null}
                          </DropdownMenuItem>
                        ))}
                        <DropdownMenuItem onClick={() => setIsCreateOpen(true)}>
                          <Plus className="w-4 h-4 mr-2 text-muted-foreground" />
                          New workspace
                        </DropdownMenuItem>
                      </>
                    ) : null}

                    {otherAccounts.length > 0 ? (
                      <>
                        <DropdownMenuSeparator />
                        <div className="px-2 pt-1.5 pb-1 text-xs font-medium text-muted-foreground">
                          Switch organization
                        </div>
                        {otherAccounts.map((account) => (
                          <DropdownMenuItem
                            key={account.accountId}
                            onClick={() => void handleAccountSwitch(account.accountId, account.workspaceId)}
                            disabled={isSwitchingAccountId !== null}
                          >
                            <Building2 className="w-4 h-4 mr-2 text-muted-foreground" />
                            <span className="truncate">{account.organizationName}</span>
                          </DropdownMenuItem>
                        ))}
                      </>
                    ) : null}
                  </>
                ) : (
                  <DropdownMenuItem disabled>
                    <Building2 className="w-4 h-4 mr-2" />
                    No organizations available
                  </DropdownMenuItem>
                )
              ) : accountsLoadFailed ? (
                <DropdownMenuItem disabled>
                  <Building2 className="w-4 h-4 mr-2" />
                  Organizations unavailable
                </DropdownMenuItem>
              ) : (
                <DropdownMenuItem disabled>
                  <Building2 className="w-4 h-4 mr-2" />
                  Loading organizations...
                </DropdownMenuItem>
              )}
              <DropdownMenuSeparator />
              <DropdownMenuItem onClick={() => setIsCreateOrganizationOpen(true)}>
                <Plus className="w-4 h-4 mr-2 text-muted-foreground" />
                New organization
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </SidebarMenuItem>
      </SidebarMenu>

      <Dialog open={isCreateOpen} onOpenChange={setIsCreateOpen}>
        <DialogContent className="sm:max-w-sm">
          <DialogHeader>
            <DialogTitle>Create workspace</DialogTitle>
          </DialogHeader>
          <form onSubmit={handleCreate}>
            <Input
              value={newName}
              onChange={(e) => setNewName(e.target.value)}
              placeholder="Workspace name"
              maxLength={100}
              autoFocus
            />
            <DialogFooter className="mt-4">
              <Button
                type="button"
                variant="outline"
                onClick={() => setIsCreateOpen(false)}
              >
                Cancel
              </Button>
              <Button type="submit" disabled={!newName.trim() || isCreating}>
                {isCreating ? 'Creating...' : 'Create'}
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>

      <Dialog open={isCreateOrganizationOpen} onOpenChange={setIsCreateOrganizationOpen}>
        <DialogContent className="sm:max-w-sm">
          <DialogHeader>
            <DialogTitle>Create organization</DialogTitle>
          </DialogHeader>
          <form onSubmit={handleCreateOrganization}>
            <Input
              value={newOrganizationName}
              onChange={(event) => {
                setNewOrganizationName(event.target.value)
                setCreateOrganizationError(null)
              }}
              placeholder="Organization name"
              maxLength={80}
              autoFocus
            />
            {createOrganizationError ? <p className="mt-2 text-sm text-destructive">{createOrganizationError}</p> : null}
            <DialogFooter className="mt-4">
              <Button
                type="button"
                variant="outline"
                onClick={() => setIsCreateOrganizationOpen(false)}
              >
                Cancel
              </Button>
              <Button type="submit" disabled={!newOrganizationName.trim() || isCreatingOrganization}>
                {isCreatingOrganization ? 'Creating...' : 'Create'}
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>
    </>
  )
}
