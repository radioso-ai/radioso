'use client'

import { useEffect, useMemo, useRef, useState } from 'react'
import { Database, RefreshCw, Search, Settings2, SlidersHorizontal } from 'lucide-react'

import { SettingsCard } from '@/components/dashboard/settings/settings-card'
import { SettingFieldHeader, SettingTooltip } from '@/components/dashboard/settings/settings-flow'
import { chunkingStrategyOptions, embeddingModelOptions } from '@/components/dashboard/settings/settings-options'
import { SettingsTabShell } from '@/components/dashboard/settings/settings-tab-shell'
import { ingestionSettingDocs } from '@/components/dashboard/settings/settings-docs'
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog'
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
  const [isCancelingEmbeddingModelChange, setIsCancelingEmbeddingModelChange] = useState(false)
  const [reprocessMessage, setReprocessMessage] = useState<string | null>(null)
  const [embeddingModelChange, setEmbeddingModelChange] = useState<IngestionSettings['embeddingModel'] | null>(null)
  const [isConfirmingEmbeddingModelChange, setIsConfirmingEmbeddingModelChange] = useState(false)
  const [embeddingModelChangeError, setEmbeddingModelChangeError] = useState<string | null>(null)
  const [autosaveResumeToken, setAutosaveResumeToken] = useState(0)
  const hasLoadedRef = useRef(false)
  const saveSequenceRef = useRef(0)
  const draftVersionRef = useRef(0)
  const suspendAutosaveRef = useRef(false)

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
      if (suspendAutosaveRef.current) {
        return
      }
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
  }, [autosaveResumeToken, lastSavedSettings, lastSavedSignature, settings, settingsSignature])

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

  const handleCancelEmbeddingModelChange = async () => {
    if (!settings?.pendingEmbeddingModel) return
    setIsCancelingEmbeddingModelChange(true)
    setReprocessMessage(null)
    try {
      const updated = await settingsApi.cancelPendingEmbeddingModel()
      setSettings(updated)
      setLastSavedSettings(updated)
      setSaveState('saved')
      setReprocessMessage('Pending embedding model change cancelled. Reprocess existing documents to restore any chunks already written with the cancelled model.')
    } catch (error) {
      console.error('Failed to cancel pending embedding model change:', error)
      setSaveState('error')
      setSaveError('Failed to cancel pending embedding model change.')
      setReprocessMessage('Failed to cancel pending embedding model change.')
    } finally {
      setIsCancelingEmbeddingModelChange(false)
    }
  }

  const handleEmbeddingModelChangeRequest = (value: IngestionSettings['embeddingModel']) => {
    if (!settings || value === selectedEmbeddingModel || settings.pendingEmbeddingModel || isReprocessing) return
    if (!settings.supportedEmbeddingModels.includes(value)) return
    suspendAutosaveRef.current = true
    saveSequenceRef.current += 1
    setEmbeddingModelChange(value)
    setEmbeddingModelChangeError(null)
  }

  const handleEmbeddingModelDialogChange = (open: boolean) => {
    if (open || isConfirmingEmbeddingModelChange) return
    suspendAutosaveRef.current = false
    setEmbeddingModelChange(null)
    setEmbeddingModelChangeError(null)
    setAutosaveResumeToken((token) => token + 1)
  }

  const handleConfirmEmbeddingModelChange = async () => {
    if (!settings || !embeddingModelChange) return
    setIsConfirmingEmbeddingModelChange(true)
    setEmbeddingModelChangeError(null)
    setReprocessMessage(null)
    setSaveState('saving')
    setSaveError(null)

    try {
      const draft = {
        ...settings,
        embeddingModel: embeddingModelChange,
      }
      const draftVersionAtRequestStart = draftVersionRef.current
      const updated = await persistSettings(draft)
      if (draftVersionRef.current === draftVersionAtRequestStart) {
        setSettings(updated)
        setSaveState('saved')
      }
      setReprocessMessage(
        updated.pendingEmbeddingModel
          ? 'Embedding model updated. Existing documents were queued for re-indexing.'
          : 'Embedding model updated.',
      )
      setEmbeddingModelChange(null)
    } catch (error) {
      console.error('Failed to change embedding model and re-index documents:', error)
      setSaveState('error')
      setSaveError('Failed to update the embedding model.')
      setEmbeddingModelChangeError('Failed to complete the embedding model change and start re-indexing. Check the current setting before trying again.')
    } finally {
      setIsConfirmingEmbeddingModelChange(false)
      suspendAutosaveRef.current = false
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

  const selectedEmbeddingModel = settings.pendingEmbeddingModel ?? settings.embeddingModel
  const isEmbeddingModelPending = Boolean(settings.pendingEmbeddingModel)
  const supportedEmbeddingModels = new Set(settings.supportedEmbeddingModels)
  const isEmbeddingModelSelectDisabled =
    isConfirmingEmbeddingModelChange || isReprocessing || isCancelingEmbeddingModelChange || isEmbeddingModelPending
  const selectedEmbeddingModelLabel =
    embeddingModelOptions.find((option) => option.value === selectedEmbeddingModel)?.label ?? selectedEmbeddingModel
  const requestedEmbeddingModelLabel = embeddingModelChange
    ? embeddingModelOptions.find((option) => option.value === embeddingModelChange)?.label ?? embeddingModelChange
    : null

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
                <Database className="h-4 w-4 text-primary" />
                <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
                  Embedding model
                </p>
              </div>
              <SettingFieldHeader
                htmlFor="embeddingModel"
                label={ingestionSettingDocs.embeddingModel.label}
                description="Vector model used for future uploads and document updates."
                tooltip={ingestionSettingDocs.embeddingModel.details}
              />
              <Select
                value={selectedEmbeddingModel}
                onValueChange={(value) => handleEmbeddingModelChangeRequest(value as IngestionSettings['embeddingModel'])}
                disabled={isEmbeddingModelSelectDisabled}
              >
                <SelectTrigger id="embeddingModel" className="w-full">
                  <SelectValue placeholder="Select an embedding model" />
                </SelectTrigger>
                <SelectContent>
                  {embeddingModelOptions.map((option) => (
                    <SelectItem key={option.value} value={option.value} disabled={!supportedEmbeddingModels.has(option.value)}>
                      {option.label}
                      {!supportedEmbeddingModels.has(option.value) ? ' (not configured)' : ''}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <div className="space-y-2">
                {embeddingModelOptions
                  .filter((option) => option.value === selectedEmbeddingModel)
                  .map((option) => (
                    <div key={option.value}>
                      <p className="text-sm font-medium text-foreground">{option.label}</p>
                      <p className="text-sm text-muted-foreground">{option.description}</p>
                    </div>
                  ))}
                {isEmbeddingModelPending ? (
                  <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
                    <p className="text-sm text-muted-foreground">
                      Active model: {settings.embeddingModel}. Finish the current re-index before changing models again.
                    </p>
                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      onClick={handleCancelEmbeddingModelChange}
                      disabled={isCancelingEmbeddingModelChange}
                    >
                      {isCancelingEmbeddingModelChange ? <Spinner className="mr-2" /> : null}
                      Cancel change
                    </Button>
                  </div>
                ) : null}
              </div>
            </div>
            <div className="space-y-4 border-t border-border/70 pt-4">
              <div className="flex items-center gap-2">
                {settings.chunkingStrategy === 'fixed_window' ? (
                  <SlidersHorizontal className="h-4 w-4 text-primary" />
                ) : (
                  <Search className="h-4 w-4 text-primary" />
                )}
                <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
                  {settings.chunkingStrategy === 'fixed_window' ? 'Fixed-size chunk tuning' : 'Semantic chunk tuning'}
                </p>
              </div>

                {settings.chunkingStrategy === 'fixed_window' ? (
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
                ) : (
                  <>
                    <div className="space-y-3">
                      <div className="flex items-center justify-between">
                        <SettingFieldHeader
                          htmlFor="structuredMinChunkSize"
                          label="Minimum chunk size"
                          description="Merge very small sections until they reach this size."
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
                          description="Stop growing a semantic chunk once it reaches this size."
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
        <AlertDialog open={embeddingModelChange !== null} onOpenChange={handleEmbeddingModelDialogChange}>
          <AlertDialogContent>
            <AlertDialogHeader>
              <AlertDialogTitle>Change embedding model?</AlertDialogTitle>
              <AlertDialogDescription>
                Changing from {selectedEmbeddingModelLabel} to {requestedEmbeddingModelLabel} requires all existing
                documents to be re-indexed. Semantic search keeps using the active model until re-indexing completes.
              </AlertDialogDescription>
            </AlertDialogHeader>
            {embeddingModelChangeError ? (
              <p className="text-sm text-destructive">{embeddingModelChangeError}</p>
            ) : null}
            <AlertDialogFooter>
              <AlertDialogCancel disabled={isConfirmingEmbeddingModelChange}>Cancel</AlertDialogCancel>
              <AlertDialogAction
                disabled={isConfirmingEmbeddingModelChange}
                onClick={(event) => {
                  event.preventDefault()
                  void handleConfirmEmbeddingModelChange()
                }}
              >
                {isConfirmingEmbeddingModelChange ? <Spinner className="mr-2" /> : <RefreshCw className="mr-2 h-4 w-4" />}
                Change model and re-index
              </AlertDialogAction>
            </AlertDialogFooter>
          </AlertDialogContent>
        </AlertDialog>
      </div>
    </SettingsTabShell>
  )
}
