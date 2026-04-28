'use client'

import { useEffect, useState } from 'react'
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
import { buildDashboardHref, type DashboardSection } from '@/lib/dashboard-routes'
import { Building2, ChevronsUpDown, Check, Plus, Layers } from 'lucide-react'

interface WorkspaceSwitcherProps {
  accountId: string
  currentView: DashboardSection
}

export function WorkspaceSwitcher({ accountId, currentView }: WorkspaceSwitcherProps) {
  const router = useRouter()
  const { user, login } = useAuth()
  const { workspaces, activeWorkspace, switchWorkspace, createWorkspace } = useWorkspace()
  const [isCreateOpen, setIsCreateOpen] = useState(false)
  const [isCreateOrganizationOpen, setIsCreateOrganizationOpen] = useState(false)
  const [newName, setNewName] = useState('')
  const [newOrganizationName, setNewOrganizationName] = useState('')
  const [isCreating, setIsCreating] = useState(false)
  const [isCreatingOrganization, setIsCreatingOrganization] = useState(false)
  const [createOrganizationError, setCreateOrganizationError] = useState<string | null>(null)
  const [accounts, setAccounts] = useState<Array<{
    accountId: string
    organizationName: string
    role: 'owner' | 'member'
    workspaceId: string
    workspaceName: string
  }>>([])
  const [accountsLoaded, setAccountsLoaded] = useState(false)
  const [accountsLoadFailed, setAccountsLoadFailed] = useState(false)
  const [isSwitchingAccountId, setIsSwitchingAccountId] = useState<string | null>(null)

  useEffect(() => {
    let active = true

    const loadAccounts = async () => {
      if (!user) {
        if (!active) return
        setAccounts([])
        setAccountsLoaded(true)
        setAccountsLoadFailed(false)
        return
      }

      try {
        const response = await accountApi.listAccounts()
        if (!active) return
        setAccounts(response.accounts)
        setAccountsLoadFailed(false)
      } catch {
        if (!active) return
        setAccounts([])
        setAccountsLoadFailed(true)
      } finally {
        if (!active) return
        setAccountsLoaded(true)
      }
    }

    // eslint-disable-next-line react-hooks/set-state-in-effect -- Account menu reloads when the authenticated user changes.
    setAccountsLoaded(false)
    setAccountsLoadFailed(false)
    void loadAccounts()
    const handleAccountRefresh = () => {
      void loadAccounts()
    }
    window.addEventListener('radioso:accounts-updated', handleAccountRefresh)
    return () => {
      active = false
      window.removeEventListener('radioso:accounts-updated', handleAccountRefresh)
    }
  }, [user, user?.accountId, user?.userId])

  const handleCreate = async (e: React.FormEvent) => {
    e.preventDefault()
    const trimmed = newName.trim()
    if (!trimmed || isCreating) return

    setIsCreating(true)
    try {
      await createWorkspace(trimmed)
      setNewName('')
      setIsCreateOpen(false)
    } finally {
      setIsCreating(false)
    }
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
      await login(user.email, response.userId, response.accountId)
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
      await login(user.email, response.userId, response.accountId)
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

  const currentAccount = accounts.find((account) => account.accountId === accountId) ?? null
  const otherAccounts = accounts.filter((account) => account.accountId !== accountId)

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
                <div className="w-5 h-5 rounded bg-muted flex items-center justify-center flex-shrink-0">
                  <Layers className="w-3 h-3 text-muted-foreground" />
                </div>
                <span className="truncate group-data-[collapsible=icon]:hidden">
                  {activeWorkspace?.name ?? 'Workspace'}
                </span>
                <ChevronsUpDown className="ml-auto w-4 h-4 text-muted-foreground group-data-[collapsible=icon]:hidden" />
              </SidebarMenuButton>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="start" className="w-72">
              {accountsLoaded ? (
                accounts.length > 0 ? (
                  <div className="space-y-3 p-1">
                    {currentAccount ? (
                      <div className="space-y-1">
                        <div className="px-2 pb-1 text-[10px] uppercase tracking-[0.18em] text-muted-foreground">
                          Current organization
                        </div>
                        <div className="flex items-start gap-2 px-2 py-1.5">
                          <div className="mt-0.5 flex h-8 w-8 items-center justify-center rounded-md bg-muted text-muted-foreground">
                            <Building2 className="h-4 w-4" />
                          </div>
                          <div className="min-w-0 flex-1">
                            <p className="truncate text-sm font-medium text-inherit">{currentAccount.organizationName}</p>
                            <p className="mt-0.5 text-xs text-muted-foreground">Workspaces in this organization</p>
                          </div>
                        </div>
                        <div className="mt-1 space-y-1">
                          {workspaces.map((workspace) => (
                            <DropdownMenuItem
                              key={workspace.id}
                              onClick={() => switchWorkspace(workspace.id)}
                              className="ml-5"
                            >
                              <div className="mr-2 flex h-8 w-8 items-center justify-center rounded-md bg-muted text-muted-foreground">
                                <Layers className="h-4 w-4" />
                              </div>
                              <div className="min-w-0 flex-1">
                                <div className="truncate text-inherit">{workspace.name}</div>
                              </div>
                              {workspace.id === activeWorkspace?.id ? (
                                <Check className="ml-auto w-4 h-4" />
                              ) : null}
                            </DropdownMenuItem>
                          ))}
                          <DropdownMenuItem onClick={() => setIsCreateOpen(true)} className="ml-5">
                            <Plus className="w-4 h-4 mr-2" />
                            Create workspace
                          </DropdownMenuItem>
                        </div>
                      </div>
                    ) : null}

                    {otherAccounts.length > 0 ? (
                      <div className="space-y-2">
                        <div className="px-2 text-[10px] uppercase tracking-[0.18em] text-muted-foreground">
                          Other organizations
                        </div>
                        {otherAccounts.map((account) => (
                          <DropdownMenuItem
                            key={account.accountId}
                            onClick={() => void handleAccountSwitch(account.accountId, account.workspaceId)}
                            disabled={isSwitchingAccountId !== null}
                            className="px-2 py-1.5"
                          >
                            <div className="mr-2 flex h-8 w-8 items-center justify-center rounded-md bg-muted text-muted-foreground">
                              <Building2 className="h-4 w-4" />
                            </div>
                            <div className="min-w-0 flex-1">
                              <p className="truncate text-sm font-medium text-inherit">{account.organizationName}</p>
                            </div>
                          </DropdownMenuItem>
                        ))}
                      </div>
                    ) : null}
                  </div>
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
              {accountsLoaded ? (
                <DropdownMenuSeparator />
              ) : null}
              <DropdownMenuItem onClick={() => setIsCreateOrganizationOpen(true)}>
                <Plus className="w-4 h-4 mr-2" />
                Create organization
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
