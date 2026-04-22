'use client'

import { useEffect, useState } from 'react'
import { useRouter } from 'next/navigation'
import { RefreshCw, Save, Search, Settings2, SlidersHorizontal } from 'lucide-react'

import { AssistantMarkdownContent } from '@/components/dashboard/chat-markdown'
import { SettingsCard } from '@/components/dashboard/settings/settings-card'
import { SettingFieldHeader, SettingTooltip } from '@/components/dashboard/settings/settings-flow'
import { chunkingStrategyOptions } from '@/components/dashboard/settings/settings-options'
import { SettingsTabShell } from '@/components/dashboard/settings/settings-tab-shell'
import { getSettingsTabDescriptor } from '@/components/dashboard/settings/settings-tab-metadata'
import { ingestionSettingDocs } from '@/components/dashboard/settings/settings-docs'
import { Button } from '@/components/ui/button'
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
import { type DashboardRouteState } from '@/lib/dashboard-routes'
import { type IngestionSettings, settingsApi } from '@/lib/api'

export function IngestionSettingsPanel({
  accountId,
  routeState,
}: {
  accountId: string
  routeState: DashboardRouteState
}) {
  const router = useRouter()
  const descriptor = getSettingsTabDescriptor('ingestion')
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

  const updateSetting = <K extends keyof IngestionSettings>(key: K, value: IngestionSettings[K]) => {
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
          `Queued ${response.queuedDocumentCount} document${response.queuedDocumentCount === 1 ? '' : 's'} for reprocessing. Skipped ${response.skippedDocumentCount}.`,
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
    <SettingsTabShell
      accountId={accountId}
      routeState={routeState}
      descriptor={descriptor}
      onNavigate={(href) => router.push(href)}
      footer={
        <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
          <div>
            <p className="text-sm font-medium text-foreground">Ingestion changes affect future processing.</p>
            <p className="text-sm text-muted-foreground">
              Save your tuning first, then reprocess existing documents only when you want stored chunks rewritten.
            </p>
          </div>
          <Button size="sm" onClick={handleSave} disabled={!hasChanges || isSaving}>
            {isSaving ? <Spinner className="mr-2" /> : <Save className="mr-2 h-4 w-4" />}
            Save changes
          </Button>
        </div>
      }
    >
      <div className="mx-auto max-w-4xl space-y-6">
          <SettingsCard
            id="chunking-strategy"
            icon={<Settings2 className="h-5 w-5 text-primary" />}
            title="Choose a chunking strategy"
            description="Pick the splitting approach for future ingests. Strategy choice establishes the baseline before you tune the active parameters."
          >
            <div className="space-y-4">
              <SettingFieldHeader
                htmlFor="chunkingStrategy"
                label={ingestionSettingDocs.chunkingStrategy.label}
                description={ingestionSettingDocs.chunkingStrategy.summary}
                tooltip={ingestionSettingDocs.chunkingStrategy.details}
              />
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
            </div>
          </SettingsCard>

          <SettingsCard
            id="chunking-tuning"
            icon={
              settings.chunkingStrategy === 'fixed_window' ? (
                <SlidersHorizontal className="h-5 w-5 text-primary" />
              ) : (
                <Search className="h-5 w-5 text-primary" />
              )
            }
            title={settings.chunkingStrategy === 'fixed_window' ? 'Tune fixed windows' : 'Tune structure-aware chunks'}
            description={
              settings.chunkingStrategy === 'fixed_window'
                ? 'Adjust the chunk size and overlap used by the fixed-window strategy.'
                : 'Adjust the min and max chunk bounds used when structure-aware splitting groups adjacent content.'
            }
          >
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
                      <SettingFieldHeader
                        htmlFor="fixedWindowChunkSize"
                        label={ingestionSettingDocs.fixedWindowChunkSize.label}
                        tooltip={ingestionSettingDocs.fixedWindowChunkSize.details}
                        description={ingestionSettingDocs.fixedWindowChunkSize.summary}
                        className="pr-4"
                      />
                      <span className="text-sm font-mono text-muted-foreground">{settings.fixedWindowChunkSize}</span>
                    </div>
                    <Slider
                      id="fixedWindowChunkSize"
                      min={100}
                      max={4000}
                      step={10}
                      value={[settings.fixedWindowChunkSize]}
                      onValueChange={([value]) => updateSetting('fixedWindowChunkSize', value)}
                    />
                  </div>

                  <div className="space-y-3">
                    <div className="flex items-center justify-between">
                      <SettingFieldHeader
                        htmlFor="fixedWindowChunkOverlap"
                        label={ingestionSettingDocs.fixedWindowChunkOverlap.label}
                        tooltip={ingestionSettingDocs.fixedWindowChunkOverlap.details}
                        description={ingestionSettingDocs.fixedWindowChunkOverlap.summary}
                        className="pr-4"
                      />
                      <span className="text-sm font-mono text-muted-foreground">{settings.fixedWindowChunkOverlap}</span>
                    </div>
                    <Slider
                      id="fixedWindowChunkOverlap"
                      min={0}
                      max={2000}
                      step={10}
                      value={[Math.min(settings.fixedWindowChunkOverlap, 2000)]}
                      onValueChange={([value]) => updateSetting('fixedWindowChunkOverlap', value)}
                    />
                  </div>
                </>
              ) : (
                <>
                  <div className="space-y-3">
                    <div className="flex items-center justify-between">
                      <SettingFieldHeader
                        htmlFor="structuredMinChunkSize"
                        label={ingestionSettingDocs.structuredMinChunkSize.label}
                        tooltip={ingestionSettingDocs.structuredMinChunkSize.details}
                        description={ingestionSettingDocs.structuredMinChunkSize.summary}
                        className="pr-4"
                      />
                      <span className="text-sm font-mono text-muted-foreground">{settings.structuredMinChunkSize}</span>
                    </div>
                    <Slider
                      id="structuredMinChunkSize"
                      min={1}
                      max={1000}
                      step={1}
                      value={[Math.min(settings.structuredMinChunkSize, 1000)]}
                      onValueChange={([value]) => updateSetting('structuredMinChunkSize', value)}
                    />
                  </div>

                  <div className="space-y-3">
                    <div className="flex items-center justify-between">
                      <SettingFieldHeader
                        htmlFor="structuredMaxChunkSize"
                        label={ingestionSettingDocs.structuredMaxChunkSize.label}
                        tooltip={ingestionSettingDocs.structuredMaxChunkSize.details}
                        description={ingestionSettingDocs.structuredMaxChunkSize.summary}
                        className="pr-4"
                      />
                      <span className="text-sm font-mono text-muted-foreground">{settings.structuredMaxChunkSize}</span>
                    </div>
                    <Slider
                      id="structuredMaxChunkSize"
                      min={1}
                      max={2000}
                      step={1}
                      value={[Math.min(settings.structuredMaxChunkSize, 2000)]}
                      onValueChange={([value]) => updateSetting('structuredMaxChunkSize', value)}
                    />
                  </div>
                </>
              )}
            </div>
          </SettingsCard>

          <SettingsCard
            id="existing-documents"
            icon={<RefreshCw className="h-5 w-5 text-primary" />}
            title="Apply changes to existing documents"
            description="Save the new ingestion settings, then re-queue eligible documents when you want stored chunks rewritten."
          >
            <div className="space-y-4">
              <div className="space-y-1">
                <div className="flex items-center gap-1.5">
                  <Label className="text-foreground">{ingestionSettingDocs.reprocess.label}</Label>
                  <SettingTooltip
                    label={ingestionSettingDocs.reprocess.label}
                    content={ingestionSettingDocs.reprocess.details}
                  />
                </div>
                <div className="text-sm text-muted-foreground">
                  <AssistantMarkdownContent content={ingestionSettingDocs.reprocess.summary} inline />
                </div>
              </div>
              <div className="space-y-4 rounded-md border border-border bg-muted/20 p-4">
                <p className="text-sm text-muted-foreground">
                  Saving settings does not rewrite existing chunks. Use this action when you want current documents to be re-queued with the latest ingestion configuration.
                </p>
                <div className="flex items-center gap-3">
                  <Button onClick={handleReprocess} disabled={isReprocessing || isSaving}>
                    {isReprocessing || isSaving ? <Spinner className="mr-2" /> : <RefreshCw className="w-4 h-4 mr-2" />}
                    Reprocess Existing Documents
                  </Button>
                  {reprocessMessage ? <p className="text-sm text-muted-foreground">{reprocessMessage}</p> : null}
                </div>
              </div>
            </div>
          </SettingsCard>
      </div>
    </SettingsTabShell>
  )
}
