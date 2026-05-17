'use client'

import { useEffect, useMemo, useRef, useState } from 'react'
import { RefreshCw, Search, Settings2, SlidersHorizontal } from 'lucide-react'

import { SettingsCard } from '@/components/dashboard/settings/settings-card'
import { SettingFieldHeader, SettingTooltip } from '@/components/dashboard/settings/settings-flow'
import { chunkingStrategyOptions } from '@/components/dashboard/settings/settings-options'
import { SettingsTabShell } from '@/components/dashboard/settings/settings-tab-shell'
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
import { LogoSpinner, Spinner } from '@/components/ui/spinner'
import { type IngestionSettings, settingsApi } from '@/lib/api'
import { useWorkspace } from '@/lib/workspace-context'

export function IngestionSettingsPanel({
  onSaveStateChange,
}: {
  onSaveStateChange?: (input: { state: 'idle' | 'saved' | 'saving' | 'error'; message?: string | null }) => void
}) {
  const { activeWorkspaceId, isLoading: isWorkspaceLoading } = useWorkspace()
  const [settings, setSettings] = useState<IngestionSettings | null>(null)
  const [isLoading, setIsLoading] = useState(true)
  const [lastSavedSettings, setLastSavedSettings] = useState<IngestionSettings | null>(null)
  const [saveState, setSaveState] = useState<'idle' | 'saved' | 'saving' | 'error'>('idle')
  const [saveError, setSaveError] = useState<string | null>(null)
  const [isReprocessing, setIsReprocessing] = useState(false)
  const [reprocessMessage, setReprocessMessage] = useState<string | null>(null)
  const hasLoadedRef = useRef(false)
  const saveSequenceRef = useRef(0)
  const draftVersionRef = useRef(0)

  useEffect(() => {
    onSaveStateChange?.({ state: saveState, message: saveError })
  }, [onSaveStateChange, saveError, saveState])

  useEffect(() => {
    if (isWorkspaceLoading || !activeWorkspaceId) {
      // eslint-disable-next-line react-hooks/set-state-in-effect -- Workspace changes reset this async settings panel to loading.
      setIsLoading(true)
      return
    }

    let active = true
    const loadSettings = async () => {
      try {
        const data = await settingsApi.getIngestionSettings()
        if (!active) return
        setSettings(data)
        setLastSavedSettings(data)
        setSaveState('idle')
      } catch (error) {
        if (!active) return
        console.error('Failed to load ingestion settings:', error)
      } finally {
        if (active) {
          setIsLoading(false)
          hasLoadedRef.current = true
        }
      }
    }
    void loadSettings()
    return () => {
      active = false
    }
  }, [activeWorkspaceId, isWorkspaceLoading])

  const updateSettingsDraft = (updater: (current: IngestionSettings) => IngestionSettings) => {
    draftVersionRef.current += 1
    setSettings((current) => (current ? updater(current) : current))
  }

  const updateSetting = <K extends keyof IngestionSettings>(key: K, value: IngestionSettings[K]) => {
    updateSettingsDraft((current) => ({ ...current, [key]: value }))
    setReprocessMessage(null)
  }

  const persistSettings = async (draft: IngestionSettings) => {
    const updated = await settingsApi.updateIngestionSettings(draft)
    setLastSavedSettings(updated)
    return updated
  }

  const settingsSignature = useMemo(() => JSON.stringify(settings), [settings])
  const lastSavedSignature = useMemo(() => JSON.stringify(lastSavedSettings), [lastSavedSettings])

  useEffect(() => {
    if (!hasLoadedRef.current || !settings || !lastSavedSettings) {
      return
    }

    if (settingsSignature === lastSavedSignature) {
      return
    }

    const saveId = saveSequenceRef.current + 1
    saveSequenceRef.current = saveId
    const timeout = window.setTimeout(async () => {
      setSaveState('saving')
      setSaveError(null)
      const draftVersionAtRequestStart = draftVersionRef.current
      try {
        const updated = await persistSettings(settings)
        if (saveSequenceRef.current !== saveId) {
          return
        }
        if (draftVersionRef.current === draftVersionAtRequestStart) {
          setSettings(updated)
          setSaveState('saved')
        }
      } catch (error) {
        if (saveSequenceRef.current !== saveId) {
          return
        }
        console.error('Failed to save ingestion settings:', error)
        setSaveState('error')
        setSaveError('Failed to save changes. Your latest edits are still in the browser.')
      }
    }, 700)

    return () => window.clearTimeout(timeout)
  }, [lastSavedSettings, lastSavedSignature, settings, settingsSignature])

  const handleReprocess = async () => {
    if (!settings) return
    setIsReprocessing(true)
    setReprocessMessage(null)
    try {
      if (settingsSignature !== lastSavedSignature) {
        const draftVersionAtRequestStart = draftVersionRef.current
        setSaveState('saving')
        setSaveError(null)
        const updated = await persistSettings(settings)
        if (draftVersionRef.current === draftVersionAtRequestStart) {
          setSettings(updated)
          setSaveState('saved')
        }
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
      setReprocessMessage(
        settingsSignature !== lastSavedSignature
          ? 'Failed to save settings before reprocessing.'
          : 'Failed to start workspace reprocessing.'
      )
      setSaveState('error')
      setSaveError('Failed to save changes. Your latest edits are still in the browser.')
    } finally {
      setIsReprocessing(false)
    }
  }

  if (isLoading) {
    return (
      <div className="flex items-center justify-center h-full">
        <LogoSpinner imageClassName="h-7 w-7" />
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

  const isFixedWindowChunking = settings.chunkingStrategy === 'fixed_window'
  const isRecursiveTextChunking = settings.chunkingStrategy === 'recursive_text'
  const chunkingTuningLabel = isFixedWindowChunking
    ? 'Fixed-size chunk tuning'
    : isRecursiveTextChunking
      ? 'Recursive text tuning'
      : 'Semantic chunk tuning'

  return (
    <SettingsTabShell>
      <div className="space-y-6">
        <SettingsCard
          id="chunking-strategy"
          icon={<Settings2 className="h-5 w-5 text-primary" />}
          title="Chunking"
          description="How documents are split before they become searchable, along with the active strategy settings."
        >
          <div className="space-y-4">
            <SettingFieldHeader
              htmlFor="chunkingStrategy"
              label={ingestionSettingDocs.chunkingStrategy.label}
              description="Chunking approach used for future uploads and document updates."
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
            <div className="space-y-2">
              {chunkingStrategyOptions
                .filter((option) => option.value === settings.chunkingStrategy)
                .map((option) => (
                  <div key={option.value}>
                    <p className="text-sm font-medium text-foreground">{option.label}</p>
                    <p className="text-sm text-muted-foreground">{option.description}</p>
                  </div>
                ))}
            </div>
            <div className="space-y-4 border-t border-border/70 pt-4">
              <div className="flex items-center gap-2">
                {isFixedWindowChunking ? (
                  <SlidersHorizontal className="h-4 w-4 text-primary" />
                ) : (
                  <Search className="h-4 w-4 text-primary" />
                )}
                <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
                  {chunkingTuningLabel}
                </p>
              </div>

                {isFixedWindowChunking ? (
                  <>
                    <div className="space-y-3">
                      <div className="flex items-center justify-between">
                        <SettingFieldHeader
                          htmlFor="fixedWindowChunkSize"
                          label="Chunk size"
                          description="Target size for each chunk."
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
                          label="Overlap"
                          description="How much adjacent chunks should share."
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
                ) : isRecursiveTextChunking ? (
                  <>
                    <div className="space-y-3">
                      <div className="flex items-center justify-between">
                        <SettingFieldHeader
                          htmlFor="fixedWindowChunkSize"
                          label="Chunk size"
                          description="Maximum size for recursive text chunks."
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
                          htmlFor="structuredMinChunkSize"
                          label="Minimum chunk size"
                          description="Merge small recursive splits until they reach this size."
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
                  </>
                ) : (
                  <>
                    <div className="space-y-3">
                      <div className="flex items-center justify-between">
                        <SettingFieldHeader
                          htmlFor="structuredMinChunkSize"
                          label="Minimum chunk size"
                          description="Keep very small text segments with nearby content."
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
                          label="Maximum chunk size"
                          description="Stop growing a semantic text chunk once it reaches this size."
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
              <div id="existing-documents" className="space-y-4 border-t border-border/70 pt-4">
                <div className="space-y-1">
                  <div className="flex items-center gap-1.5">
                    <Label className="text-foreground">{ingestionSettingDocs.reprocess.label}</Label>
                    <SettingTooltip
                      label={ingestionSettingDocs.reprocess.label}
                      content={ingestionSettingDocs.reprocess.details}
                    />
                  </div>
                </div>
                <p className="text-sm text-muted-foreground">
                  Changes apply to future ingests and document updates immediately. Existing documents keep their current chunks until you reprocess them.
                </p>
                <div className="flex items-center gap-3">
                  <Button onClick={handleReprocess} disabled={isReprocessing}>
                    {isReprocessing ? <Spinner className="mr-2" /> : <RefreshCw className="w-4 h-4 mr-2" />}
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
