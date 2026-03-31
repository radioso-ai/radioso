'use client'

import { useEffect, useState } from 'react'
import { RefreshCw, Save, Search, Settings2, SlidersHorizontal } from 'lucide-react'

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
import { type IngestionSettings, settingsApi } from '@/lib/api'
import { SettingsCard } from '@/components/dashboard/settings/settings-card'
import { chunkingStrategyOptions } from '@/components/dashboard/settings/settings-options'

export function IngestionSettingsPanel() {
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
            id="document-processing"
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
                        <span className="text-sm text-muted-foreground font-mono">{settings.fixedWindowChunkSize}</span>
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
                        <span className="text-sm text-muted-foreground font-mono">{settings.fixedWindowChunkOverlap}</span>
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
                        <span className="text-sm text-muted-foreground font-mono">{settings.structuredMinChunkSize}</span>
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
                        <span className="text-sm text-muted-foreground font-mono">{settings.structuredMaxChunkSize}</span>
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
            id="existing-documents"
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
                {reprocessMessage ? <p className="text-sm text-muted-foreground">{reprocessMessage}</p> : null}
              </div>
            </div>
          </SettingsCard>
        </div>
      </div>
    </div>
  )
}
