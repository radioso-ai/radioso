'use client'

import { useEffect, useState } from 'react'
import { Check, Copy, ExternalLink, Key, Save, Trash2 } from 'lucide-react'

import { ConnectorsTab } from '@/components/dashboard/connectors/connectors-tab'
import { Button } from '@/components/ui/button'
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
import { settingsApi, generalSettingsApi, workspaceApi, RetrievalSettings, GeneralSettings } from '@/lib/api'
import { useWorkspace } from '@/lib/workspace-context'

const chunkingStrategyOptions: Array<{
  value: RetrievalSettings['chunkingStrategy']
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

const attributeFamilyOptions: Array<{
  family: RetrievalSettings['attributeControls'][number]['family']
  label: string
  description: string
}> = [
  {
    family: 'date_point',
    label: 'Single Dates',
    description: 'Use exact dates such as deadlines, departures, or scheduled days.',
  },
  {
    family: 'date_range',
    label: 'Date Ranges',
    description: 'Use spans such as retreat windows, event ranges, or booking periods.',
  },
  {
    family: 'money_value',
    label: 'Prices',
    description: 'Use monetary values such as prices, fees, or budget thresholds.',
  },
  {
    family: 'location',
    label: 'Locations',
    description: 'Use place names such as cities, countries, or venue references.',
  },
]

const attributeModeLabels: Record<
  RetrievalSettings['attributeControls'][number]['mode'],
  { label: string; description: string }
> = {
  boost_only: {
    label: 'Boost Only',
    description: 'Prefer matching results without strictly excluding other candidates.',
  },
  hard_filter: {
    label: 'Hard Filter Eligible',
    description: 'Allow high-confidence matches to narrow results when the query is precise enough.',
  },
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
  const [copied, setCopied] = useState(false)

  // Anonymous chat
  const [anonSettings, setAnonSettings] = useState<GeneralSettings | null>(null)
  const [isAnonLoading, setIsAnonLoading] = useState(true)
  const [isAnonSaving, setIsAnonSaving] = useState(false)
  const [anonUrlCopied, setAnonUrlCopied] = useState(false)

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

  const handleCopy = async () => {
    if (!token) return
    await navigator.clipboard.writeText(token)
    setCopied(true)
    setTimeout(() => setCopied(false), 2000)
  }

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

  const handleAnonUrlCopy = async () => {
    if (!anonSettings?.anonymousChatUrl) return
    await navigator.clipboard.writeText(anonSettings.anonymousChatUrl)
    setAnonUrlCopied(true)
    setTimeout(() => setAnonUrlCopied(false), 2000)
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
              API Token
            </h2>

            {isTokenLoading ? (
              <div className="flex items-center justify-center py-4">
                <Spinner className="w-5 h-5" />
              </div>
            ) : (
              <>
                <div className="p-4 bg-card border border-border rounded-lg space-y-4">
                  <div className="flex items-center gap-3">
                    <div className="w-10 h-10 rounded-full bg-primary/10 flex items-center justify-center">
                      <Key className="w-5 h-5 text-primary" />
                    </div>
                    <div>
                      <h3 className="font-medium text-foreground">API Key</h3>
                      <p className="text-sm text-muted-foreground">Use this key to authenticate API requests</p>
                    </div>
                  </div>

                  <div className="space-y-2">
                    <Label htmlFor="token" className="sr-only">API Token</Label>
                    <div className="flex gap-2">
                      <Input
                        id="token"
                        value={token || ''}
                        readOnly
                        className="font-mono text-sm"
                      />
                      <Button
                        variant="outline"
                        size="icon"
                        onClick={handleCopy}
                        disabled={!token}
                      >
                        {copied ? (
                          <Check className="w-4 h-4 text-green-500" />
                        ) : (
                          <Copy className="w-4 h-4" />
                        )}
                        <span className="sr-only">Copy token</span>
                      </Button>
                    </div>
                  </div>

                  <div className="rounded bg-muted/50 p-3 space-y-2">
                    <p className="text-sm text-muted-foreground">
                      Include this token in the Authorization header of your API requests:
                    </p>
                    <code className="block p-2 bg-card border border-border rounded text-sm font-mono text-foreground overflow-x-auto">
                      Authorization: Bearer {token?.slice(0, 15)}...
                    </code>
                  </div>
                </div>
              </>
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
              <div className="space-y-4">
                <div className="flex items-center justify-between">
                  <div>
                    <Label htmlFor="anonChatToggle" className="text-foreground">Enable Anonymous Chat</Label>
                    <p className="text-sm text-muted-foreground mt-0.5">
                      Allow unauthenticated users to chat via a public link.
                    </p>
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
                        <p
                          id="anonChatUrl"
                          className="min-w-[320px] flex-1 break-all rounded-md border border-border bg-card px-3 py-2 font-mono text-sm text-foreground"
                        >
                          {anonSettings.anonymousChatUrl}
                        </p>
                        <Button asChild variant="secondary">
                          <a
                            href={anonSettings.anonymousChatUrl}
                            target="_blank"
                            rel="noreferrer"
                          >
                            <ExternalLink className="w-4 h-4" />
                            Try the chat
                          </a>
                        </Button>
                        <Button
                          variant="outline"
                          size="icon"
                          onClick={handleAnonUrlCopy}
                        >
                          {anonUrlCopied ? (
                            <Check className="w-4 h-4 text-green-500" />
                          ) : (
                            <Copy className="w-4 h-4" />
                          )}
                          <span className="sr-only">Copy URL</span>
                        </Button>
                      </div>
                      <p className="text-sm text-muted-foreground">
                        Share this link with anyone you want to give chat access to.
                      </p>
                    </div>

                    <div className="space-y-3">
                      <div className="flex items-center justify-between">
                        <Label htmlFor="anonRateLimit" className="text-foreground">Rate Limit</Label>
                        <span className="text-sm text-muted-foreground font-mono">
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

  const updateAttributeControl = (
    family: RetrievalSettings['attributeControls'][number]['family'],
    updates: Partial<RetrievalSettings['attributeControls'][number]>
  ) => {
    if (!settings) return

    setSettings({
      ...settings,
      attributeControls: settings.attributeControls.map((control) =>
        control.family === family ? { ...control, ...updates } : control
      ),
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
          <div className="space-y-6">
            <h2 className="text-sm font-medium text-foreground uppercase tracking-wide">
              Response Style
            </h2>

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

            <div className="flex items-center justify-between">
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
                  Give the assistant specific instructions for this workspace. For example: &quot;Always cite the paragraph number when referencing legal provisions&quot; or &quot;Include a direct URL instead of saying visit their website.&quot;
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

          <div className="space-y-6">
            <h2 className="text-sm font-medium text-foreground uppercase tracking-wide">
              Retrieval Options
            </h2>

            <div className="space-y-3">
              <div className="space-y-1">
                <Label htmlFor="chunkingStrategy" className="text-foreground">Chunking Strategy</Label>
                <p className="text-sm text-muted-foreground">
                  Choose how newly ingested or updated documents are split into retrieval chunks.
                </p>
              </div>
              <Select
                value={settings.chunkingStrategy}
                onValueChange={(value) =>
                  updateSetting('chunkingStrategy', value as RetrievalSettings['chunkingStrategy'])
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
                {chunkingStrategyOptions.map((option) => (
                  <div key={option.value}>
                    <p className="text-sm font-medium text-foreground">{option.label}</p>
                    <p className="text-sm text-muted-foreground">{option.description}</p>
                  </div>
                ))}
              </div>
              <p className="text-sm text-muted-foreground">
                Changes apply the next time you ingest or update a document. Existing stored chunks stay as they are.
              </p>
            </div>

            <div className="flex items-center justify-between">
              <div>
                <Label htmlFor="queryRewrite" className="text-foreground">Query Rewrite</Label>
                <p className="text-sm text-muted-foreground mt-0.5">
                  Automatically optimize queries for better retrieval
                </p>
              </div>
              <Switch
                id="queryRewrite"
                checked={settings.queryRewriteEnabled}
                onCheckedChange={(checked) => updateSetting('queryRewriteEnabled', checked)}
              />
            </div>

            <div className="flex items-center justify-between">
              <div>
                <Label htmlFor="rerank" className="text-foreground">Reranking</Label>
                <p className="text-sm text-muted-foreground mt-0.5">
                  Use a reranker to improve result relevance
                </p>
              </div>
              <Switch
                id="rerank"
                checked={settings.rerankEnabled}
                onCheckedChange={(checked) => updateSetting('rerankEnabled', checked)}
              />
            </div>

            <div className="space-y-4">
              <div className="space-y-1">
                <Label className="text-foreground">Structured Attributes</Label>
                <p className="text-sm text-muted-foreground">
                  These are system-defined retrieval helpers, not custom fields. Enable the families
                  you want the retriever to consider, and choose whether each one should only boost
                  matches or may act as a high-confidence hard filter.
                </p>
              </div>

              <div className="space-y-3">
                {attributeFamilyOptions.map((option) => {
                  const control = settings.attributeControls.find(
                    (candidate) => candidate.family === option.family
                  )

                  if (!control) {
                    return null
                  }

                  return (
                    <div
                      key={option.family}
                      className="space-y-3 rounded-md border border-border bg-muted/20 p-4"
                    >
                      <div className="flex items-start justify-between gap-4">
                        <div className="space-y-1">
                          <p className="text-sm font-medium text-foreground">{option.label}</p>
                          <p className="text-sm text-muted-foreground">{option.description}</p>
                        </div>
                        <Switch
                          checked={control.enabled}
                          onCheckedChange={(checked) =>
                            updateAttributeControl(option.family, { enabled: checked })
                          }
                        />
                      </div>

                      <div className="space-y-2">
                        <Label className="text-foreground">Retrieval behavior</Label>
                        <Select
                          value={control.mode}
                          onValueChange={(value) =>
                            updateAttributeControl(option.family, {
                              mode: value as RetrievalSettings['attributeControls'][number]['mode'],
                            })
                          }
                          disabled={!control.enabled}
                        >
                          <SelectTrigger className="w-full">
                            <SelectValue placeholder="Select retrieval behavior" />
                          </SelectTrigger>
                          <SelectContent>
                            {Object.entries(attributeModeLabels).map(([value, meta]) => (
                              <SelectItem key={value} value={value}>
                                {meta.label}
                              </SelectItem>
                            ))}
                          </SelectContent>
                        </Select>
                        <p className="text-sm text-muted-foreground">
                          {attributeModeLabels[control.mode].description}
                        </p>
                      </div>
                    </div>
                  )
                })}
              </div>
            </div>
          </div>

          <div className="space-y-6">
            <h2 className="text-sm font-medium text-foreground uppercase tracking-wide">
              Vector Search
            </h2>

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
                Number of chunks to retrieve from vector search
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
                Minimum similarity score for retrieved chunks
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
                Number of chunks to keep after reranking
              </p>
            </div>
          </div>
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
          Configure retrieval behavior and external chat channels.
        </p>
      </div>

      <Tabs defaultValue="general" className="flex flex-1 flex-col">
        <div className="border-b border-border px-6 py-3">
          <TabsList>
            <TabsTrigger value="general">General</TabsTrigger>
            <TabsTrigger value="retrieval">Retrieval</TabsTrigger>
            <TabsTrigger value="connectors">Chat Connectors</TabsTrigger>
          </TabsList>
        </div>

        <TabsContent value="general" className="flex-1 overflow-hidden">
          <GeneralTab />
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
