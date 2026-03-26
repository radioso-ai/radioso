'use client'

import { useEffect, useState, type ReactNode } from 'react'
import {
  Bot,
  ExternalLink,
  Key,
  MessageSquare,
  Plus,
  RefreshCw,
  Save,
  Search,
  Settings2,
  SlidersHorizontal,
  Trash2,
} from 'lucide-react'

import { ConnectorsTab } from '@/components/dashboard/connectors/connectors-tab'
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
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { Slider } from '@/components/ui/slider'
import { Spinner } from '@/components/ui/spinner'
import { Switch } from '@/components/ui/switch'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { Textarea } from '@/components/ui/textarea'
import { settingsApi, generalSettingsApi, workspaceApi, RetrievalSettings, IngestionSettings, GeneralSettings } from '@/lib/api'
import { useWorkspace } from '@/lib/workspace-context'

const chunkingStrategyOptions: Array<{
  value: IngestionSettings['chunkingStrategy']
  label: string
  description: string
}> = [
  {
    value: 'fixed_window',
    label: 'Fixed Window',
    description: 'Uses the current overlapping fixed-size chunking behavior.',
  },
  {
    value: 'structured_semantic',
    label: 'Structured Semantic',
    description:
      'Uses headings, paragraphs, lists, tables, code fences, and FAQ pairs before merging adjacent blocks by topic.',
  },
]

const metadataRuleOperatorLabels: Record<
  RetrievalSettings['metadataRules'][number]['operator'],
  { label: string; description: string }
> = {
  equals: {
    label: 'Equals',
    description: 'Match when the metadata value equals the rule value.',
  },
  not_equals: {
    label: 'Does Not Equal',
    description: 'Match when the metadata value is different from the rule value.',
  },
  contains: {
    label: 'Contains',
    description: 'Match when the metadata value contains the rule value.',
  },
  not_contains: {
    label: 'Does Not Contain',
    description: 'Match when the metadata value does not contain the rule value.',
  },
  lt: {
    label: 'Less Than',
    description: 'Match when the metadata value is less than the rule value.',
  },
  lte: {
    label: 'Less Than Or Equal',
    description: 'Match when the metadata value is less than or equal to the rule value.',
  },
  gt: {
    label: 'Greater Than',
    description: 'Match when the metadata value is greater than the rule value.',
  },
  gte: {
    label: 'Greater Than Or Equal',
    description: 'Match when the metadata value is greater than or equal to the rule value.',
  },
}

const metadataValueTypeLabels: Record<
  RetrievalSettings['metadataRules'][number]['valueType'],
  { label: string; description: string }
> = {
  string: {
    label: 'Text',
    description: 'Use text matching such as equals or contains.',
  },
  number: {
    label: 'Number',
    description: 'Use numeric comparisons such as less than or greater than.',
  },
  date: {
    label: 'Date',
    description: 'Use ISO dates like 2026-03-26 for date comparisons.',
  },
  boolean: {
    label: 'Boolean',
    description: 'Use true or false.',
  },
}

const metadataRuleEffectLabels: Record<
  RetrievalSettings['metadataRules'][number]['effect'],
  { label: string; description: string }
> = {
  boost: {
    label: 'Boost',
    description: 'Prefer matching results without excluding other candidates.',
  },
  filter: {
    label: 'Filter',
    description: 'Only keep results that match this rule.',
  },
}

const operatorOptionsForValueType = (
  valueType: RetrievalSettings['metadataRules'][number]['valueType']
): RetrievalSettings['metadataRules'][number]['operator'][] => {
  if (valueType === 'string') {
    return ['equals', 'not_equals', 'contains', 'not_contains']
  }
  if (valueType === 'boolean') {
    return ['equals', 'not_equals']
  }

  return ['equals', 'not_equals', 'lt', 'lte', 'gt', 'gte']
}

function SettingsCard({
  icon,
  title,
  description,
  children,
}: {
  icon: ReactNode
  title: string
  description: string
  children: ReactNode
}) {
  return (
    <div className="rounded-lg border border-border bg-card p-4 space-y-4">
      <div className="flex items-center gap-3">
        <div className="flex h-10 w-10 items-center justify-center rounded-full bg-primary/10">
          {icon}
        </div>
        <div>
          <h3 className="font-medium text-foreground">{title}</h3>
          <p className="text-sm text-muted-foreground">{description}</p>
        </div>
      </div>
      {children}
    </div>
  )
}

function GeneralTab() {
  const { activeWorkspaceId, activeWorkspace, workspaces, renameWorkspace, deleteWorkspace } = useWorkspace()

  // Workspace name editing
  const [workspaceName, setWorkspaceName] = useState(activeWorkspace?.name ?? '')
  const [isRenameSaving, setIsRenameSaving] = useState(false)
  const [renameError, setRenameError] = useState<string | null>(null)
  const hasNameChange = workspaceName.trim() !== (activeWorkspace?.name ?? '')

  // Workspace deletion
  const [deleteConfirmName, setDeleteConfirmName] = useState('')
  const [isDeleting, setIsDeleting] = useState(false)
  const [deleteDialogOpen, setDeleteDialogOpen] = useState(false)
  const isLastWorkspace = workspaces.length <= 1
  const deleteConfirmValid = deleteConfirmName === activeWorkspace?.name

  // API token
  const [token, setToken] = useState<string | null>(null)
  const [isTokenLoading, setIsTokenLoading] = useState(true)

  // Anonymous chat
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
    loadToken()
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

  const handleAnonRateLimitChange = async (value: number) => {
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
            <h2 className="text-sm font-medium text-foreground uppercase tracking-wide">
              Workspace
            </h2>

            <div className="space-y-3">
              <Label htmlFor="workspaceName" className="text-foreground">Workspace Name</Label>
              <div className="flex gap-2">
                <Input
                  id="workspaceName"
                  value={workspaceName}
                  onChange={(e) => {
                    setWorkspaceName(e.target.value)
                    setRenameError(null)
                  }}
                  maxLength={100}
                  className="flex-1"
                />
                <Button
                  size="sm"
                  onClick={handleRename}
                  disabled={!hasNameChange || isRenameSaving}
                >
                  {isRenameSaving ? <Spinner className="mr-2" /> : <Save className="w-4 h-4 mr-2" />}
                  Save
                </Button>
              </div>
              {renameError && (
                <p className="text-sm text-destructive">{renameError}</p>
              )}
            </div>
          </div>

          <div className="space-y-6">
            <h2 className="text-sm font-medium text-foreground uppercase tracking-wide">
              Developer API
            </h2>

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
            <h2 className="text-sm font-medium text-foreground uppercase tracking-wide">
              Anonymous Chat Access
            </h2>

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

                {anonSettings.anonymousChatEnabled && anonSettings.anonymousChatUrl && (
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
                          <a
                            href={anonSettings.anonymousChatUrl}
                            target="_blank"
                            rel="noreferrer"
                          >
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
                )}
              </div>
            ) : (
              <p className="text-sm text-muted-foreground">Failed to load anonymous chat settings.</p>
            )}
          </div>

          <div className="space-y-4 rounded-md border border-destructive/50 p-4">
            <h2 className="text-sm font-medium text-destructive uppercase tracking-wide">
              Danger Zone
            </h2>

            <div className="flex items-center justify-between gap-4">
              <div>
                <p className="text-sm font-medium text-foreground">Delete this workspace</p>
                <p className="text-sm text-muted-foreground">
                  Permanently delete this workspace and all its documents, chats, and settings. This action cannot be undone.
                </p>
              </div>

              <Dialog open={deleteDialogOpen} onOpenChange={(open) => {
                setDeleteDialogOpen(open)
                if (!open) {
                  setDeleteConfirmName('')
                  setIsDeleting(false)
                }
              }}>
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
                      onChange={(e) => setDeleteConfirmName(e.target.value)}
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

            {isLastWorkspace && (
              <p className="text-sm text-muted-foreground">
                You cannot delete your only workspace. Create another workspace first.
              </p>
            )}
          </div>
        </div>
      </div>
    </div>
  )
}

function IngestionSettingsPanel() {
  const [settings, setSettings] = useState<IngestionSettings | null>(null)
  const [isLoading, setIsLoading] = useState(true)
  const [isSaving, setIsSaving] = useState(false)
  const [isReprocessing, setIsReprocessing] = useState(false)
  const [hasChanges, setHasChanges] = useState(false)
  const [reprocessMessage, setReprocessMessage] = useState<string | null>(null)

  useEffect(() => {
    const loadSettings = async () => {
      try {
        const data = await settingsApi.getIngestionSettings()
        setSettings(data)
      } catch (error) {
        console.error('Failed to load ingestion settings:', error)
      } finally {
        setIsLoading(false)
      }
    }
    void loadSettings()
  }, [])

  const updateSetting = <K extends keyof IngestionSettings>(
    key: K,
    value: IngestionSettings[K]
  ) => {
    if (!settings) return
    setSettings({ ...settings, [key]: value })
    setHasChanges(true)
    setReprocessMessage(null)
  }

  const persistSettings = async (draft: IngestionSettings) => {
    const updated = await settingsApi.updateIngestionSettings(draft)
    setSettings(updated)
    setHasChanges(false)
    return updated
  }

  const handleSave = async () => {
    if (!settings) return
    setIsSaving(true)
    try {
      await persistSettings(settings)
    } catch (error) {
      console.error('Failed to save ingestion settings:', error)
    } finally {
      setIsSaving(false)
    }
  }

  const handleReprocess = async () => {
    if (!settings) return
    setIsReprocessing(true)
    setReprocessMessage(null)
    try {
      if (hasChanges) {
        setIsSaving(true)
        await persistSettings(settings)
      }

      const response = await settingsApi.reprocessWorkspaceIngestion()
      if (response.status === 'noop') {
        setReprocessMessage('No eligible documents were queued. Documents already queued or processing were skipped.')
      } else {
        setReprocessMessage(
          `Queued ${response.queuedDocumentCount} document${response.queuedDocumentCount === 1 ? '' : 's'} for reprocessing. Skipped ${response.skippedDocumentCount}.`
        )
      }
    } catch (error) {
      console.error('Failed to save or reprocess ingestion settings:', error)
      setReprocessMessage(hasChanges ? 'Failed to save settings before reprocessing.' : 'Failed to start workspace reprocessing.')
    } finally {
      setIsSaving(false)
      setIsReprocessing(false)
    }
  }

  if (isLoading) {
    return (
      <div className="flex items-center justify-center h-full">
        <Spinner className="w-6 h-6" />
      </div>
    )
  }

  if (!settings) {
    return (
      <div className="flex items-center justify-center h-full">
        <p className="text-muted-foreground">Failed to load ingestion settings</p>
      </div>
    )
  }

  return (
    <div className="flex flex-col h-full">
      <div className="border-b border-border px-6 py-4 flex items-center justify-between">
        <div>
          <h2 className="text-lg font-medium text-foreground">Ingestion Settings</h2>
          <p className="text-sm text-muted-foreground">Tune how documents are chunked before retrieval.</p>
        </div>
        <Button size="sm" onClick={handleSave} disabled={!hasChanges || isSaving}>
          {isSaving ? <Spinner className="mr-2" /> : <Save className="w-4 h-4 mr-2" />}
          Save Changes
        </Button>
      </div>

      <div className="flex-1 overflow-y-auto p-6">
        <div className="max-w-xl space-y-8">
          <SettingsCard
            icon={<Settings2 className="h-5 w-5 text-primary" />}
            title="Document Processing"
            description="Choose how new or updated documents are prepared for retrieval."
          >
            <div className="space-y-4">
              <div className="space-y-1">
                <Label htmlFor="chunkingStrategy" className="text-foreground">Chunking Strategy</Label>
                <p className="text-sm text-muted-foreground">
                  Choose how newly ingested or updated documents are split into retrieval chunks.
                </p>
              </div>
              <Select
                value={settings.chunkingStrategy}
                onValueChange={(value) =>
                  updateSetting('chunkingStrategy', value as IngestionSettings['chunkingStrategy'])
                }
              >
                <SelectTrigger id="chunkingStrategy" className="w-full">
                  <SelectValue placeholder="Select a chunking strategy" />
                </SelectTrigger>
                <SelectContent>
                  {chunkingStrategyOptions.map((option) => (
                    <SelectItem key={option.value} value={option.value}>
                      {option.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <div className="space-y-2 rounded-md border border-border bg-muted/20 p-3">
                {chunkingStrategyOptions
                  .filter((option) => option.value === settings.chunkingStrategy)
                  .map((option) => (
                    <div key={option.value}>
                      <p className="text-sm font-medium text-foreground">{option.label}</p>
                      <p className="text-sm text-muted-foreground">{option.description}</p>
                    </div>
                  ))}
              </div>
              <p className="text-sm text-muted-foreground">
                Changes apply to future ingests and document updates immediately. Existing stored chunks stay as they are until you reprocess those documents.
              </p>
              <div className="space-y-4 rounded-md border border-border bg-muted/20 p-4">
                <div className="flex items-center gap-2">
                  {settings.chunkingStrategy === 'fixed_window' ? (
                    <SlidersHorizontal className="h-4 w-4 text-primary" />
                  ) : (
                    <Search className="h-4 w-4 text-primary" />
                  )}
                  <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
                    {settings.chunkingStrategy === 'fixed_window' ? 'Fixed Window Tuning' : 'Structured Semantic Tuning'}
                  </p>
                </div>

                {settings.chunkingStrategy === 'fixed_window' ? (
                  <>
                    <div className="space-y-3">
                      <div className="flex items-center justify-between">
                        <Label htmlFor="fixedWindowChunkSize" className="text-foreground">Chunk Size</Label>
                        <span className="text-sm text-muted-foreground font-mono">
                          {settings.fixedWindowChunkSize}
                        </span>
                      </div>
                      <Slider
                        id="fixedWindowChunkSize"
                        min={100}
                        max={4000}
                        step={10}
                        value={[settings.fixedWindowChunkSize]}
                        onValueChange={([value]) => updateSetting('fixedWindowChunkSize', value)}
                      />
                      <p className="text-sm text-muted-foreground">
                        Larger chunks keep more context together. Smaller chunks create more retrieval units.
                      </p>
                    </div>

                    <div className="space-y-3">
                      <div className="flex items-center justify-between">
                        <Label htmlFor="fixedWindowChunkOverlap" className="text-foreground">Chunk Overlap</Label>
                        <span className="text-sm text-muted-foreground font-mono">
                          {settings.fixedWindowChunkOverlap}
                        </span>
                      </div>
                      <Slider
                        id="fixedWindowChunkOverlap"
                        min={0}
                        max={2000}
                        step={10}
                        value={[Math.min(settings.fixedWindowChunkOverlap, 2000)]}
                        onValueChange={([value]) => updateSetting('fixedWindowChunkOverlap', value)}
                      />
                      <p className="text-sm text-muted-foreground">
                        Overlap helps adjacent chunks share context. It must stay smaller than the chunk size.
                      </p>
                    </div>
                  </>
                ) : (
                  <>
                    <div className="space-y-3">
                      <div className="flex items-center justify-between">
                        <Label htmlFor="structuredMinChunkSize" className="text-foreground">Minimum Chunk Size</Label>
                        <span className="text-sm text-muted-foreground font-mono">
                          {settings.structuredMinChunkSize}
                        </span>
                      </div>
                      <Slider
                        id="structuredMinChunkSize"
                        min={1}
                        max={1000}
                        step={1}
                        value={[Math.min(settings.structuredMinChunkSize, 1000)]}
                        onValueChange={([value]) => updateSetting('structuredMinChunkSize', value)}
                      />
                      <p className="text-sm text-muted-foreground">
                        Small structural fragments can be merged until they reach at least this target.
                      </p>
                    </div>

                    <div className="space-y-3">
                      <div className="flex items-center justify-between">
                        <Label htmlFor="structuredMaxChunkSize" className="text-foreground">Maximum Chunk Size</Label>
                        <span className="text-sm text-muted-foreground font-mono">
                          {settings.structuredMaxChunkSize}
                        </span>
                      </div>
                      <Slider
                        id="structuredMaxChunkSize"
                        min={1}
                        max={2000}
                        step={1}
                        value={[Math.min(settings.structuredMaxChunkSize, 2000)]}
                        onValueChange={([value]) => updateSetting('structuredMaxChunkSize', value)}
                      />
                      <p className="text-sm text-muted-foreground">
                        Structure-aware chunks stop growing when they hit this upper bound.
                      </p>
                    </div>
                  </>
                )}
              </div>
            </div>
          </SettingsCard>

          <SettingsCard
            icon={<RefreshCw className="h-5 w-5 text-primary" />}
            title="Existing Documents"
            description="Reprocess current documents so they use the latest ingestion settings."
          >
            <div className="space-y-4">
              <p className="text-sm text-muted-foreground">
                Saving settings does not rewrite existing chunks. Use this action when you want current documents to be re-queued with the latest ingestion configuration.
              </p>
              <div className="flex items-center gap-3">
                <Button onClick={handleReprocess} disabled={isReprocessing || isSaving}>
                  {isReprocessing || isSaving ? <Spinner className="mr-2" /> : <RefreshCw className="w-4 h-4 mr-2" />}
                  Reprocess Existing Documents
                </Button>
                {reprocessMessage ? (
                  <p className="text-sm text-muted-foreground">{reprocessMessage}</p>
                ) : null}
              </div>
            </div>
          </SettingsCard>
        </div>
      </div>
    </div>
  )
}

function RetrievalSettingsPanel() {
  const [settings, setSettings] = useState<RetrievalSettings | null>(null)
  const [isLoading, setIsLoading] = useState(true)
  const [isSaving, setIsSaving] = useState(false)
  const [hasChanges, setHasChanges] = useState(false)

  useEffect(() => {
    const loadSettings = async () => {
      try {
        const data = await settingsApi.getRetrievalSettings()
        setSettings(data)
      } catch (error) {
        console.error('Failed to load settings:', error)
      } finally {
        setIsLoading(false)
      }
    }
    void loadSettings()
  }, [])

  const updateSetting = <K extends keyof RetrievalSettings>(
    key: K,
    value: RetrievalSettings[K]
  ) => {
    if (!settings) return
    setSettings({ ...settings, [key]: value })
    setHasChanges(true)
  }

  const updateMetadataRule = (
    ruleId: RetrievalSettings['metadataRules'][number]['id'],
    updates: Partial<RetrievalSettings['metadataRules'][number]>
  ) => {
    if (!settings) return

    setSettings({
      ...settings,
      metadataRules: settings.metadataRules.map((rule) =>
        rule.id === ruleId ? { ...rule, ...updates } : rule
      ),
    })
    setHasChanges(true)
  }

  const applyMetadataField = (
    ruleId: RetrievalSettings['metadataRules'][number]['id'],
    field: string
  ) => {
    if (!settings) return

    const suggestion = settings.metadataFieldSuggestions.find((candidate) => candidate.field === field)
    const valueType = suggestion?.inferredType
    const currentRule = settings.metadataRules.find((rule) => rule.id === ruleId)
    const nextValueType = valueType ?? currentRule?.valueType ?? 'string'
    const allowedOperators = operatorOptionsForValueType(nextValueType)

    updateMetadataRule(ruleId, {
      field,
      ...(valueType ? { valueType } : {}),
      ...(currentRule && !allowedOperators.includes(currentRule.operator)
        ? { operator: allowedOperators[0] }
        : {}),
    })
  }

  const applyMetadataValueType = (
    ruleId: RetrievalSettings['metadataRules'][number]['id'],
    valueType: RetrievalSettings['metadataRules'][number]['valueType']
  ) => {
    if (!settings) return

    const currentRule = settings.metadataRules.find((rule) => rule.id === ruleId)
    const allowedOperators = operatorOptionsForValueType(valueType)

    updateMetadataRule(ruleId, {
      valueType,
      ...(currentRule && !allowedOperators.includes(currentRule.operator)
        ? { operator: allowedOperators[0] }
        : {}),
      ...(valueType === 'boolean' && currentRule?.value !== 'true' && currentRule?.value !== 'false'
        ? { value: 'true' }
        : {}),
    })
  }

  const addMetadataRule = () => {
    if (!settings) return

    const suggestedField = settings.metadataFieldSuggestions[0]
    setSettings({
      ...settings,
      metadataRules: [
        ...settings.metadataRules,
        {
          id: globalThis.crypto?.randomUUID?.() ?? `rule-${Date.now()}`,
          field: suggestedField?.field ?? '',
          valueType: suggestedField?.inferredType ?? 'string',
          operator: 'equals',
          value: suggestedField?.inferredType === 'boolean' ? 'true' : '',
          effect: 'boost',
          enabled: true,
        },
      ],
    })
    setHasChanges(true)
  }

  const removeMetadataRule = (ruleId: string) => {
    if (!settings) return

    setSettings({
      ...settings,
      metadataRules: settings.metadataRules.filter((rule) => rule.id !== ruleId),
    })
    setHasChanges(true)
  }

  const handleSave = async () => {
    if (!settings) return
    setIsSaving(true)
    try {
      await settingsApi.updateRetrievalSettings(settings)
      setHasChanges(false)
    } catch (error) {
      console.error('Failed to save settings:', error)
    } finally {
      setIsSaving(false)
    }
  }

  if (isLoading) {
    return (
      <div className="flex items-center justify-center h-full">
        <Spinner className="w-6 h-6" />
      </div>
    )
  }

  if (!settings) {
    return (
      <div className="flex items-center justify-center h-full">
        <p className="text-muted-foreground">Failed to load settings</p>
      </div>
    )
  }

  return (
    <div className="flex flex-col h-full">
      <div className="border-b border-border px-6 py-4 flex items-center justify-between">
        <div>
          <h2 className="text-lg font-medium text-foreground">Retrieval Settings</h2>
          <p className="text-sm text-muted-foreground">Tune retrieval and response behavior</p>
        </div>
        <Button size="sm" onClick={handleSave} disabled={!hasChanges || isSaving}>
          {isSaving ? <Spinner className="mr-2" /> : <Save className="w-4 h-4 mr-2" />}
          Save Changes
        </Button>
      </div>

      <div className="flex-1 overflow-y-auto p-6">
        <div className="max-w-xl space-y-8">
          <SettingsCard
            icon={<Bot className="h-5 w-5 text-primary" />}
            title="Assistant"
            description="Control how grounded answers are presented to the user."
          >
            <div className="space-y-4">
              <div className="space-y-3">
                <div className="flex items-center justify-between">
                  <Label htmlFor="warmthLevel" className="text-foreground">Warmth</Label>
                  <span className="text-sm text-muted-foreground font-mono">
                    {settings.warmthLevel}
                  </span>
                </div>
                <Slider
                  id="warmthLevel"
                  min={1}
                  max={10}
                  step={1}
                  value={[settings.warmthLevel]}
                  onValueChange={([value]) => updateSetting('warmthLevel', value)}
                />
                <div className="flex items-center justify-between text-xs text-muted-foreground">
                  <span>Terse</span>
                  <span>Very warm</span>
                </div>
                <p className="text-sm text-muted-foreground">
                  Controls how concise or warm the assistant sounds without changing the underlying answer.
                </p>
              </div>

              <div className="flex items-center justify-between rounded-md border border-border bg-muted/20 p-3">
                <div>
                  <Label htmlFor="citationDisplay" className="text-foreground">Show Citations</Label>
                  <p className="text-sm text-muted-foreground mt-0.5">
                    Show inline source markers when supporting evidence is available.
                  </p>
                </div>
                <Switch
                  id="citationDisplay"
                  checked={settings.citationDisplayEnabled}
                  onCheckedChange={(checked) => updateSetting('citationDisplayEnabled', checked)}
                />
              </div>

              <div className="space-y-3">
                <div className="space-y-1">
                  <Label htmlFor="customInstruction" className="text-foreground">Custom Instruction</Label>
                  <p className="text-sm text-muted-foreground">
                    Give the assistant workspace-specific instructions. For example: &quot;Always cite the paragraph number when referencing legal provisions&quot; or &quot;Include a direct URL instead of saying visit their website.&quot;
                  </p>
                </div>
                <Textarea
                  id="customInstruction"
                  value={settings.customInstruction}
                  onChange={(e) => updateSetting('customInstruction', e.target.value.slice(0, 2000))}
                  placeholder="e.g. Always cite the specific section of the Act when referencing legal provisions."
                  rows={4}
                />
                <p className="text-xs text-muted-foreground text-right">
                  {settings.customInstruction.length} / 2000
                </p>
              </div>

              <p className="text-sm text-muted-foreground">
                The assistant may still ask a clarification question when your request is missing information needed for a reliable answer.
              </p>
            </div>
          </SettingsCard>

          <SettingsCard
            icon={<Search className="h-5 w-5 text-primary" />}
            title="Retrieval Pipeline"
            description="Control how the system expands, filters, and reranks evidence."
          >
            <div className="space-y-4">
              <div className="flex items-center justify-between rounded-md border border-border bg-muted/20 p-3">
                <div>
                  <Label htmlFor="queryRewrite" className="text-foreground">Query Rewrite</Label>
                  <p className="text-sm text-muted-foreground mt-0.5">
                    Automatically optimize queries for better retrieval.
                  </p>
                </div>
                <Switch
                  id="queryRewrite"
                  checked={settings.queryRewriteEnabled}
                  onCheckedChange={(checked) => updateSetting('queryRewriteEnabled', checked)}
                />
              </div>

              <div className="flex items-center justify-between rounded-md border border-border bg-muted/20 p-3">
                <div>
                  <Label htmlFor="rerank" className="text-foreground">Reranking</Label>
                  <p className="text-sm text-muted-foreground mt-0.5">
                    Use a reranker to improve result relevance.
                  </p>
                </div>
                <Switch
                  id="rerank"
                  checked={settings.rerankEnabled}
                  onCheckedChange={(checked) => updateSetting('rerankEnabled', checked)}
                />
              </div>

              <div className="space-y-4 rounded-md border border-border bg-muted/20 p-4">
                <div className="space-y-2">
                  <div className="flex items-center justify-between gap-4">
                    <div className="space-y-1">
                      <Label className="text-foreground">Metadata Rules</Label>
                      <p className="text-sm text-muted-foreground">
                        Create always-on rules that boost or filter results by document metadata.
                      </p>
                    </div>
                    <Button type="button" variant="outline" size="sm" onClick={addMetadataRule}>
                      <Plus className="mr-2 h-4 w-4" />
                      Add Rule
                    </Button>
                  </div>
                  <p className="text-sm text-muted-foreground">
                    Suggested keys from this workspace:{" "}
                    {settings.metadataFieldSuggestions.length > 0
                      ? settings.metadataFieldSuggestions.map((field) => `${field.field} (${field.inferredType})`).join(', ')
                      : 'none discovered yet'}
                  </p>
                </div>

                {settings.metadataRules.length === 0 ? (
                  <div className="rounded-md border border-dashed border-border bg-card p-4 text-sm text-muted-foreground">
                    No metadata rules yet. Add a rule to always boost or filter results using a metadata key.
                  </div>
                ) : (
                  <div className="space-y-3">
                    {settings.metadataRules.map((rule) => (
                      <div key={rule.id} className="space-y-3 rounded-md border border-border bg-card p-4">
                        <div className="flex items-start justify-between gap-3">
                          <div className="grid flex-1 gap-3 md:grid-cols-2">
                            <div className="space-y-2">
                              <Label className="text-foreground">Metadata Key</Label>
                              <Input
                                value={rule.field}
                                onChange={(e) => applyMetadataField(rule.id, e.target.value)}
                                placeholder="e.g. language or parsedData.url"
                                list="metadata-field-suggestions"
                              />
                            </div>
                            <div className="space-y-2">
                              <Label className="text-foreground">Value Type</Label>
                              <Select
                                value={rule.valueType}
                                onValueChange={(value) =>
                                  applyMetadataValueType(
                                    rule.id,
                                    value as RetrievalSettings['metadataRules'][number]['valueType']
                                  )
                                }
                              >
                                <SelectTrigger className="w-full">
                                  <SelectValue />
                                </SelectTrigger>
                                <SelectContent>
                                  {Object.entries(metadataValueTypeLabels).map(([value, meta]) => (
                                    <SelectItem key={value} value={value}>
                                      {meta.label}
                                    </SelectItem>
                                  ))}
                                </SelectContent>
                              </Select>
                              <p className="text-sm text-muted-foreground">
                                {metadataValueTypeLabels[rule.valueType].description}
                              </p>
                            </div>
                            <div className="space-y-2">
                              <Label className="text-foreground">Value</Label>
                              {rule.valueType === 'boolean' ? (
                                <Select
                                  value={rule.value === 'false' ? 'false' : 'true'}
                                  onValueChange={(value) => updateMetadataRule(rule.id, { value })}
                                >
                                  <SelectTrigger className="w-full">
                                    <SelectValue />
                                  </SelectTrigger>
                                  <SelectContent>
                                    <SelectItem value="true">True</SelectItem>
                                    <SelectItem value="false">False</SelectItem>
                                  </SelectContent>
                                </Select>
                              ) : (
                                <Input
                                  type={rule.valueType === 'date' ? 'date' : rule.valueType === 'number' ? 'number' : 'text'}
                                  value={rule.value}
                                  onChange={(e) => updateMetadataRule(rule.id, { value: e.target.value })}
                                  placeholder={
                                    rule.valueType === 'date'
                                      ? '2026-03-26'
                                      : rule.valueType === 'number'
                                        ? '100'
                                        : 'e.g. et or example.com'
                                  }
                                />
                              )}
                            </div>
                            <div className="space-y-2">
                              <Label className="text-foreground">Operator</Label>
                              <Select
                                value={rule.operator}
                                onValueChange={(value) =>
                                  updateMetadataRule(rule.id, {
                                    operator: value as RetrievalSettings['metadataRules'][number]['operator'],
                                  })
                                }
                              >
                                <SelectTrigger className="w-full">
                                  <SelectValue />
                                </SelectTrigger>
                                <SelectContent>
                                  {operatorOptionsForValueType(rule.valueType).map((value) => (
                                    <SelectItem key={value} value={value}>
                                      {metadataRuleOperatorLabels[value].label}
                                    </SelectItem>
                                  ))}
                                </SelectContent>
                              </Select>
                              <p className="text-sm text-muted-foreground">
                                {metadataRuleOperatorLabels[rule.operator].description}
                              </p>
                            </div>
                            <div className="space-y-2">
                              <Label className="text-foreground">Effect</Label>
                              <Select
                                value={rule.effect}
                                onValueChange={(value) =>
                                  updateMetadataRule(rule.id, {
                                    effect: value as RetrievalSettings['metadataRules'][number]['effect'],
                                  })
                                }
                              >
                                <SelectTrigger className="w-full">
                                  <SelectValue />
                                </SelectTrigger>
                                <SelectContent>
                                  {Object.entries(metadataRuleEffectLabels).map(([value, meta]) => (
                                    <SelectItem key={value} value={value}>
                                      {meta.label}
                                    </SelectItem>
                                  ))}
                                </SelectContent>
                              </Select>
                              <p className="text-sm text-muted-foreground">
                                {metadataRuleEffectLabels[rule.effect].description}
                              </p>
                            </div>
                          </div>
                          <div className="flex items-center gap-2">
                            <Switch
                              checked={rule.enabled}
                              onCheckedChange={(checked) => updateMetadataRule(rule.id, { enabled: checked })}
                            />
                            <Button type="button" variant="ghost" size="icon" onClick={() => removeMetadataRule(rule.id)}>
                              <Trash2 className="h-4 w-4" />
                            </Button>
                          </div>
                        </div>
                      </div>
                    ))}
                  </div>
                )}

                <datalist id="metadata-field-suggestions">
                  {settings.metadataFieldSuggestions.map((field) => (
                    <option key={field.field} value={field.field} />
                  ))}
                </datalist>
              </div>
            </div>
          </SettingsCard>

          <SettingsCard
            icon={<SlidersHorizontal className="h-5 w-5 text-primary" />}
            title="Search Tuning"
            description="Adjust lower-level retrieval thresholds and candidate counts."
          >
            <div className="space-y-4 rounded-md border border-border bg-muted/20 p-4">
              <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
                Advanced
              </p>

              <div className="space-y-3">
                <div className="flex items-center justify-between">
                  <Label htmlFor="vectorTopK" className="text-foreground">Vector Top K</Label>
                  <span className="text-sm text-muted-foreground font-mono">
                    {settings.vectorTopK}
                  </span>
                </div>
                <Slider
                  id="vectorTopK"
                  min={1}
                  max={300}
                  step={1}
                  value={[settings.vectorTopK]}
                  onValueChange={([value]) => updateSetting('vectorTopK', value)}
                />
                <p className="text-sm text-muted-foreground">
                  Number of chunks to retrieve from vector search.
                </p>
              </div>

              <div className="space-y-3">
                <div className="flex items-center justify-between">
                  <Label htmlFor="similarity" className="text-foreground">Similarity Threshold</Label>
                  <span className="text-sm text-muted-foreground font-mono">
                    {settings.similarityThreshold.toFixed(2)}
                  </span>
                </div>
                <Slider
                  id="similarity"
                  min={0}
                  max={1}
                  step={0.01}
                  value={[settings.similarityThreshold]}
                  onValueChange={([value]) => updateSetting('similarityThreshold', value)}
                />
                <p className="text-sm text-muted-foreground">
                  Minimum similarity score for retrieved chunks.
                </p>
              </div>

              <div className="space-y-3">
                <div className="flex items-center justify-between">
                  <Label htmlFor="rerankTopK" className="text-foreground">Rerank Top K</Label>
                  <span className="text-sm text-muted-foreground font-mono">
                    {settings.rerankTopK}
                  </span>
                </div>
                <Slider
                  id="rerankTopK"
                  min={1}
                  max={50}
                  step={1}
                  value={[settings.rerankTopK]}
                  onValueChange={([value]) => updateSetting('rerankTopK', value)}
                />
                <p className="text-sm text-muted-foreground">
                  Number of chunks to keep after reranking.
                </p>
              </div>
            </div>
          </SettingsCard>
        </div>
      </div>
    </div>
  )
}

export function SettingsView() {
  return (
    <div className="flex h-full flex-col">
      <div className="border-b border-border px-6 py-4">
        <h1 className="text-lg font-medium text-foreground">Settings</h1>
        <p className="text-sm text-muted-foreground">
          Configure workspace, ingestion, retrieval, and external chat channel behavior.
        </p>
      </div>

      <Tabs defaultValue="general" className="flex flex-1 flex-col">
        <div className="border-b border-border px-6 py-3">
          <TabsList>
            <TabsTrigger value="general">General</TabsTrigger>
            <TabsTrigger value="ingestion">Ingestion</TabsTrigger>
            <TabsTrigger value="retrieval">Retrieval</TabsTrigger>
            <TabsTrigger value="connectors">Chat Connectors</TabsTrigger>
          </TabsList>
        </div>

        <TabsContent value="general" className="flex-1 overflow-hidden">
          <GeneralTab />
        </TabsContent>

        <TabsContent value="ingestion" className="flex-1 overflow-hidden">
          <IngestionSettingsPanel />
        </TabsContent>

        <TabsContent value="retrieval" className="flex-1 overflow-hidden">
          <RetrievalSettingsPanel />
        </TabsContent>

        <TabsContent value="connectors" className="flex-1 overflow-y-auto p-6">
          <div className="mb-6 max-w-3xl">
            <h2 className="text-lg font-medium text-foreground">Chat Connectors</h2>
            <p className="mt-1 text-sm text-muted-foreground">
              Connect external messaging channels to this workspace. Connector config is
              schema-driven, so new connector types appear here automatically once the backend
              registers them.
            </p>
          </div>
          <ConnectorsTab />
        </TabsContent>
      </Tabs>
    </div>
  )
}
