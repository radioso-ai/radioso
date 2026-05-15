'use client'

import { useEffect, useState } from 'react'
import Image from 'next/image'
import { Clock, Info, Plus, UserPlus } from 'lucide-react'

import { accountApi, workspaceApi, type AccountInvitationSummary, type AccountUserSummary, type AssignableAccountRole, type SupportImpersonationSummary, type Workspace, type WorkspaceGrantSummary, type WorkspaceGrantRole } from '@/lib/api'
import { getApiErrorMessage } from '@/lib/api-error'
import { DashboardPage } from '@/components/dashboard/shared/dashboard-page'
import {
  DashboardTable,
  DashboardTableBody,
  DashboardTableCell,
  DashboardTableHead,
  DashboardTableHeader,
  DashboardTableRow,
} from '@/components/dashboard/shared/dashboard-table'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { CopyValueField } from '@/components/ui/copy-value-field'
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogTitle,
} from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { LogoSpinner, Spinner } from '@/components/ui/spinner'
import { isValidEmailAddress } from '@/lib/validation'

export function UsersPanel() {
  const [accessView, setAccessView] = useState<'members' | 'workspaces'>('members')
  const [users, setUsers] = useState<AccountUserSummary[]>([])
  const [invitations, setInvitations] = useState<AccountInvitationSummary[]>([])
  const [workspaces, setWorkspaces] = useState<Workspace[]>([])
  const [workspaceGrants, setWorkspaceGrants] = useState<WorkspaceGrantSummary[]>([])
  const [supportImpersonations, setSupportImpersonations] = useState<SupportImpersonationSummary[]>([])
  const [currentUserId, setCurrentUserId] = useState<string | null>(null)
  const [isLoading, setIsLoading] = useState(true)
  const [isSubmitting, setIsSubmitting] = useState(false)
  const [inviteDialogOpen, setInviteDialogOpen] = useState(false)
  const [removingMembershipId, setRemovingMembershipId] = useState<string | null>(null)
  const [email, setEmail] = useState('')
  const [emailTouched, setEmailTouched] = useState(false)
  const [inviteRole, setInviteRole] = useState<AssignableAccountRole>('member')
  const [inviteLink, setInviteLink] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const currentUser = users.find((user) => user.userId === currentUserId)
  const canManageUsers = currentUser?.role === 'owner' || currentUser?.role === 'admin'
  const canRemoveUsers = currentUser?.role === 'owner'
  const nonOwnerUsers = users.filter((user) => user.role !== 'owner')
  const ownerUsers = users.filter((user) => user.role === 'owner')
  const activeUserEmails = new Set(users.map((user) => user.email.toLowerCase()))
  const visibleInvitations = invitations.filter((invitation) => (
    invitation.status === 'pending' && !activeUserEmails.has(invitation.email.toLowerCase())
  ))
  const trimmedEmail = email.trim()
  const isEmailValid = isValidEmailAddress(trimmedEmail)
  const showEmailError = emailTouched && trimmedEmail.length > 0 && !isEmailValid

  useEffect(() => {
    let active = true

    const load = async () => {
      setIsLoading(true)
      setError(null)
      try {
        const [response, workspaceList] = await Promise.all([
          accountApi.listUsers(),
          workspaceApi.list(),
        ])
        if (!active) return
        setUsers(response.users)
        setInvitations(response.invitations)
        setWorkspaces(workspaceList)
        setWorkspaceGrants(response.workspaceGrants ?? [])
        setSupportImpersonations(response.supportImpersonations ?? [])
        setCurrentUserId(response.currentUserId)
      } catch (nextError) {
        if (!active) return
        setError(getApiErrorMessage(nextError, 'Failed to load users.'))
      } finally {
        if (active) {
          setIsLoading(false)
        }
      }
    }

    void load()
    return () => {
      active = false
    }
  }, [])

  const handleInvite = async () => {
    setEmailTouched(true)
    if (!isEmailValid) {
      return
    }

    setIsSubmitting(true)
    setError(null)
    try {
      const response = await accountApi.createInvitation(trimmedEmail, inviteRole)
      setInvitations((current) => [response, ...current.filter((item) => item.id !== response.id)])
      setInviteLink(typeof window === 'undefined' ? response.acceptanceUrl : `${window.location.origin}${response.acceptanceUrl}`)
      setEmail('')
      setEmailTouched(false)
    } catch (nextError) {
      setError(getApiErrorMessage(nextError, 'Failed to send invitation.'))
    } finally {
      setIsSubmitting(false)
    }
  }

  const handleRemoveUser = async (membershipId: string) => {
    setRemovingMembershipId(membershipId)
    setError(null)
    try {
      await accountApi.removeUser(membershipId)
      setUsers((current) => current.filter((user) => user.membershipId !== membershipId))
    } catch (nextError) {
      setError(getApiErrorMessage(nextError, 'Failed to remove user access.'))
    } finally {
      setRemovingMembershipId(null)
    }
  }

  const handleRoleChange = async (membershipId: string, role: AssignableAccountRole) => {
    setError(null)
    try {
      const updated = await accountApi.updateUserRole(membershipId, role)
      setUsers((current) => current.map((user) => (
        user.membershipId === membershipId ? { ...user, role: updated.role } : user
      )))
    } catch (nextError) {
      setError(getApiErrorMessage(nextError, 'Failed to update user role.'))
    }
  }

  const handleWorkspaceGrantChange = async (workspaceId: string, userId: string, value: WorkspaceGrantRole | 'inherit') => {
    setError(null)
    try {
      if (value === 'inherit') {
        await accountApi.removeWorkspaceGrant(workspaceId, userId)
        setWorkspaceGrants((current) => current.filter((grant) => !(grant.workspaceId === workspaceId && grant.userId === userId)))
        return
      }
      const grant = await accountApi.setWorkspaceGrant(workspaceId, userId, value)
      setWorkspaceGrants((current) => [
        ...current.filter((item) => !(item.workspaceId === workspaceId && item.userId === userId)),
        grant,
      ])
    } catch (nextError) {
      setError(getApiErrorMessage(nextError, 'Failed to update workspace access.'))
    }
  }

  const getWorkspaceGrant = (workspaceId: string, userId: string) =>
    workspaceGrants.find((item) => item.workspaceId === workspaceId && item.userId === userId)

  const getWorkspaceAccessSummary = (user: AccountUserSummary) => {
    if (user.role === 'owner') {
      return 'All'
    }

    const explicitGrantCount = workspaceGrants.filter((grant) => grant.userId === user.userId).length
    if (explicitGrantCount === 0) {
      return 'Inherited'
    }
    return `${explicitGrantCount} workspace${explicitGrantCount === 1 ? '' : 's'}`
  }

  const getWorkspaceGrantCount = (workspaceId: string) =>
    workspaceGrants.filter((grant) => grant.workspaceId === workspaceId).length

  const formatRoleLabel = (role: AccountUserSummary['role'] | AssignableAccountRole) =>
    role.charAt(0).toUpperCase() + role.slice(1)

  const getRoleChipClassName = (role: AccountUserSummary['role'] | AssignableAccountRole) => {
    switch (role) {
      case 'owner':
        return 'border-transparent bg-[#EEEDFE] text-[#3C3489]'
      case 'admin':
        return 'border-transparent bg-[#E6F1FB] text-[#0C447C]'
      case 'member':
        return 'border-transparent bg-[#F1EFE8] text-[#444441]'
    }
  }

  const roleChipClassName = (role: AccountUserSummary['role'] | AssignableAccountRole) =>
    getRoleChipClassName(role)

  const renderRoleChip = (role: AccountUserSummary['role'] | AssignableAccountRole) => (
    <Badge className={roleChipClassName(role)}>
      {role === 'owner' ? <Image src="/radioso-icon.svg" alt="" aria-hidden="true" width={12} height={12} className="rounded-[2px]" /> : null}
      {formatRoleLabel(role)}
    </Badge>
  )

  const renderStatusChip = (status: 'active' | 'invited') => (
    <Badge className={`border-transparent ${status === 'active' ? 'bg-[#EAF3DE] text-[#27500A]' : 'bg-[#FFF4D8] text-[#7A4A00]'}`}>
      <span className={`h-1.5 w-1.5 rounded-full ${status === 'active' ? 'bg-[#639922]' : 'bg-[#D99000]'}`} />
      {status === 'active' ? 'Active' : 'Invited'}
    </Badge>
  )

  const workspaceChipClassName = 'border-[#B5D4F4] bg-[#E6F1FB] text-[#0C447C]'

  return (
    <div className="space-y-6">
      {isLoading ? (
        <div className="flex h-full items-center justify-center">
          <LogoSpinner imageClassName="h-7 w-7" />
        </div>
      ) : (
        <>
        <Dialog open={inviteDialogOpen} onOpenChange={setInviteDialogOpen}>
          <DialogContent className="max-w-[440px] gap-0 overflow-hidden p-0">
            <div className="px-6 pb-0 pt-6">
              <div className="mb-4 flex h-10 w-10 items-center justify-center rounded-md bg-[#EEEDFE] text-[#3C3489]">
                <UserPlus className="h-5 w-5" aria-hidden="true" />
              </div>
              <DialogTitle className="mb-1 text-[17px] font-medium leading-tight">
                Invite a teammate
              </DialogTitle>
              <p className="mb-5 text-[13px] leading-6 text-muted-foreground">
                They&apos;ll get an email to join your organization.
              </p>
            </div>

            <div className="px-6">
              <div className="mb-4 space-y-1.5">
                <Label htmlFor="invite-email" className="text-[13px] font-medium">Email address</Label>
                <Input
                  id="invite-email"
                  type="email"
                  placeholder="teammate@example.com"
                  value={email}
                  onBlur={() => setEmailTouched(true)}
                  onChange={(event) => {
                    setEmail(event.target.value)
                    setInviteLink(null)
                  }}
                  disabled={isSubmitting || !canManageUsers}
                  aria-invalid={showEmailError}
                  aria-describedby={showEmailError ? 'invite-email-error' : undefined}
                />
                {showEmailError ? (
                  <p id="invite-email-error" className="text-xs text-destructive">
                    Enter a valid email address.
                  </p>
                ) : null}
              </div>

              <div className="mb-4 space-y-1.5">
                <Label className="text-[13px] font-medium">Role</Label>
                <div className="grid grid-cols-2 gap-2">
                  {([
                    ['member', 'Member', 'Can access assigned workspaces'],
                    ['admin', 'Admin', 'Can manage members and workspaces'],
                  ] as const).map(([role, label, description]) => {
                    const selected = inviteRole === role
                    return (
                      <Button
                        key={role}
                        type="button"
                        variant="outline"
                        className={`h-auto flex-col items-start whitespace-normal px-3 py-2.5 text-left ${selected ? 'border-[#D99000] bg-background ring-1 ring-[#D99000]' : ''}`}
                        onClick={() => setInviteRole(role)}
                        disabled={isSubmitting || !canManageUsers}
                        aria-pressed={selected}
                      >
                        <span className="block text-[13px] font-medium text-foreground">{label}</span>
                        <span className="mt-0.5 block text-xs leading-5 text-muted-foreground">{description}</span>
                      </Button>
                    )
                  })}
                </div>
              </div>

              {inviteLink ? (
                <>
                  <div className="my-5 h-px bg-border" />

                  <div className="space-y-1.5">
                    <CopyValueField
                      label="Share invite link"
                      value={inviteLink}
                      ariaLabel="Copy invite link"
                      truncate
                    />
                    <p className="flex items-center gap-1 text-xs text-muted-foreground">
                      <Clock className="h-3.5 w-3.5" aria-hidden="true" />
                      Link expires in 7 days
                    </p>
                  </div>
                </>
              ) : null}

              {error ? <p className="mt-3 text-sm text-destructive">{error}</p> : null}
            </div>

            <DialogFooter className="mt-5 border-t border-border px-6 py-4 sm:justify-between">
              <span className="text-xs text-muted-foreground">
                {inviteLink ? 'Invitation sent' : ''}
              </span>
              <div className="flex items-center gap-2">
              <Button type="button" variant="outline" onClick={() => setInviteDialogOpen(false)} disabled={isSubmitting}>
                Cancel
              </Button>
              <Button
                onClick={() => void handleInvite()}
                disabled={!isEmailValid || isSubmitting || !canManageUsers}
              >
                {isSubmitting ? <Spinner className="mr-2 h-4 w-4" /> : null}
                Send invite
              </Button>
              </div>
            </DialogFooter>
          </DialogContent>
        </Dialog>

        <div className="border-b border-border">
          <div className="flex items-center gap-1">
            <button
              type="button"
              className={`border-b-2 px-4 py-2 text-sm ${accessView === 'members' ? 'border-foreground font-medium text-foreground' : 'border-transparent text-muted-foreground hover:text-foreground'}`}
              aria-pressed={accessView === 'members'}
              onClick={() => setAccessView('members')}
            >
              Members
            </button>
            <button
              type="button"
              className={`border-b-2 px-4 py-2 text-sm ${accessView === 'workspaces' ? 'border-foreground font-medium text-foreground' : 'border-transparent text-muted-foreground hover:text-foreground'}`}
              aria-pressed={accessView === 'workspaces'}
              onClick={() => setAccessView('workspaces')}
            >
              Workspaces
            </button>
          </div>
        </div>

        {accessView === 'members' ? (
        <>
          <section className="space-y-3">
          <div>
            <div className="flex flex-wrap items-start justify-between gap-3">
              <div>
                <h2 className="text-lg font-medium text-foreground">Members</h2>
                <p className="text-sm text-muted-foreground">
                  {users.length} active user{users.length === 1 ? '' : 's'}
                  {visibleInvitations.length > 0 ? `, ${visibleInvitations.length} pending invitation${visibleInvitations.length === 1 ? '' : 's'}` : ''}
                </p>
              </div>
              <Button
                type="button"
                size="sm"
                variant="outline"
                disabled={!canManageUsers}
                onClick={() => {
                  setInviteLink(null)
                  setError(null)
                  setInviteDialogOpen(true)
                }}
              >
                <Plus className="mr-2 h-4 w-4" />
                Invite member
              </Button>
            </div>
          </div>
          <div className="flex gap-2 rounded-md border border-border bg-muted/30 px-3 py-2 text-sm text-muted-foreground">
            <Info className="mt-0.5 h-4 w-4 shrink-0" />
            <p>
              Owners have access to all workspaces. Manage per-workspace member grants from the{' '}
              <button type="button" className="font-medium text-primary hover:underline" onClick={() => setAccessView('workspaces')}>
                Workspaces tab
              </button>
              .
            </p>
          </div>
            {users.length === 0 && visibleInvitations.length === 0 ? (
              <p className="text-sm text-muted-foreground">This organization does not have any members yet.</p>
            ) : (
              <DashboardTable minWidth="min-w-[760px]">
                <DashboardTableHead>
                  <DashboardTableHeader>User</DashboardTableHeader>
                  <DashboardTableHeader className="w-32">Role</DashboardTableHeader>
                  <DashboardTableHeader className="w-28">Status</DashboardTableHeader>
                  <DashboardTableHeader className="w-44">Date</DashboardTableHeader>
                  <DashboardTableHeader className="w-36">Workspaces</DashboardTableHeader>
                  <DashboardTableHeader className="w-28">
                    <span className="sr-only">Actions</span>
                  </DashboardTableHeader>
                </DashboardTableHead>
                <DashboardTableBody>
                  {users.map((user) => {
                    const canManageTargetUser = canManageUsers && user.userId !== currentUserId && user.role !== 'owner'
                    const canRemoveTargetUser = canRemoveUsers && user.userId !== currentUserId && user.role !== 'owner'
                    return (
                      <DashboardTableRow key={user.membershipId}>
                        <DashboardTableCell>
                          <span className="block truncate font-medium">{user.email}</span>
                        </DashboardTableCell>
                        <DashboardTableCell>
                          {canManageTargetUser ? (
                            <Select value={user.role} onValueChange={(value) => void handleRoleChange(user.membershipId, value as AssignableAccountRole)}>
                              <SelectTrigger size="sm" className={`h-auto w-fit rounded-md px-2 py-0.5 text-xs font-medium shadow-none focus:ring-2 ${getRoleChipClassName(user.role)}`}>
                                <SelectValue />
                              </SelectTrigger>
                              <SelectContent>
                                <SelectItem value="member">Member</SelectItem>
                                <SelectItem value="admin">Admin</SelectItem>
                              </SelectContent>
                            </Select>
                          ) : (
                            renderRoleChip(user.role)
                          )}
                        </DashboardTableCell>
                        <DashboardTableCell>{renderStatusChip('active')}</DashboardTableCell>
                        <DashboardTableCell className="text-muted-foreground">
                          {new Date(user.createdAt).toLocaleDateString()}
                        </DashboardTableCell>
                        <DashboardTableCell className="text-muted-foreground">
                          {user.role === 'owner' ? (
                            <Badge className={workspaceChipClassName}>All</Badge>
                          ) : (
                            <button
                              type="button"
                              className="inline-flex rounded-md focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
                              onClick={() => setAccessView('workspaces')}
                            >
                              <Badge className={`${workspaceChipClassName} hover:border-primary/50 hover:bg-primary/10`}>
                                {getWorkspaceAccessSummary(user)}
                              </Badge>
                            </button>
                          )}
                        </DashboardTableCell>
                        <DashboardTableCell>
                          {canRemoveTargetUser ? (
                            <Button
                              type="button"
                              variant="outline"
                              size="sm"
                              onClick={() => void handleRemoveUser(user.membershipId)}
                              disabled={removingMembershipId === user.membershipId}
                            >
                              {removingMembershipId === user.membershipId ? 'Removing...' : 'Remove'}
                            </Button>
                          ) : null}
                        </DashboardTableCell>
                      </DashboardTableRow>
                    )
                  })}
                  {visibleInvitations.map((invitation) => (
                    <DashboardTableRow key={invitation.id}>
                      <DashboardTableCell>
                        <span className="block truncate font-medium">{invitation.email}</span>
                      </DashboardTableCell>
                      <DashboardTableCell>{renderRoleChip(invitation.role)}</DashboardTableCell>
                      <DashboardTableCell>{renderStatusChip('invited')}</DashboardTableCell>
                      <DashboardTableCell className="text-muted-foreground">
                        Expires {new Date(invitation.expiresAt).toLocaleDateString()}
                      </DashboardTableCell>
                      <DashboardTableCell>
                        <Badge className={workspaceChipClassName}>
                          All as {formatRoleLabel(invitation.role)}
                        </Badge>
                      </DashboardTableCell>
                      <DashboardTableCell>
                        <span className="sr-only">No actions available</span>
                      </DashboardTableCell>
                    </DashboardTableRow>
                  ))}
                </DashboardTableBody>
              </DashboardTable>
            )}
          </section>
        </>
        ) : (
          <section className="space-y-4">
            <div>
              <h2 className="text-lg font-medium text-foreground">Workspaces</h2>
              <p className="text-sm text-muted-foreground">Manage explicit per-workspace role grants for organization members.</p>
            </div>
            <div className="flex gap-2 rounded-md border border-border bg-muted/30 px-3 py-2 text-sm text-muted-foreground">
              <Info className="mt-0.5 h-4 w-4 shrink-0" />
              <p>Owners always have access to every workspace. Members inherit their organization role unless a workspace grant refines it here.</p>
            </div>
            {workspaces.length === 0 ? (
              <p className="text-sm text-muted-foreground">No workspaces yet.</p>
            ) : (
              workspaces.map((workspace) => (
                <div key={workspace.id} className="overflow-hidden rounded-lg border border-border bg-card">
                  <div className="flex flex-wrap items-center justify-between gap-3 border-b border-border bg-muted/30 px-4 py-3">
                    <div>
                      <h3 className="text-sm font-medium text-foreground">{workspace.name}</h3>
                      <p className="text-xs text-muted-foreground">
                        {getWorkspaceGrantCount(workspace.id)} explicit grant{getWorkspaceGrantCount(workspace.id) === 1 ? '' : 's'}
                      </p>
                    </div>
                  </div>
                  <div className="divide-y divide-border">
                    {ownerUsers.map((user) => (
                      <div key={`${workspace.id}-${user.userId}`} className="flex items-center justify-between gap-4 px-4 py-3">
                        <div className="min-w-0">
                          <p className="truncate text-sm font-medium text-foreground">{user.email}</p>
                          <p className="text-xs text-muted-foreground">Owner · always has access</p>
                        </div>
                        <span className="text-sm text-muted-foreground">-</span>
                      </div>
                    ))}
                    {nonOwnerUsers.length === 0 ? (
                      <div className="px-4 py-3 text-sm text-muted-foreground">No non-owner members to configure.</div>
                    ) : (
                      nonOwnerUsers.map((user) => {
                        const grant = getWorkspaceGrant(workspace.id, user.userId)
                        const canManageTargetUser = canManageUsers && user.userId !== currentUserId
                        return (
                          <div key={`${workspace.id}-${user.userId}`} className="flex flex-wrap items-center justify-between gap-3 px-4 py-3">
                            <div className="min-w-0">
                              <p className="truncate text-sm font-medium text-foreground">{user.email}</p>
                              <p className="text-xs capitalize text-muted-foreground">{user.role}</p>
                            </div>
                            <Select
                              value={grant?.role ?? 'inherit'}
                              onValueChange={(value) => void handleWorkspaceGrantChange(workspace.id, user.userId, value as WorkspaceGrantRole | 'inherit')}
                              disabled={!canManageTargetUser}
                            >
                              <SelectTrigger size="sm" className="w-32">
                                <SelectValue />
                              </SelectTrigger>
                              <SelectContent>
                                <SelectItem value="inherit">Inherit</SelectItem>
                                <SelectItem value="member">Member</SelectItem>
                                <SelectItem value="admin">Admin</SelectItem>
                              </SelectContent>
                            </Select>
                          </div>
                        )
                      })
                    )}
                  </div>
                </div>
              ))
            )}
          </section>
        )}

        {supportImpersonations.length > 0 ? (
          <section className="space-y-3">
            <div>
              <h2 className="text-lg font-medium text-foreground">Support access</h2>
              <p className="text-sm text-muted-foreground">
                {supportImpersonations.some((session) => session.active)
                  ? 'Radioso support currently has active access.'
                  : 'Recent Radioso support access is listed here.'}
              </p>
            </div>
            <DashboardTable minWidth="min-w-[760px]">
              <DashboardTableHead>
                <DashboardTableHeader>Session</DashboardTableHeader>
                <DashboardTableHeader>Reason</DashboardTableHeader>
                <DashboardTableHeader className="w-32">Status</DashboardTableHeader>
                <DashboardTableHeader className="w-52">Expires</DashboardTableHeader>
              </DashboardTableHead>
              <DashboardTableBody>
                {supportImpersonations.map((session) => (
                  <DashboardTableRow key={session.id}>
                    <DashboardTableCell>
                      <span className="font-medium">
                        {session.active ? 'Active support session' : 'Support session'}
                      </span>
                    </DashboardTableCell>
                    <DashboardTableCell>
                      <span className="block truncate text-muted-foreground">{session.reason}</span>
                    </DashboardTableCell>
                    <DashboardTableCell className="capitalize text-muted-foreground">{session.status}</DashboardTableCell>
                    <DashboardTableCell className="text-muted-foreground">
                      {new Date(session.expiresAt).toLocaleString()}
                    </DashboardTableCell>
                  </DashboardTableRow>
                ))}
              </DashboardTableBody>
            </DashboardTable>
          </section>
        ) : null}
        </>
      )}
    </div>
  )
}

export function UsersView() {
  return (
    <DashboardPage
      title="Users"
      description="Invite teammates, manage organization roles, and adjust workspace access."
      contentClassName="space-y-6 p-6"
    >
      <UsersPanel />
    </DashboardPage>
  )
}
