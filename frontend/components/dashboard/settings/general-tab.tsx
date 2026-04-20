'use client'

import { useEffect, useMemo, useState } from 'react'
import { useRouter } from 'next/navigation'
import { Building2, Code2, Globe, ExternalLink, MessageSquare, RefreshCw, Save, Trash2 } from 'lucide-react'

import { SettingsTabShell } from '@/components/dashboard/settings/settings-tab-shell'
import { getSettingsTabDescriptor } from '@/components/dashboard/settings/settings-tab-metadata'
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
import { Textarea } from '@/components/ui/textarea'
import { getApiErrorMessage } from '@/lib/api-error'
import { type DashboardRouteState } from '@/lib/dashboard-routes'
import { accountApi, generalSettingsApi, type GeneralSettings } from '@/lib/api'
import { buildWebsiteEmbedSnippet, formatWebsiteEmbedOrigins, parseWebsiteEmbedOrigins } from '@/lib/embed-widget'
import { useWorkspace } from '@/lib/workspace-context'

export function GeneralTab({
  accountId,
  routeState,
}: {
  accountId: string
  routeState: DashboardRouteState
}) {
  const router = useRouter()
  const descriptor = getSettingsTabDescriptor('general')
  const { activeWorkspaceId, activeWorkspace, workspaces, renameWorkspace, deleteWorkspace } = useWorkspace()
  const [workspaceName, setWorkspaceName] = useState(activeWorkspace?.name ?? '')
  const [organizationName, setOrganizationName] = useState('')
  const [isOrganizationLoading, setIsOrganizationLoading] = useState(true)
  const [isOrganizationSaving, setIsOrganizationSaving] = useState(false)
  const [organizationError, setOrganizationError] = useState<string | null>(null)
  const [isRenameSaving, setIsRenameSaving] = useState(false)
  const [renameError, setRenameError] = useState<string | null>(null)
  const hasNameChange = workspaceName.trim() !== (activeWorkspace?.name ?? '')
  const [deleteConfirmName, setDeleteConfirmName] = useState('')
  const [isDeleting, setIsDeleting] = useState(false)
  const [deleteDialogOpen, setDeleteDialogOpen] = useState(false)
  const isLastWorkspace = workspaces.length <= 1
  const deleteConfirmValid = deleteConfirmName === activeWorkspace?.name
  const [anonSettings, setAnonSettings] = useState<GeneralSettings | null>(null)
  const [savedAnonSettings, setSavedAnonSettings] = useState<GeneralSettings | null>(null)
  const [isAnonLoading, setIsAnonLoading] = useState(true)
  const [isAnonSaving, setIsAnonSaving] = useState(false)
  const [websiteEmbedOrigins, setWebsiteEmbedOrigins] = useState('')
  const [assistantSettingsError, setAssistantSettingsError] = useState<string | null>(null)
  const [apiToken, setApiToken] = useState<string | null>(null)
  const [apiTokenError, setApiTokenError] = useState<string | null>(null)
  const [isApiTokenLoading, setIsApiTokenLoading] = useState(false)

  useEffect(() => {
    setWorkspaceName(activeWorkspace?.name ?? '')
  }, [activeWorkspace?.name])

  useEffect(() => {
    let active = true

    const loadOrganization = async () => {
      setIsOrganizationLoading(true)
      try {
        const response = await accountApi.listAccounts()
        if (!active) return
        const current = response.accounts.find((account) => account.accountId === accountId)
        setOrganizationName(current?.organizationName ?? '')
        setOrganizationError(null)
      } catch {
        if (!active) return
        setOrganizationError('Failed to load organization')
      } finally {
        if (active) {
          setIsOrganizationLoading(false)
        }
      }
    }

    void loadOrganization()
    return () => {
      active = false
    }
  }, [accountId])

  useEffect(() => {
    setApiToken(null)
    setApiTokenError(null)
    setIsApiTokenLoading(false)
  }, [activeWorkspaceId])

  useEffect(() => {
    setIsAnonLoading(true)
    const loadAnonSettings = async () => {
      try {
        const data = await generalSettingsApi.getGeneralSettings()
        setAnonSettings(data)
        setSavedAnonSettings(data)
        setWebsiteEmbedOrigins(formatWebsiteEmbedOrigins(data.websiteEmbedAllowedOrigins ?? []))
        setAssistantSettingsError(null)
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
      setSavedAnonSettings(updated)
      setWebsiteEmbedOrigins(formatWebsiteEmbedOrigins(updated.websiteEmbedAllowedOrigins ?? []))
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
      setSavedAnonSettings(updated)
      setWebsiteEmbedOrigins(formatWebsiteEmbedOrigins(updated.websiteEmbedAllowedOrigins ?? []))
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

  const handleOrganizationRename = async () => {
    const trimmed = organizationName.trim()
    if (!trimmed || trimmed.length > 80) {
      setOrganizationError('Organization name must be between 1 and 80 characters')
      return
    }

    setIsOrganizationSaving(true)
    setOrganizationError(null)
    try {
      const updated = await accountApi.renameOrganization(trimmed)
      setOrganizationName(updated.organizationName)
      window.dispatchEvent(new Event('radioso:accounts-updated'))
    } catch {
      setOrganizationError('Failed to rename organization')
    } finally {
      setIsOrganizationSaving(false)
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

  const handleRevealApiToken = async () => {
    if (!activeWorkspaceId) return
    setIsApiTokenLoading(true)
    setApiTokenError(null)
    try {
      const response = await accountApi.getWorkspaceToken(activeWorkspaceId)
      setApiToken(response.token)
    } catch (error) {
      console.error('Failed to reveal workspace token:', error)
      setApiTokenError('Failed to reveal the workspace token')
    } finally {
      setIsApiTokenLoading(false)
    }
  }

  const handleAssistantSettingChange = <K extends keyof GeneralSettings>(key: K, value: GeneralSettings[K]) => {
    if (!anonSettings) return
    setAssistantSettingsError(null)
    setAnonSettings({ ...anonSettings, [key]: value })
  }

  const hasAssistantChanges =
    anonSettings && savedAnonSettings
      ? (
          anonSettings.assistantName !== savedAnonSettings.assistantName ||
          anonSettings.assistantRole !== savedAnonSettings.assistantRole ||
          anonSettings.greetingInstruction !== savedAnonSettings.greetingInstruction ||
          anonSettings.assistantDefaultLocale !== savedAnonSettings.assistantDefaultLocale ||
          anonSettings.proactiveGreetingEnabled !== savedAnonSettings.proactiveGreetingEnabled
        )
      : false

  const handleAssistantSave = async () => {
    if (!anonSettings) return
    setIsAnonSaving(true)
    try {
      const updated = await generalSettingsApi.updateGeneralSettings({
        assistantName: anonSettings.assistantName,
        assistantRole: anonSettings.assistantRole,
        greetingInstruction: anonSettings.greetingInstruction,
        assistantDefaultLocale: anonSettings.assistantDefaultLocale,
        proactiveGreetingEnabled: anonSettings.proactiveGreetingEnabled,
      })
      setAnonSettings(updated)
      setSavedAnonSettings(updated)
      setWebsiteEmbedOrigins(formatWebsiteEmbedOrigins(updated.websiteEmbedAllowedOrigins ?? []))
      setAssistantSettingsError(null)
    } catch (error) {
      console.error('Failed to update assistant bootstrap settings:', error)
      setAssistantSettingsError(getApiErrorMessage(error, 'Failed to update assistant bootstrap settings.'))
    } finally {
      setIsAnonSaving(false)
    }
  }

  const hasWebsiteEmbedChanges =
    anonSettings && savedAnonSettings
      ? (
          anonSettings.websiteEmbedEnabled !== savedAnonSettings.websiteEmbedEnabled ||
          websiteEmbedOrigins !== formatWebsiteEmbedOrigins(savedAnonSettings.websiteEmbedAllowedOrigins ?? []) ||
          anonSettings.websiteEmbedLauncherLabel !== savedAnonSettings.websiteEmbedLauncherLabel ||
          anonSettings.websiteEmbedLauncherIcon !== savedAnonSettings.websiteEmbedLauncherIcon ||
          anonSettings.websiteEmbedLauncherPosition !== savedAnonSettings.websiteEmbedLauncherPosition
        )
      : false

  const websiteEmbedSnippet = useMemo(() => {
    if (!anonSettings) {
      return null
    }

    return (
      anonSettings.websiteEmbedSnippet ??
      buildWebsiteEmbedSnippet({
        websiteEmbedEnabled: anonSettings.websiteEmbedEnabled ?? false,
        websiteEmbedToken: anonSettings.websiteEmbedToken ?? null,
        websiteEmbedScriptUrl: anonSettings.websiteEmbedScriptUrl ?? null,
        websiteEmbedAllowedOrigins: anonSettings.websiteEmbedAllowedOrigins ?? [],
        websiteEmbedLauncherLabel: anonSettings.websiteEmbedLauncherLabel ?? 'Chat with us',
        websiteEmbedLauncherIcon: anonSettings.websiteEmbedLauncherIcon ?? 'chat',
        websiteEmbedLauncherPosition: anonSettings.websiteEmbedLauncherPosition ?? 'bottom-right',
      })
    )
  }, [anonSettings])

  const handleWebsiteEmbedSave = async () => {
    if (!anonSettings) return
    setIsAnonSaving(true)
    try {
      const updated = await generalSettingsApi.updateGeneralSettings({
        websiteEmbedEnabled: anonSettings.websiteEmbedEnabled ?? false,
        websiteEmbedAllowedOrigins: parseWebsiteEmbedOrigins(websiteEmbedOrigins),
        websiteEmbedLauncherLabel: anonSettings.websiteEmbedLauncherLabel ?? 'Chat with us',
        websiteEmbedLauncherIcon: anonSettings.websiteEmbedLauncherIcon ?? 'chat',
        websiteEmbedLauncherPosition: anonSettings.websiteEmbedLauncherPosition ?? 'bottom-right',
      })
      setAnonSettings(updated)
      setSavedAnonSettings(updated)
      setWebsiteEmbedOrigins(formatWebsiteEmbedOrigins(updated.websiteEmbedAllowedOrigins ?? []))
    } catch (error) {
      console.error('Failed to update website embed settings:', error)
    } finally {
      setIsAnonSaving(false)
    }
  }

  const handleAnonymousChatTokenRotate = async () => {
    if (!anonSettings) return
    setIsAnonSaving(true)
    try {
      const updated = await generalSettingsApi.updateGeneralSettings({
        rotateAnonymousChatToken: true,
      })
      setAnonSettings(updated)
      setSavedAnonSettings(updated)
      setWebsiteEmbedOrigins(formatWebsiteEmbedOrigins(updated.websiteEmbedAllowedOrigins ?? []))
    } catch (error) {
      console.error('Failed to rotate anonymous chat token:', error)
    } finally {
      setIsAnonSaving(false)
    }
  }

  const handleWebsiteEmbedTokenRotate = async () => {
    if (!anonSettings) return
    setIsAnonSaving(true)
    try {
      const updated = await generalSettingsApi.updateGeneralSettings({
        rotateWebsiteEmbedToken: true,
      })
      setAnonSettings(updated)
      setSavedAnonSettings(updated)
      setWebsiteEmbedOrigins(formatWebsiteEmbedOrigins(updated.websiteEmbedAllowedOrigins ?? []))
    } catch (error) {
      console.error('Failed to rotate website embed token:', error)
    } finally {
      setIsAnonSaving(false)
    }
  }

  return (
    <SettingsTabShell
      accountId={accountId}
      routeState={routeState}
      descriptor={descriptor}
      onNavigate={(href) => router.push(href)}
    >
      <div className="mx-auto max-w-4xl space-y-8">
        <section id="workspace-access" className="space-y-6 scroll-mt-24">
          <div className="space-y-2">
            <h2 className="text-xl font-semibold text-foreground">Workspace and access</h2>
            <p className="text-sm text-muted-foreground">
              Core operator controls for naming, admin API access, and workspace lifecycle.
            </p>
          </div>

            {isOrganizationLoading ? (
              <div className="flex items-center justify-center py-4">
                <Spinner className="w-5 h-5" />
              </div>
            ) : (
              <div className="rounded-lg border border-border bg-card p-4 space-y-4">
                <div className="flex items-start gap-3">
                  <div className="flex h-10 w-10 items-center justify-center rounded-full bg-primary/10">
                    <Building2 className="h-5 w-5 text-primary" />
                  </div>
                  <div className="min-w-0 flex-1 space-y-3">
                    <div>
                      <p className="text-sm font-medium text-foreground">Organization Name</p>
                      <p className="text-sm text-muted-foreground">
                        Update the label shown in the organization picker and invite flows.
                      </p>
                    </div>
                    <div className="flex flex-col gap-2 sm:flex-row">
                      <Input
                        value={organizationName}
                        onChange={(event) => {
                          setOrganizationName(event.target.value)
                          setOrganizationError(null)
                        }}
                        maxLength={80}
                        className="flex-1"
                      />
                      <Button
                        size="sm"
                        className="sm:self-start"
                        onClick={handleOrganizationRename}
                        disabled={!organizationName.trim() || isOrganizationSaving}
                      >
                        {isOrganizationSaving ? <Spinner className="mr-2" /> : <Save className="w-4 h-4 mr-2" />}
                        Save
                      </Button>
                    </div>
                    {organizationError ? <p className="text-sm text-destructive">{organizationError}</p> : null}
                  </div>
                </div>
              </div>
            )}

            <div className="rounded-lg border border-border bg-card p-4 space-y-3">
              <div>
                <p className="text-sm font-medium text-foreground">Workspace name</p>
                <p className="text-sm text-muted-foreground">
                  Rename the active workspace without changing any of its data or settings.
                </p>
              </div>
              <div className="flex flex-col gap-2 sm:flex-row">
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
                <Button
                  size="sm"
                  className="sm:self-start"
                  onClick={handleRename}
                  disabled={!hasNameChange || isRenameSaving}
                >
                  {isRenameSaving ? <Spinner className="mr-2" /> : <Save className="w-4 h-4 mr-2" />}
                  Save
                </Button>
              </div>
              {renameError ? <p className="text-sm text-destructive">{renameError}</p> : null}
            </div>

            <details className="rounded-lg border border-border bg-card p-4">
                <summary className="cursor-pointer list-none">
                  <div className="flex items-center gap-3">
                    <div>
                      <h3 className="font-medium text-foreground">Session-authenticated admin API</h3>
                      <p className="text-sm text-muted-foreground">
                        Admin requests now use the browser session cookie together with the active workspace id.
                      </p>
                    </div>
                  </div>
                </summary>

                <div className="mt-4 space-y-4">
                  <div className="rounded bg-muted/50 p-3 space-y-2">
                    <p className="text-sm text-muted-foreground">
                      The web app keeps admin access on the session cookie. Reveal the workspace API token only when
                      you need to paste it into curl, an SDK, or another client.
                    </p>
                    <div className="flex flex-wrap items-center gap-2">
                      <Button
                        size="sm"
                        variant="outline"
                        onClick={handleRevealApiToken}
                        disabled={!activeWorkspaceId || isApiTokenLoading}
                      >
                        {isApiTokenLoading ? <Spinner className="mr-2" /> : null}
                        Reveal API token
                      </Button>
                      {apiToken ? (
                        <Button size="sm" variant="ghost" onClick={() => setApiToken(null)}>
                          Hide token
                        </Button>
                      ) : null}
                    </div>
                    {apiToken ? (
                      <CopyValueField value={apiToken} ariaLabel="Copy API token" wrap className="w-full" />
                    ) : (
                      <p className="text-sm text-muted-foreground">
                        The token is fetched on demand, shown only in this tab, and cleared when you switch workspaces
                        or reload.
                      </p>
                    )}
                    {apiTokenError ? <p className="text-sm text-destructive">{apiTokenError}</p> : null}
                    <p className="text-sm text-muted-foreground">
                      Session-authenticated clients can also call admin routes with the active workspace id header.
                    </p>
                    {activeWorkspaceId ? (
                      <>
                        <CopyValueField value={activeWorkspaceId} ariaLabel="Copy workspace id" />
                        <code className="block p-2 bg-card border border-border rounded text-sm font-mono text-foreground overflow-x-auto">
                          X-Workspace-Id: {activeWorkspaceId}
                        </code>
                      </>
                    ) : null}
                  </div>
                </div>
              </details>

        </section>

          <section id="assistant-identity" className="space-y-6 scroll-mt-24">
            <h2 className="text-sm font-medium text-foreground uppercase tracking-wide">Assistant Identity</h2>
            {isAnonLoading ? (
              <div className="flex items-center justify-center py-4">
                <Spinner className="w-5 h-5" />
              </div>
            ) : anonSettings ? (
              <div className="rounded-lg border border-border bg-card p-4 space-y-4">
                <div className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
                  <div className="min-w-0">
                    <p className="text-base font-medium text-foreground">Assistant bootstrap</p>
                    <p className="text-sm text-muted-foreground mt-0.5">
                      Define the assistant&apos;s stable identity here. The active chat language can still be overridden per session, for example by an embedded website popup.
                    </p>
                  </div>
                  <Button
                    size="sm"
                    className="sm:self-start"
                    onClick={handleAssistantSave}
                    disabled={!hasAssistantChanges || isAnonSaving}
                  >
                    {isAnonSaving ? <Spinner className="mr-2" /> : <Save className="w-4 h-4 mr-2" />}
                    Save
                  </Button>
                </div>
                {assistantSettingsError ? (
                  <p className="text-sm text-destructive" role="alert">{assistantSettingsError}</p>
                ) : null}

                <div className="grid gap-4 md:grid-cols-2">
                  <div className="space-y-2">
                    <Label htmlFor="assistantName" className="text-foreground">Assistant name</Label>
                    <Input
                      id="assistantName"
                      value={anonSettings.assistantName}
                      maxLength={200}
                      onChange={(event) => handleAssistantSettingChange('assistantName', event.target.value)}
                      placeholder="e.g. Marta"
                    />
                  </div>
                  <div className="space-y-2">
                    <Label htmlFor="assistantDefaultLocale" className="text-foreground">Default locale fallback</Label>
                    <Input
                      id="assistantDefaultLocale"
                      value={anonSettings.assistantDefaultLocale ?? ''}
                      maxLength={35}
                      onChange={(event) =>
                        handleAssistantSettingChange(
                          'assistantDefaultLocale',
                          event.target.value.trim().length > 0 ? event.target.value : null,
                        )
                      }
                      placeholder="e.g. it-IT"
                    />
                  </div>
                </div>

                <div className="space-y-2">
                  <Label htmlFor="assistantRole" className="text-foreground">Assistant role</Label>
                  <Input
                    id="assistantRole"
                    value={anonSettings.assistantRole}
                    maxLength={200}
                    onChange={(event) => handleAssistantSettingChange('assistantRole', event.target.value)}
                    placeholder="e.g. Museum guide"
                  />
                </div>

                <div className="space-y-2">
                  <Label htmlFor="greetingInstruction" className="text-foreground">Greeting style</Label>
                  <Input
                    id="greetingInstruction"
                    value={anonSettings.greetingInstruction}
                    maxLength={200}
                    onChange={(event) => handleAssistantSettingChange('greetingInstruction', event.target.value)}
                    placeholder="e.g. Warm and concise"
                  />
                </div>

                <div className="flex flex-col gap-4 rounded bg-muted/50 p-3 sm:flex-row sm:items-start sm:justify-between">
                  <div className="min-w-0">
                    <Label htmlFor="proactiveGreetingEnabled" className="text-foreground">Proactive first greeting</Label>
                    <p className="text-sm text-muted-foreground mt-0.5">
                      When enabled, a brand-new chat can begin with an assistant-first greeting. Leave the identity fields blank if you prefer silent startup.
                    </p>
                    <p className="mt-2 text-xs text-muted-foreground">
                      Status: {anonSettings.assistantBootstrapActive ? 'active' : 'inactive until enough identity is configured'}
                    </p>
                  </div>
                  <Switch
                    id="proactiveGreetingEnabled"
                    checked={anonSettings.proactiveGreetingEnabled}
                    onCheckedChange={(checked) => handleAssistantSettingChange('proactiveGreetingEnabled', checked)}
                    disabled={isAnonSaving}
                  />
                </div>
              </div>
            ) : (
              <p className="text-sm text-muted-foreground">Failed to load assistant bootstrap settings.</p>
            )}
          </section>

          <section id="anonymous-chat" className="space-y-6 scroll-mt-24">
            <h2 className="text-sm font-medium text-foreground uppercase tracking-wide">Anonymous Chat Access</h2>
            {isAnonLoading ? (
              <div className="flex items-center justify-center py-4">
                <Spinner className="w-5 h-5" />
              </div>
            ) : anonSettings ? (
              <div className="rounded-lg border border-border bg-card p-4 space-y-4">
                <div className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
                  <div className="flex min-w-0 items-center gap-3">
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
                      <div className="flex flex-col gap-2 sm:flex-row sm:items-start">
                        <CopyValueField
                          value={anonSettings.anonymousChatUrl}
                          ariaLabel="Copy URL"
                          className="min-w-0 flex-1"
                          wrap
                        />
                        <Button asChild className="bg-blue-600 text-white hover:bg-blue-500 sm:self-start">
                          <a href={anonSettings.anonymousChatUrl} target="_blank" rel="noreferrer">
                            <ExternalLink className="w-4 h-4" />
                            Try the chat
                          </a>
                        </Button>
                      </div>
                      <p className="text-sm text-muted-foreground">
                        Share this link with anyone you want to give chat access to.
                      </p>
                      <div className="flex justify-end">
                        <Button variant="outline" onClick={handleAnonymousChatTokenRotate} disabled={isAnonSaving}>
                          {isAnonSaving ? <Spinner className="mr-2 h-4 w-4" /> : <RefreshCw className="mr-2 h-4 w-4" />}
                          Rotate public link
                        </Button>
                      </div>
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
          </section>

          <section id="website-embed" className="space-y-6 scroll-mt-24">
            <h2 className="text-sm font-medium text-foreground uppercase tracking-wide">Website Embed</h2>
            {isAnonLoading ? (
              <div className="flex items-center justify-center py-4">
                <Spinner className="w-5 h-5" />
              </div>
            ) : anonSettings ? (
              <div className="rounded-lg border border-border bg-card p-4 space-y-4">
                <div className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
                  <div className="flex min-w-0 items-center gap-3">
                    <div className="flex h-10 w-10 items-center justify-center rounded-full bg-primary/10">
                      <Globe className="h-5 w-5 text-primary" />
                    </div>
                    <div>
                      <Label htmlFor="websiteEmbedToggle" className="text-base font-medium text-foreground">
                        Hosted website widget
                      </Label>
                      <p className="text-sm text-muted-foreground mt-0.5">
                        Install a Radioso-owned launcher script that opens a hosted iframe assistant on approved sites.
                      </p>
                    </div>
                  </div>
                  <Switch
                    id="websiteEmbedToggle"
                    checked={anonSettings.websiteEmbedEnabled ?? false}
                    onCheckedChange={(checked) => handleAssistantSettingChange('websiteEmbedEnabled', checked)}
                    disabled={isAnonSaving}
                  />
                </div>

                <div className="grid gap-4 md:grid-cols-2">
                  <div className="space-y-2">
                    <Label htmlFor="websiteEmbedLauncherLabel" className="text-foreground">Launcher label</Label>
                    <Input
                      id="websiteEmbedLauncherLabel"
                      value={anonSettings.websiteEmbedLauncherLabel ?? 'Chat with us'}
                      maxLength={80}
                      onChange={(event) => handleAssistantSettingChange('websiteEmbedLauncherLabel', event.target.value)}
                      placeholder="Chat with us"
                    />
                  </div>

                  <div className="space-y-2">
                    <Label htmlFor="websiteEmbedLauncherPosition" className="text-foreground">Launcher position</Label>
                    <select
                      id="websiteEmbedLauncherPosition"
                      value={anonSettings.websiteEmbedLauncherPosition ?? 'bottom-right'}
                      onChange={(event) =>
                        handleAssistantSettingChange('websiteEmbedLauncherPosition', event.target.value as GeneralSettings['websiteEmbedLauncherPosition'])
                      }
                      className="flex h-10 w-full rounded-md border border-input bg-background px-3 py-2 text-sm text-foreground"
                    >
                      <option value="bottom-right">Bottom right</option>
                      <option value="bottom-left">Bottom left</option>
                    </select>
                  </div>
                </div>

                <div className="space-y-2 md:max-w-xs">
                  <Label htmlFor="websiteEmbedLauncherIcon" className="text-foreground">Launcher icon</Label>
                  <select
                    id="websiteEmbedLauncherIcon"
                    value={anonSettings.websiteEmbedLauncherIcon ?? 'chat'}
                    onChange={(event) =>
                      handleAssistantSettingChange('websiteEmbedLauncherIcon', event.target.value as GeneralSettings['websiteEmbedLauncherIcon'])
                    }
                    className="flex h-10 w-full rounded-md border border-input bg-background px-3 py-2 text-sm text-foreground"
                  >
                    <option value="chat">Chat bubble</option>
                    <option value="sparkles">Sparkles</option>
                    <option value="message">Message</option>
                  </select>
                </div>

                <div className="space-y-2">
                  <Label htmlFor="websiteEmbedAllowedOrigins" className="text-foreground">Approved origins</Label>
                  <Textarea
                    id="websiteEmbedAllowedOrigins"
                    value={websiteEmbedOrigins}
                    onChange={(event) => setWebsiteEmbedOrigins(event.target.value)}
                    placeholder={`https://example.com\nhttps://docs.example.com`}
                    className="min-h-[132px]"
                  />
                  <p className="text-sm text-muted-foreground">
                    Enter one website origin per line. Only these sites can launch the embedded assistant.
                  </p>
                </div>

                {anonSettings.websiteEmbedEnabled && websiteEmbedSnippet ? (
                  <div className="rounded bg-muted/50 p-3 space-y-3">
                    <div className="flex items-center gap-2 text-foreground">
                      <Code2 className="h-4 w-4" />
                      <Label className="text-foreground">Install snippet</Label>
                    </div>
                    <CopyValueField
                      value={websiteEmbedSnippet}
                      ariaLabel="Copy install snippet"
                      className="w-full"
                      wrap
                    />
                    <p className="text-sm text-muted-foreground">
                      Paste this script tag into the target website. The loader opens a Radioso-hosted iframe on approved domains only.
                    </p>
                    <p className="text-sm text-muted-foreground">
                      Optional script attributes can override locale, start the widget open, or use a custom collapsed avatar image or GIF.
                    </p>
                    {anonSettings.websiteEmbedScriptUrl ? (
                      <p className="text-xs text-muted-foreground">
                        Loader URL: <span className="font-mono">{anonSettings.websiteEmbedScriptUrl}</span>
                      </p>
                    ) : null}
                    <div className="flex justify-end">
                      <Button variant="outline" onClick={handleWebsiteEmbedTokenRotate} disabled={isAnonSaving}>
                        {isAnonSaving ? <Spinner className="mr-2 h-4 w-4" /> : <RefreshCw className="mr-2 h-4 w-4" />}
                        Rotate embed token
                      </Button>
                    </div>
                  </div>
                ) : null}

                <div className="flex justify-end">
                  <Button onClick={handleWebsiteEmbedSave} disabled={!hasWebsiteEmbedChanges || isAnonSaving}>
                    {isAnonSaving ? <Spinner className="mr-2 h-4 w-4" /> : <Save className="mr-2 h-4 w-4" />}
                    Save embed settings
                  </Button>
                </div>
              </div>
            ) : (
              <p className="text-sm text-muted-foreground">Failed to load website embed settings.</p>
            )}
          </section>

          <section className="space-y-4 rounded-md border border-destructive/50 p-4">
            <h2 className="text-sm font-medium text-destructive uppercase tracking-wide">Danger Zone</h2>
            <div className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
              <div className="min-w-0">
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
                    className="sm:self-start"
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
          </section>

      </div>
    </SettingsTabShell>
  )
}
