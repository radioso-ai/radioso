'use client'

import { useMemo, useState } from 'react'
import { Cpu, MessageSquare, RefreshCw, ScanSearch, Search, Sparkles } from 'lucide-react'

import { ModelPicker } from '@/components/dashboard/settings/model-picker'
import { SettingsCard } from '@/components/dashboard/settings/settings-card'
import { embeddingModelOptions } from '@/components/dashboard/settings/settings-options'
import type { SaveStateIndicatorState as SaveState } from '@/components/dashboard/shared/save-state-indicator'
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
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Label } from '@/components/ui/label'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { Spinner } from '@/components/ui/spinner'
import { useEmbeddingCoverage } from '@/hooks/use-embedding-coverage'
import { getApiErrorMessage } from '@/lib/api-error'
import { settingsApi } from '@/lib/api'
import type { IngestionSettings } from '@/lib/api-types'
import {
  summarizeEmbeddingCoverage,
  type EmbeddingCoverageSummary,
} from '@/lib/embedding-coverage'
import {
  capabilityDisplayName,
  llmCapabilityNames,
  llmProviderNames,
  llmProvidersApi,
  providerDisplayName,
  type CredentialProviderName,
  type EnvProviderAvailability,
  type KnownModelsByProvider,
  type LlmCapabilityName,
  type LlmCapabilityPreference,
  type LlmProviderName,
  type LlmManagedModel,
  type ProviderCredentialSummary,
  type WorkspaceLlmModels,
} from '@/lib/api-llm-providers'

const embeddingCoverageDetail = (summary: EmbeddingCoverageSummary): string => {
  const indexed = `${summary.coveredChunks.toLocaleString()} of `
    + `${summary.eligibleChunks.toLocaleString()} chunks indexed`
  switch (summary.status) {
    case 'empty':
      return 'No documents are indexed yet.'
    case 'complete':
      return `All ${summary.eligibleChunks.toLocaleString()} chunks are indexed.`
    case 'unconfigured':
      return `${indexed}. Set an embedding model to index the rest.`
    case 'stalled':
      return `${indexed}. ${summary.failedJobs.toLocaleString()} job(s) failed and will `
        + 'not retry on their own.'
    case 'indexing':
      return summary.queuedJobs > 0
        ? `${indexed}. ${summary.queuedJobs.toLocaleString()} job(s) queued.`
        : `${indexed}.`
  }
}

type EmbeddingProviderName = 'openai' | 'gemini'

const embeddingProviderNames: readonly EmbeddingProviderName[] = ['openai', 'gemini']

const embeddingProviderDisplayName: Record<EmbeddingProviderName, string> = {
  openai: 'OpenAI',
  gemini: 'Google Gemini',
}

const embeddingProviderForModel = (model: IngestionSettings['embeddingModel']): EmbeddingProviderName =>
  model.startsWith('gemini-') ? 'gemini' : 'openai'

const embeddingModelsByProvider: Record<EmbeddingProviderName, typeof embeddingModelOptions> = {
  openai: embeddingModelOptions.filter((option) => embeddingProviderForModel(option.value) === 'openai'),
  gemini: embeddingModelOptions.filter((option) => embeddingProviderForModel(option.value) === 'gemini'),
}

const modelRowClassName =
  'grid gap-3 sm:grid-cols-[14rem_minmax(12rem,1fr)_minmax(12rem,1fr)_5.5rem] xl:grid-cols-[16rem_minmax(16rem,1fr)_minmax(18rem,1fr)_5.5rem]'

const capabilityVisual: Record<
  LlmCapabilityName | 'embeddings',
  { icon: typeof MessageSquare; description: string }
> = {
  chat: {
    icon: MessageSquare,
    description: 'Generates assistant replies in chat surfaces.',
  },
  rewrite: {
    icon: Sparkles,
    description: 'Rewrites user questions into search queries before retrieval.',
  },
  rerank: {
    icon: ScanSearch,
    description: 'Re-orders retrieved passages by relevance.',
  },
  embeddings: {
    icon: Search,
    description: 'Indexes documents as vectors for semantic search.',
  },
}

export function ModelsCard({
  models,
  credentials,
  envProviderAvailability,
  onChange,
  ingestionSettings,
  onIngestionSettingsChange,
  onIngestionSettingsReload,
  emitSaveState,
}: {
  models: WorkspaceLlmModels
  credentials: ProviderCredentialSummary[]
  envProviderAvailability: EnvProviderAvailability
  onChange: () => Promise<unknown>
  ingestionSettings: IngestionSettings | null
  onIngestionSettingsChange: (settings: IngestionSettings) => void
  onIngestionSettingsReload: () => Promise<IngestionSettings>
  emitSaveState: (state: SaveState) => void
}) {
  const credentialProviders = useMemo(
    () => new Set(credentials.map((c) => c.provider)),
    [credentials],
  )
  const availableProviders = useMemo(
    () =>
      new Set(
        llmProviderNames.filter(
          (provider) => credentialProviders.has(provider) || envProviderAvailability[provider],
        ),
      ),
    [credentialProviders, envProviderAvailability],
  )

  return (
    <SettingsCard
      id="provider-models"
      icon={<Cpu className="h-5 w-5 text-primary" />}
      title="Models"
      description="Model assigned to each capability. Chat, rewrite, and rerank fall back to deployment defaults; changing the embedding model re-indexes existing documents."
    >
      <div className="divide-y divide-border/60 rounded-xl border border-border/60 bg-background/40">
        {llmCapabilityNames.map((capability) => {
          const current = models[capability] ?? null
          const managed = models.managed?.[capability] ?? null
          // Remount the row whenever the persisted preference or the plan's
          // decision changes so the editable provider/model fields reset to
          // the new server value.
          const remountKey = `${capability}:${current?.provider ?? ''}:${current?.model ?? ''}:${managed?.provider ?? ''}:${managed?.model ?? ''}`
          return (
            <ModelRow
              key={remountKey}
              capability={capability}
              value={current}
              managed={managed}
              credentialProviders={credentialProviders}
              availableProviders={availableProviders}
              runnableModelsByProvider={models.runnableModelsByProvider}
              knownModelsByProvider={models.knownModelsByProvider}
              onChange={onChange}
              emitSaveState={emitSaveState}
            />
          )
        })}
        {ingestionSettings ? (
          <EmbeddingModelRow
            key={`embeddings:${ingestionSettings.embeddingModel}:${ingestionSettings.pendingEmbeddingModel ?? ''}`}
            settings={ingestionSettings}
            onChange={onIngestionSettingsChange}
            onReload={onIngestionSettingsReload}
            emitSaveState={emitSaveState}
          />
        ) : null}
      </div>
    </SettingsCard>
  )
}

function ModelRow({
  capability,
  value,
  managed,
  credentialProviders,
  availableProviders,
  runnableModelsByProvider,
  knownModelsByProvider,
  onChange,
  emitSaveState,
}: {
  capability: LlmCapabilityName
  value: LlmCapabilityPreference | null
  managed: LlmManagedModel | null
  credentialProviders: ReadonlySet<CredentialProviderName>
  availableProviders: Set<LlmProviderName>
  runnableModelsByProvider: KnownModelsByProvider
  knownModelsByProvider: KnownModelsByProvider
  onChange: () => Promise<unknown>
  emitSaveState: (state: SaveState) => void
}) {
  // While the plan decides, the pickers show its choice, read-only. The stored
  // preference stays on the server and comes back the moment the lock lifts.
  const shown = managed ?? value
  const [provider, setProvider] = useState<LlmProviderName | ''>(shown?.provider ?? '')
  const [model, setModel] = useState(shown?.model ?? '')
  const [busy, setBusy] = useState(false)

  const locked = managed !== null
  const hasValue = value !== null
  const savedProviderUnavailable = !locked && value !== null && !availableProviders.has(value.provider)
  // A managed model outside the runnable list still has to be visible in
  // the closed-set picker.
  const pickerModels = useMemo(() => {
    if (!managed || runnableModelsByProvider[managed.provider]?.includes(managed.model)) {
      return runnableModelsByProvider
    }
    return {
      ...runnableModelsByProvider,
      [managed.provider]: [managed.model, ...(runnableModelsByProvider[managed.provider] ?? [])],
    }
  }, [managed, runnableModelsByProvider])

  const persistModel = async (nextProvider: LlmProviderName, nextModel: string) => {
    setBusy(true)
    emitSaveState({ state: 'saving' })
    try {
      await llmProvidersApi.updateModels({
        [capability]: { provider: nextProvider, model: nextModel.trim() },
      })
      await onChange()
      emitSaveState({ state: 'saved' })
    } catch (err) {
      emitSaveState({ state: 'error', message: getApiErrorMessage(err, 'Failed to save model preference.') })
    } finally {
      setBusy(false)
    }
  }

  const handleProviderChange = (next: string) => {
    setProvider(next as LlmProviderName)
    setModel('')
  }

  const handleModelCommit = (next: string) => {
    const trimmed = next.trim()
    if (provider === '' || trimmed.length === 0) return
    const initialProvider = value?.provider ?? ''
    const initialModel = value?.model ?? ''
    if (provider === initialProvider && trimmed === initialModel) return
    void persistModel(provider, trimmed)
  }

  const handleReset = async () => {
    setBusy(true)
    emitSaveState({ state: 'saving' })
    try {
      await llmProvidersApi.updateModels({ [capability]: null })
      await onChange()
      emitSaveState({ state: 'saved' })
    } catch (err) {
      emitSaveState({ state: 'error', message: getApiErrorMessage(err, 'Failed to clear model preference.') })
    } finally {
      setBusy(false)
    }
  }

  const visual = capabilityVisual[capability]
  const Icon = visual.icon

  return (
    <div
      className={`${modelRowClassName} px-4 py-4`}
      data-testid={`llm-model-row-${capability}`}
    >
      <div className="flex min-w-0 items-start gap-3">
        <div
          aria-hidden="true"
          className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg border border-primary/15 bg-primary/10 text-primary"
        >
          <Icon className="h-4 w-4" />
        </div>
        <div className="min-w-0 space-y-1">
          <div className="flex flex-wrap items-center gap-1.5">
            <p className="text-sm font-medium text-foreground">{capabilityDisplayName[capability]}</p>
            <Badge
              variant={hasValue && !locked ? 'default' : 'outline'}
              className={
                hasValue && !locked
                  ? 'bg-emerald-500/10 text-emerald-700 ring-1 ring-inset ring-emerald-500/30 dark:text-emerald-300'
                  : 'text-muted-foreground'
              }
            >
              {locked ? 'Managed plan' : hasValue ? 'Workspace override' : 'Default'}
            </Badge>
          </div>
          <p className="text-xs leading-relaxed text-muted-foreground">{visual.description}</p>
          {locked ? (
            <p className="text-xs leading-relaxed text-foreground" data-testid={`llm-model-managed-${capability}`}>
              This capability uses Radioso&apos;s managed default, {managed.model}. Add a workspace key for{' '}
              {providerDisplayName[value?.provider ?? managed.provider]} to use your own account; remove that key to return here.
            </p>
          ) : null}
          <p className="sr-only">
            {locked ? 'Managed by plan' : hasValue ? 'Workspace override' : 'Using deployment default'}
          </p>
        </div>
      </div>
      <div className="min-w-0 space-y-1">
        <Label htmlFor={`provider-${capability}`} className="text-xs uppercase tracking-wide text-muted-foreground">
          Provider
        </Label>
        <Select value={provider} onValueChange={handleProviderChange} disabled={locked}>
          <SelectTrigger id={`provider-${capability}`} className="w-full min-w-0" disabled={busy || locked}>
            <SelectValue placeholder="Choose provider" />
          </SelectTrigger>
          <SelectContent>
            {llmProviderNames.map((option) => {
              const isAvailable = availableProviders.has(option)
              const suffix = isAvailable
                ? credentialProviders.has(option)
                  ? ''
                  : ' (deployment key)'
                : ' (no key configured)'
              return (
                <SelectItem key={option} value={option} disabled={!isAvailable}>
                  {providerDisplayName[option]}
                  {suffix}
                </SelectItem>
              )
            })}
          </SelectContent>
        </Select>
        {savedProviderUnavailable ? (
          <p className="text-xs text-amber-600 dark:text-amber-400">
            The saved provider has no API key configured. Add one in Provider API keys above, or reset this row.
          </p>
        ) : null}
      </div>
      <div className="min-w-0 space-y-1">
        <Label htmlFor={`model-${capability}`} className="text-xs uppercase tracking-wide text-muted-foreground">
          Model
        </Label>
        <ModelPicker
          inputId={`model-${capability}`}
          provider={provider}
          runnableModelsByProvider={pickerModels}
          knownModelsByProvider={knownModelsByProvider}
          value={model}
          onChange={setModel}
          onCommit={handleModelCommit}
          disabled={busy || locked}
          className="w-full min-w-0"
        />
      </div>
      <div className="flex items-end gap-2 sm:justify-end sm:pl-2">
        {hasValue && !locked ? (
          <Button type="button" size="sm" variant="ghost" onClick={handleReset} disabled={busy}>
            Reset
          </Button>
        ) : (
          <Button
            type="button"
            size="sm"
            variant="ghost"
            className="invisible"
            tabIndex={-1}
            aria-hidden="true"
          >
            Reset
          </Button>
        )}
      </div>
    </div>
  )
}

function EmbeddingModelRow({
  settings,
  onChange,
  onReload,
  emitSaveState,
}: {
  settings: IngestionSettings
  onChange: (settings: IngestionSettings) => void
  onReload: () => Promise<IngestionSettings>
  emitSaveState: (state: SaveState) => void
}) {
  const currentModel = settings.pendingEmbeddingModel ?? settings.embeddingModel
  const [provider, setProvider] = useState<EmbeddingProviderName>(embeddingProviderForModel(currentModel))
  const [model, setModel] = useState<IngestionSettings['embeddingModel']>(currentModel)
  const coverage = useEmbeddingCoverage(currentModel)
  const [busy, setBusy] = useState(false)
  const [canceling, setCanceling] = useState(false)
  const [requestedModel, setRequestedModel] = useState<IngestionSettings['embeddingModel'] | null>(null)
  const [dialogError, setDialogError] = useState<string | null>(null)

  const supportedEmbeddingModels = useMemo<ReadonlySet<string>>(
    () => new Set<string>(settings.supportedEmbeddingModels),
    [settings.supportedEmbeddingModels],
  )
  const providerOptions = useMemo(
    () =>
      embeddingProviderNames.map((option) => ({
        provider: option,
        supported: embeddingModelsByProvider[option].some((modelOption) =>
          supportedEmbeddingModels.has(modelOption.value),
        ),
      })),
    [supportedEmbeddingModels],
  )
  const modelOptions = embeddingModelsByProvider[provider]
  const isPending = Boolean(settings.pendingEmbeddingModel)
  const selectedModelOption = embeddingModelOptions.find((option) => option.value === currentModel)
  const activeModelOption = embeddingModelOptions.find((option) => option.value === settings.embeddingModel)
  const pendingModelOption = settings.pendingEmbeddingModel
    ? embeddingModelOptions.find((option) => option.value === settings.pendingEmbeddingModel)
    : null
  const requestedModelOption = requestedModel
    ? embeddingModelOptions.find((option) => option.value === requestedModel)
    : null
  const coverageSummary = coverage ? summarizeEmbeddingCoverage(coverage) : null

  const openConfirmation = (nextModel: IngestionSettings['embeddingModel']) => {
    if (busy || isPending) return
    if (nextModel === currentModel) return
    if (!supportedEmbeddingModels.has(nextModel)) return
    setDialogError(null)
    setRequestedModel(nextModel)
  }

  const handleProviderChange = (nextProvider: string) => {
    const typedProvider = nextProvider as EmbeddingProviderName
    setProvider(typedProvider)
    setDialogError(null)
    const firstSupportedModel = embeddingModelsByProvider[typedProvider]
      .find((option) => supportedEmbeddingModels.has(option.value))
    if (firstSupportedModel) {
      setModel(firstSupportedModel.value)
      openConfirmation(firstSupportedModel.value)
    }
  }

  const handleModelChange = (nextModel: string) => {
    const typed = nextModel
    setModel(typed)
    setDialogError(null)
    openConfirmation(typed)
  }

  const revertDraft = () => {
    setProvider(embeddingProviderForModel(currentModel))
    setModel(currentModel)
  }

  const handleConfirmModelChange = async () => {
    if (!requestedModel) return
    setBusy(true)
    setDialogError(null)
    emitSaveState({ state: 'saving' })
    try {
      const updated = await settingsApi.updateIngestionSettings({
        ...settings,
        embeddingModel: requestedModel,
      })
      onChange(updated)
      emitSaveState({ state: 'saved' })
      setRequestedModel(null)
    } catch (err) {
      emitSaveState({ state: 'error', message: getApiErrorMessage(err, 'Failed to update the embedding model.') })
      setDialogError(
        getApiErrorMessage(
          err,
          'Failed to complete the embedding model change and start re-indexing. Check the current setting before trying again.',
        ),
      )
      revertDraft()
    } finally {
      setBusy(false)
    }
  }

  const handleCancelPendingModel = async () => {
    setCanceling(true)
    emitSaveState({ state: 'saving' })
    try {
      const updated = await settingsApi.cancelPendingEmbeddingModel()
      onChange(updated)
      emitSaveState({ state: 'saved' })
    } catch (err) {
      await onReload().then(onChange).catch(() => undefined)
      const errorMessage = getApiErrorMessage(err, 'Failed to cancel pending embedding model change.')
      emitSaveState({ state: 'error', message: errorMessage })
    } finally {
      setCanceling(false)
    }
  }

  return (
    <>
      <div
        className={`${modelRowClassName} px-4 py-4`}
        data-testid="llm-model-row-embeddings"
      >
        <div className="flex min-w-0 items-start gap-3">
          <div
            aria-hidden="true"
            className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg border border-primary/15 bg-primary/10 text-primary"
          >
            <Search className="h-4 w-4" />
          </div>
          <div className="min-w-0 space-y-1">
            <div className="flex flex-wrap items-center gap-1.5">
              <p className="text-sm font-medium text-foreground">Embeddings</p>
              <Badge
                variant={isPending ? 'default' : 'outline'}
                className={
                  isPending
                    ? 'bg-amber-500/10 text-amber-700 ring-1 ring-inset ring-amber-500/30 dark:text-amber-300'
                    : 'text-muted-foreground'
                }
              >
                {isPending ? 'Re-indexing' : 'Workspace embedding model'}
              </Badge>
            </div>
            <p className="text-xs leading-relaxed text-muted-foreground">
              {capabilityVisual.embeddings.description}
            </p>
            {isPending ? (
              <>
                <p
                  className="text-xs leading-relaxed text-muted-foreground"
                  data-testid="embedding-model-transition-summary"
                >
                  Active: {activeModelOption?.label ?? settings.embeddingModel}. Pending: {pendingModelOption?.label ?? settings.pendingEmbeddingModel}.
                </p>
                <p
                  className="flex items-center gap-1.5 text-xs leading-relaxed text-muted-foreground"
                  data-testid="embedding-model-reindex-activity"
                  aria-live="polite"
                >
                  <Spinner className="size-3 shrink-0" aria-hidden="true" />
                  Re-indexing queue active. This can take a while; you can keep working while search uses the active model.
                </p>
              </>
            ) : null}
            {coverageSummary && coverageSummary.status !== 'empty' ? (
              <p
                className={`text-xs leading-relaxed ${
                  coverageSummary.status === 'complete'
                    ? 'text-muted-foreground'
                    : 'text-amber-700 dark:text-amber-300'
                }`}
                data-testid="embedding-coverage-summary"
                aria-live="polite"
              >
                {embeddingCoverageDetail(coverageSummary)}
              </p>
            ) : null}
          </div>
        </div>
        <div className="min-w-0 space-y-1">
          <Label htmlFor="provider-embeddings" className="text-xs uppercase tracking-wide text-muted-foreground">
            Provider
          </Label>
          <Select value={provider} onValueChange={handleProviderChange} disabled={busy || canceling || isPending}>
            <SelectTrigger id="provider-embeddings" className="w-full min-w-0">
              <SelectValue placeholder="Choose provider" />
            </SelectTrigger>
            <SelectContent>
              {providerOptions.map((option) => (
                <SelectItem key={option.provider} value={option.provider} disabled={!option.supported}>
                  {embeddingProviderDisplayName[option.provider]}
                  {!option.supported ? ' (not configured)' : ''}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <div className="min-w-0 space-y-1">
          <Label htmlFor="model-embeddings" className="text-xs uppercase tracking-wide text-muted-foreground">
            Model
          </Label>
          <Select value={model} onValueChange={handleModelChange} disabled={busy || canceling || isPending}>
            <SelectTrigger id="model-embeddings" className="w-full min-w-0">
              <SelectValue placeholder="Choose model" />
            </SelectTrigger>
            <SelectContent>
              {modelOptions.map((option) => (
                <SelectItem
                  key={option.value}
                  value={option.value}
                  disabled={!supportedEmbeddingModels.has(option.value)}
                >
                  {option.label}
                  {!supportedEmbeddingModels.has(option.value) ? ' (not configured)' : ''}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <div className="flex items-end gap-2 sm:justify-end sm:pl-2">
          {isPending ? (
            <Button
              type="button"
              size="sm"
              variant="ghost"
              onClick={handleCancelPendingModel}
              disabled={busy}
              loading={canceling}
            >
              Cancel
            </Button>
          ) : (
            <Button
              type="button"
              size="sm"
              variant="ghost"
              className="invisible"
              tabIndex={-1}
              aria-hidden="true"
            >
              Cancel
            </Button>
          )}
        </div>
      </div>
      <AlertDialog
        open={requestedModel !== null}
        onOpenChange={(open) => {
          if (!open && !busy) {
            setRequestedModel(null)
            setDialogError(null)
            revertDraft()
          }
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Change embedding model?</AlertDialogTitle>
            <AlertDialogDescription>
              Changing from {selectedModelOption?.label ?? currentModel} to {requestedModelOption?.label ?? requestedModel} requires all existing
              documents to be re-indexed. Semantic search keeps using the active model until re-indexing completes.
            </AlertDialogDescription>
          </AlertDialogHeader>
          {dialogError ? <p className="text-sm text-destructive">{dialogError}</p> : null}
          <AlertDialogFooter>
            <AlertDialogCancel disabled={busy}>Cancel</AlertDialogCancel>
            <AlertDialogAction
              disabled={busy}
              onClick={(event) => {
                event.preventDefault()
                void handleConfirmModelChange()
              }}
            >
              {busy ? <Spinner className="mr-2" /> : <RefreshCw className="mr-2 h-4 w-4" />}
              <span>Change model and re-index</span>
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  )
}
