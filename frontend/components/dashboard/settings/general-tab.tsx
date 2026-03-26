'use client'

import { useEffect, useState } from 'react'
import { ExternalLink, Key, MessageSquare, Save, Trash2 } from 'lucide-react'

import { Button } from '@/components/ui/button'
import { CopyValueField } from '@/components/ui/copy-value-field'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Slider } from '@/components/ui/slider'
import { Spinner } from '@/components/ui/spinner'
import { Switch } from '@/components/ui/switch'
import { generalSettingsApi, type GeneralSettings, workspaceApi } from '@/lib/api'
import { useWorkspace } from '@/lib/workspace-context'

export function GeneralTab() {
  const { activeWorkspaceId, activeWorkspace, workspaces, renameWorkspace, deleteWorkspace } = useWorkspace()
  const [workspaceName, setWorkspaceName] = useState(activeWorkspace?.name ?? '')
  const [isRenameSaving, setIsRenameSaving] = useState(false)
  const [renameError, setRenameError] = useState<string | null>(null)
  const hasNameChange = workspaceName.trim() !== (activeWorkspace?.name ?? '')
  const [deleteConfirmName, setDeleteConfirmName] = useState('')
  const [isDeleting, setIsDeleting] = useState(false)
  const [deleteDialogOpen, setDeleteDialogOpen] = useState(false)
  const isLastWorkspace = workspaces.length <= 1
  const deleteConfirmValid = deleteConfirmName === activeWorkspace?.name
  const [token, setToken] = useState<string | null>(null)
  const [isTokenLoading, setIsTokenLoading] = useState(true)
  const [anonSettings, setAnonSettings] = useState<GeneralSettings | null>(null)
  const [isAnonLoading, setIsAnonLoading] = useState(true)
  const [isAnonSaving, setIsAnonSaving] = useState(false)

  useEffect(() => {
    setWorkspaceName(activeWorkspace?.name ?? '')
  }, [activeWorkspace?.name])

  useEffect(() => {
    if (!activeWorkspaceId) return
    setIsTokenLoading(true)
    const loadToken = async () => {
      try {
        const fetchedToken = await workspaceApi.getWorkspaceToken(activeWorkspaceId)
        setToken(fetchedToken)
      } catch (error) {
        console.error('Failed to load token:', error)
      } finally {
        setIsTokenLoading(false)
      }
    }
    void loadToken()
  }, [activeWorkspaceId])

  useEffect(() => {
    setIsAnonLoading(true)
    const loadAnonSettings = async () => {
      try {
        const data = await generalSettingsApi.getGeneralSettings()
        setAnonSettings(data)
      } catch (error) {
        console.error('Failed to load anonymous chat settings:', error)
      } finally {
        setIsAnonLoading(false)
      }
    }
    void loadAnonSettings()
  }, [activeWorkspaceId])

  const handleAnonToggle = async (enabled: boolean) => {
    setIsAnonSaving(true)
    try {
      const updated = await generalSettingsApi.updateGeneralSettings({
        anonymousChatEnabled: enabled,
        anonymousRateLimit: anonSettings?.anonymousRateLimit ?? 10,
      })
      setAnonSettings(updated)
    } catch (error) {
      console.error('Failed to update anonymous chat settings:', error)
    } finally {
      setIsAnonSaving(false)
    }
  }

  const handleAnonRateLimitChange = (value: number) => {
    if (!anonSettings) return
    setAnonSettings({ ...anonSettings, anonymousRateLimit: value })
  }

  const handleAnonRateLimitCommit = async (value: number) => {
    setIsAnonSaving(true)
    try {
      const updated = await generalSettingsApi.updateGeneralSettings({
        anonymousChatEnabled: anonSettings?.anonymousChatEnabled ?? false,
        anonymousRateLimit: value,
      })
      setAnonSettings(updated)
    } catch (error) {
      console.error('Failed to update rate limit:', error)
    } finally {
      setIsAnonSaving(false)
    }
  }

  const handleRename = async () => {
    if (!activeWorkspace || !hasNameChange) return
    const trimmed = workspaceName.trim()
    if (!trimmed || trimmed.length > 100) {
      setRenameError('Name must be between 1 and 100 characters')
      return
    }
    setIsRenameSaving(true)
    setRenameError(null)
    try {
      await renameWorkspace(activeWorkspace.id, trimmed)
    } catch {
      setRenameError('Failed to rename workspace')
    } finally {
      setIsRenameSaving(false)
    }
  }

  const handleDelete = async () => {
    if (!activeWorkspace || !deleteConfirmValid) return
    setIsDeleting(true)
    try {
      await deleteWorkspace(activeWorkspace.id)
      setDeleteDialogOpen(false)
      setDeleteConfirmName('')
    } catch {
      setIsDeleting(false)
    }
  }

  return (
    <div className="flex flex-col h-full">
      <div className="flex-1 overflow-y-auto p-6">
        <div className="max-w-xl space-y-8">
          <div className="space-y-6">
            <h2 className="text-sm font-medium text-foreground uppercase tracking-wide">Workspace</h2>
            <div className="space-y-3">
              <Label htmlFor="workspaceName" className="text-foreground">Workspace Name</Label>
              <div className="flex gap-2">
                <Input
                  id="workspaceName"
                  value={workspaceName}
                  onChange={(event) => {
                    setWorkspaceName(event.target.value)
                    setRenameError(null)
                  }}
                  maxLength={100}
                  className="flex-1"
                />
                <Button size="sm" onClick={handleRename} disabled={!hasNameChange || isRenameSaving}>
                  {isRenameSaving ? <Spinner className="mr-2" /> : <Save className="w-4 h-4 mr-2" />}
                  Save
                </Button>
              </div>
              {renameError ? <p className="text-sm text-destructive">{renameError}</p> : null}
            </div>
          </div>

          <div className="space-y-6">
            <h2 className="text-sm font-medium text-foreground uppercase tracking-wide">Developer API</h2>
            {isTokenLoading ? (
              <div className="flex items-center justify-center py-4">
                <Spinner className="w-5 h-5" />
              </div>
            ) : (
              <details className="rounded-lg border border-border bg-card p-4">
                <summary className="cursor-pointer list-none">
                  <div className="flex items-center gap-3">
                    <div className="w-10 h-10 rounded-full bg-primary/10 flex items-center justify-center">
                      <Key className="w-5 h-5 text-primary" />
                    </div>
                    <div>
                      <h3 className="font-medium text-foreground">API token and curl usage</h3>
                      <p className="text-sm text-muted-foreground">
                        Post-onboarding access for SDKs, scripts, and direct API requests.
                      </p>
                    </div>
                  </div>
                </summary>

                <div className="mt-4 space-y-4">
                  <div className="space-y-2">
                    <Label htmlFor="token" className="sr-only">API Token</Label>
                    <CopyValueField value={token || ''} ariaLabel="Copy token" disabled={!token} />
                  </div>

                  <div className="rounded bg-muted/50 p-3 space-y-2">
                    <p className="text-sm text-muted-foreground">
                      Use this workspace-scoped token only after the workspace already works in the UI.
                    </p>
                    <code className="block p-2 bg-card border border-border rounded text-sm font-mono text-foreground overflow-x-auto">
                      Authorization: Bearer {token?.slice(0, 15)}...
                    </code>
                  </div>
                </div>
              </details>
            )}
          </div>

          <div className="space-y-6">
            <h2 className="text-sm font-medium text-foreground uppercase tracking-wide">Anonymous Chat Access</h2>
            {isAnonLoading ? (
              <div className="flex items-center justify-center py-4">
                <Spinner className="w-5 h-5" />
              </div>
            ) : anonSettings ? (
              <div className="rounded-lg border border-border bg-card p-4 space-y-4">
                <div className="flex items-start justify-between gap-4">
                  <div className="flex items-center gap-3">
                    <div className="flex h-10 w-10 items-center justify-center rounded-full bg-primary/10">
                      <MessageSquare className="h-5 w-5 text-primary" />
                    </div>
                    <div>
                      <Label htmlFor="anonChatToggle" className="text-base font-medium text-foreground">
                        Anonymous Chat
                      </Label>
                      <p className="text-sm text-muted-foreground mt-0.5">
                        Allow unauthenticated users to chat via a public link.
                      </p>
                    </div>
                  </div>
                  <Switch
                    id="anonChatToggle"
                    checked={anonSettings.anonymousChatEnabled}
                    onCheckedChange={handleAnonToggle}
                    disabled={isAnonSaving}
                  />
                </div>

                {anonSettings.anonymousChatEnabled && anonSettings.anonymousChatUrl ? (
                  <>
                    <div className="space-y-2">
                      <Label htmlFor="anonChatUrl" className="text-foreground">Public Chat URL</Label>
                      <div className="flex flex-wrap items-start gap-2">
                        <CopyValueField
                          value={anonSettings.anonymousChatUrl}
                          ariaLabel="Copy URL"
                          className="min-w-[320px] flex-1"
                        />
                        <Button asChild className="bg-blue-600 text-white hover:bg-blue-500">
                          <a href={anonSettings.anonymousChatUrl} target="_blank" rel="noreferrer">
                            <ExternalLink className="w-4 h-4" />
                            Try the chat
                          </a>
                        </Button>
                      </div>
                      <p className="text-sm text-muted-foreground">
                        Share this link with anyone you want to give chat access to.
                      </p>
                    </div>

                    <div className="rounded bg-muted/50 p-3 space-y-3">
                      <div className="flex items-center justify-between">
                        <Label htmlFor="anonRateLimit" className="text-foreground">Rate Limit</Label>
                        <span className="text-sm font-mono text-muted-foreground">
                          {anonSettings.anonymousRateLimit} msg/min
                        </span>
                      </div>
                      <Slider
                        id="anonRateLimit"
                        min={1}
                        max={60}
                        step={1}
                        value={[anonSettings.anonymousRateLimit]}
                        onValueChange={([value]) => handleAnonRateLimitChange(value)}
                        onValueCommit={([value]) => handleAnonRateLimitCommit(value)}
                        disabled={isAnonSaving}
                      />
                      <p className="text-sm text-muted-foreground">
                        Maximum messages per minute for each anonymous user session.
                      </p>
                    </div>
                  </>
                ) : null}
              </div>
            ) : (
              <p className="text-sm text-muted-foreground">Failed to load anonymous chat settings.</p>
            )}
          </div>

          <div className="space-y-4 rounded-md border border-destructive/50 p-4">
            <h2 className="text-sm font-medium text-destructive uppercase tracking-wide">Danger Zone</h2>
            <div className="flex items-center justify-between gap-4">
              <div>
                <p className="text-sm font-medium text-foreground">Delete this workspace</p>
                <p className="text-sm text-muted-foreground">
                  Permanently delete this workspace and all its documents, chats, and settings. This action cannot be undone.
                </p>
              </div>

              <Dialog
                open={deleteDialogOpen}
                onOpenChange={(open) => {
                  setDeleteDialogOpen(open)
                  if (!open) {
                    setDeleteConfirmName('')
                    setIsDeleting(false)
                  }
                }}
              >
                <DialogTrigger asChild>
                  <Button
                    variant="destructive"
                    size="sm"
                    disabled={isLastWorkspace}
                    title={isLastWorkspace ? 'Cannot delete the last workspace' : undefined}
                  >
                    <Trash2 className="w-4 h-4 mr-2" />
                    Delete
                  </Button>
                </DialogTrigger>
                <DialogContent>
                  <DialogHeader>
                    <DialogTitle>Delete workspace</DialogTitle>
                    <DialogDescription>
                      This will permanently delete the workspace <strong>{activeWorkspace?.name}</strong> and
                      all its documents, conversations, and settings. This action cannot be undone.
                    </DialogDescription>
                  </DialogHeader>
                  <div className="space-y-2 py-2">
                    <Label htmlFor="deleteConfirm" className="text-foreground">
                      Type <strong>{activeWorkspace?.name}</strong> to confirm
                    </Label>
                    <Input
                      id="deleteConfirm"
                      value={deleteConfirmName}
                      onChange={(event) => setDeleteConfirmName(event.target.value)}
                      placeholder={activeWorkspace?.name}
                    />
                  </div>
                  <DialogFooter>
                    <Button variant="outline" onClick={() => setDeleteDialogOpen(false)}>
                      Cancel
                    </Button>
                    <Button
                      variant="destructive"
                      onClick={handleDelete}
                      disabled={!deleteConfirmValid || isDeleting}
                    >
                      {isDeleting ? <Spinner className="mr-2" /> : <Trash2 className="w-4 h-4 mr-2" />}
                      Delete workspace
                    </Button>
                  </DialogFooter>
                </DialogContent>
              </Dialog>
            </div>

            {isLastWorkspace ? (
              <p className="text-sm text-muted-foreground">
                You cannot delete your only workspace. Create another workspace first.
              </p>
            ) : null}
          </div>
        </div>
      </div>
    </div>
  )
}
